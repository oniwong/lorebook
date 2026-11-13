// Search (spec §9): Postgres full-text search for prose plus pg_trgm substring matching for technical strings
// (hostnames, IPs, paths, error codes) that word-based matching breaks. Everything lives in Postgres, so
// there is no separate search service.
//
// Each page stores three derived columns, rebuilt by indexPage() whenever its title, body or tags change:
//   search_tsv   weighted tsvector: title (A), headings and tags (B), prose (C), code (D)
//   search_blob  lower(unaccent(title, headings, tags, body)) for trigram substring matching
//   search_code  lower(unaccent(code blocks)) for the "only in code blocks" option
// Text attachments get search_blob and search_tsv too.
import { open } from 'node:fs/promises';
import { sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db, type Tx } from '../db/index.js';
import { blobPath, isTextFile } from './attachments.js';
import { splitMarkdown, plainText } from './mdtext.js';
import { getAppSettings } from './settings.js';
import { getScanConfig, scanFile, toStored } from './secretConfig.js';

/** Bump to rebuild every page's search columns in the background after an indexing change. */
export const SEARCH_VERSION = 1;
/** Text attachments under this size are indexed (spec §7). */
export const ATTACHMENT_INDEX_MAX = 5 * 1024 * 1024;
// tsvector values are limited to 1 MB; cap each part well below that.
const TSV_INPUT_MAX = 400_000;

type Runner = Tx | typeof db;

let cachedConfig: { name: string; at: number } | null = null;

/** The configured text-search configuration, checked against what Postgres actually has. */
export async function searchConfig(runner: Runner = db): Promise<string> {
  if (cachedConfig && Date.now() - cachedConfig.at < 30_000) return cachedConfig.name;
  const { searchLanguage } = await getAppSettings();
  const ok = await runner.execute<{ n: number }>(sql`select count(*)::int as n from pg_ts_config where cfgname = ${searchLanguage}`);
  const name = ok.rows[0]?.n ? searchLanguage : 'simple';
  cachedConfig = { name, at: Date.now() };
  return name;
}

export function clearSearchConfigCache(): void {
  cachedConfig = null;
}

export async function availableSearchLanguages(): Promise<string[]> {
  const r = await db.execute<{ cfgname: string }>(sql`select cfgname from pg_ts_config order by cfgname`);
  return r.rows.map((x) => x.cfgname);
}

/** Rebuilds a page's search columns. Call inside the transaction that changed the page. */
export async function indexPage(runner: Runner, pageId: number): Promise<void> {
  const r = await runner.execute<{ title: string; body: string; tags: string[] }>(
    sql`select title, body, tags from pages where id = ${pageId}`,
  );
  const p = r.rows[0];
  if (!p) return;
  const cfg = await searchConfig(runner);
  const parts = splitMarkdown(p.body);
  const headings = parts.headings.join('\n');
  const tags = (p.tags ?? []).join(' ');
  await runner.execute(sql`
    update pages set
      search_blob = lower(unaccent(${`${p.title}\n${headings}\n${tags}\n${p.body}`})),
      search_code = lower(unaccent(${parts.code})),
      search_tsv =
        setweight(to_tsvector(${cfg}::regconfig, unaccent(${p.title})), 'A') ||
        setweight(to_tsvector(${cfg}::regconfig, unaccent(${`${headings}\n${tags}`.slice(0, TSV_INPUT_MAX)})), 'B') ||
        setweight(to_tsvector(${cfg}::regconfig, unaccent(${parts.prose.slice(0, TSV_INPUT_MAX)})), 'C') ||
        setweight(to_tsvector(${cfg}::regconfig, unaccent(${parts.code.slice(0, TSV_INPUT_MAX)})), 'D'),
      search_version = ${SEARCH_VERSION}
    where id = ${pageId}`);
}

async function readTextFile(sha256: string, size: number): Promise<string | null> {
  if (size > ATTACHMENT_INDEX_MAX) return null;
  const fh = await open(blobPath(sha256), 'r').catch(() => null);
  if (!fh) return null;
  try {
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    // A NUL byte means it is not really text (e.g. a UTF-16 export); skip it rather than index garbage.
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Extracts and indexes an attachment's text (text files under 5 MB) and scans it for secrets.
 * Returns the secret findings so the upload response can warn about them.
 */
export async function indexAttachment(id: number) {
  const r = await db.execute<{ filename: string; sha256: string; size: number }>(
    sql`select filename, sha256, size from attachments where id = ${id}`,
  );
  const a = r.rows[0];
  if (!a) return [];
  const text = isTextFile(a.filename) ? await readTextFile(a.sha256, Number(a.size)) : null;
  if (text === null) {
    await db.execute(sql`update attachments set text_extracted = true where id = ${id}`);
    return [];
  }
  const findings = scanFile(text, await getScanConfig());
  const cfg = await searchConfig();
  await db.execute(sql`
    update attachments set
      text_extracted = true,
      search_blob = lower(unaccent(${text})),
      search_tsv = to_tsvector(${cfg}::regconfig, lower(unaccent(${text.slice(0, TSV_INPUT_MAX)}))),
      secret_findings = ${JSON.stringify(toStored(findings))}::jsonb
    where id = ${id}`);
  return findings;
}

/**
 * Indexes whatever is not indexed yet: pages from before this version (or after a language change) and
 * attachments uploaded before milestone 3. Runs in small batches from the housekeeping timer.
 */
export async function reindexPending(log?: Pick<FastifyBaseLogger, 'info'>, maxBatches = 20): Promise<{ pages: number; attachments: number }> {
  let pages = 0;
  let attachments = 0;
  for (let b = 0; b < maxBatches; b++) {
    const ids = await db.execute<{ id: number }>(
      sql`select id from pages where search_version < ${SEARCH_VERSION} order by id limit 100`,
    );
    if (!ids.rows.length) break;
    for (const { id } of ids.rows) await indexPage(db, id);
    pages += ids.rows.length;
  }
  for (let b = 0; b < maxBatches; b++) {
    const ids = await db.execute<{ id: number }>(sql`select id from attachments where not text_extracted order by id limit 50`);
    if (!ids.rows.length) break;
    for (const { id } of ids.rows) await indexAttachment(id);
    attachments += ids.rows.length;
  }
  if (pages || attachments) log?.info({ event: 'search_reindexed', pages, attachments }, 'search index updated');
  return { pages, attachments };
}

/** After the search language changes: mark every page for re-indexing and rebuild attachment vectors. */
export async function invalidateSearchIndex(): Promise<void> {
  clearSearchConfigCache();
  const cfg = await searchConfig();
  await db.execute(sql`update pages set search_version = 0`);
  await db.execute(sql`
    update attachments set search_tsv = to_tsvector(${cfg}::regconfig, left(search_blob, ${TSV_INPUT_MAX}))
    where search_blob is not null`);
}

// ---------------------------------------------------------------------------------------------------------
// Query parsing

export type ParsedQuery = {
  /** Alternatives separated by OR; each is a list of terms that must all match. */
  groups: string[][];
  exclude: string[];
  /** All positive terms, for snippets and title boosts. */
  terms: string[];
};

/** Same syntax as websearch_to_tsquery: words, "exact phrases", -exclude and OR. */
export function parseQuery(q: string): ParsedQuery {
  const groups: string[][] = [[]];
  const exclude: string[] = [];
  const re = /(-?)"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    if (m[3] !== undefined) {
      const word = m[3];
      if (word === 'OR') {
        if (groups[groups.length - 1].length) groups.push([]);
        continue;
      }
      if (word.startsWith('-') && word.length > 1) {
        exclude.push(word.slice(1));
        continue;
      }
      if (word !== '-') groups[groups.length - 1].push(word);
    } else {
      const phrase = m[2].trim().replace(/\s+/g, ' ');
      if (!phrase) continue;
      if (m[1]) exclude.push(phrase);
      else groups[groups.length - 1].push(phrase);
    }
  }
  const clean = groups.filter((g) => g.length);
  return { groups: clean, exclude, terms: [...new Set(clean.flat())] };
}

function likePattern(term: string): SQL {
  const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return sql`'%' || lower(unaccent(${escaped})) || '%'`;
}

/** Trigram substring matching only kicks in for terms of 3+ characters; shorter ones rely on full-text. */
const SUBSTRING_MIN = 3;

function substringMatch(column: SQL, groups: string[][]): SQL {
  const alts = groups
    .filter((g) => g.every((t) => t.length >= SUBSTRING_MIN))
    .map((g) => sql`(${sql.join(g.map((t) => sql`${column} like ${likePattern(t)}`), sql` and `)})`);
  return alts.length ? sql`(${sql.join(alts, sql` or `)})` : sql`false`;
}

// ---------------------------------------------------------------------------------------------------------
// Search

export type ReviewFilter = 'overdue' | 'due' | 'current' | 'none';

export type SearchParams = {
  q: string;
  spaces?: string[];
  tags?: string[];
  owner?: number;
  author?: number;
  template?: string;
  updatedFrom?: string;
  updatedTo?: string;
  review?: ReviewFilter;
  hasAttachments?: boolean;
  codeOnly?: boolean;
  sort?: 'relevance' | 'updated';
  limit?: number;
  offset?: number;
};

/** Days before the review date when a page counts as "due soon". */
export const REVIEW_DUE_DAYS = 14;

export function reviewCondition(r: ReviewFilter): SQL {
  switch (r) {
    case 'overdue': return sql`p.review_by < current_date`;
    case 'due': return sql`p.review_by >= current_date and p.review_by <= current_date + ${REVIEW_DUE_DAYS}::int`;
    case 'current': return sql`(p.review_by is null or p.review_by >= current_date)`;
    case 'none': return sql`p.review_by is null`;
  }
}

export type Snippet = { text: string; highlights: [number, number][] };

export type SearchHit = {
  id: number;
  title: string;
  slug: string;
  spaceKey: string;
  spaceName: string;
  path: string[];
  owner: { id: number; displayName: string; active: boolean };
  updatedAt: string;
  template: string;
  tags: string[];
  reviewBy: string | null;
  titleHighlights: [number, number][];
  snippet: Snippet | null;
  /** Attachments whose text matched, with a snippet from the first. */
  attachments: { filename: string; snippet: Snippet | null }[];
};

export async function search(params: SearchParams): Promise<{ total: number; hits: SearchHit[]; tookMs: number }> {
  const started = Date.now();
  const limit = Math.min(params.limit ?? 20, 100);
  const offset = params.offset ?? 0;
  const cfg = await searchConfig();
  const parsed = parseQuery(params.q);
  const hasQuery = parsed.groups.length > 0;
  const target = params.codeOnly ? sql`p.search_code` : sql`p.search_blob`;
  const tsq = sql`websearch_to_tsquery(${cfg}::regconfig, unaccent(${params.q}))`;
  const tsv = params.codeOnly ? sql`ts_filter(p.search_tsv, '{d}')` : sql`p.search_tsv`;

  const where: SQL[] = [sql`p.deleted_at is null`];
  let attachMatch: SQL = sql`false`;
  // Candidate pages come from a union of index-friendly branches (full-text GIN, trigram GIN, attachments),
  // which is much faster than one big OR that forces a scan of every page.
  let candidates: SQL = sql``;
  if (hasQuery) {
    const branches: SQL[] = [
      params.codeOnly
        ? sql`select p.id from pages p where p.search_tsv @@ ${tsq} and ${tsv} @@ ${tsq}`
        : sql`select p.id from pages p where p.search_tsv @@ ${tsq}`,
      sql`select p.id from pages p where ${substringMatch(target, parsed.groups)}`,
    ];
    if (!params.codeOnly) {
      attachMatch = sql`(a.search_tsv @@ ${tsq} or ${substringMatch(sql`a.search_blob`, parsed.groups)})`;
      branches.push(sql`select a.page_id from attachments a where a.removed_at is null and ${attachMatch}`);
    }
    candidates = sql`with candidates as (${sql.join(branches, sql` union `)})`;
    where.push(sql`p.id in (select id from candidates)`);
  }
  for (const t of parsed.exclude) where.push(sql`coalesce(${target}, '') not like ${likePattern(t)}`);
  if (params.spaces?.length) where.push(sql`s.key in (${sql.join(params.spaces.map((k) => sql`${k}`), sql`, `)})`);
  if (params.tags?.length) where.push(sql`p.tags @> array[${sql.join(params.tags.map((t) => sql`${t}`), sql`, `)}]::text[]`);
  if (params.owner) where.push(sql`p.owner_id = ${params.owner}`);
  if (params.author) where.push(sql`exists (select 1 from revisions r where r.page_id = p.id and r.author_id = ${params.author})`);
  if (params.template) where.push(sql`p.template = ${params.template}`);
  if (params.updatedFrom) where.push(sql`p.updated_at >= ${params.updatedFrom}::date`);
  if (params.updatedTo) where.push(sql`p.updated_at < ${params.updatedTo}::date + 1`);
  if (params.review) where.push(reviewCondition(params.review));
  if (params.hasAttachments) where.push(sql`exists (select 1 from attachments a where a.page_id = p.id and a.removed_at is null)`);

  const titleHits = parsed.terms.length
    ? sql.join(parsed.terms.map((t) => sql`(lower(unaccent(p.title)) like ${likePattern(t)})::int`), sql` + `)
    : sql`0`;
  const rank = hasQuery
    ? sql`ts_rank_cd(${tsv}, ${tsq}) + 0.5 * (${titleHits})`
    : sql`0`;
  const order = params.sort === 'updated' || !hasQuery ? sql`p.updated_at desc` : sql`rank desc, p.updated_at desc`;

  const rows = await db.execute<{
    id: number; title: string; slug: string; space_key: string; space_name: string; owner_id: number;
    owner_name: string; owner_active: boolean; updated_at: Date; template: string; tags: string[];
    review_by: string | null; body: string; search_code: string | null; matched_attachments: { filename: string; blob: string }[] | null;
    total: number;
  }>(sql`
    ${candidates}
    select p.id, p.title, p.slug, s.key as space_key, s.name as space_name, p.owner_id, u.display_name as owner_name,
      u.active as owner_active, p.updated_at, p.template, p.tags, to_char(p.review_by, 'YYYY-MM-DD') as review_by,
      p.body, p.search_code,
      ${hasQuery && !params.codeOnly ? sql`(
        select json_agg(json_build_object('filename', a.filename, 'blob', left(a.search_blob, 200000)) order by a.filename)
        from attachments a where a.page_id = p.id and a.removed_at is null and ${attachMatch})` : sql`null`} as matched_attachments,
      ${rank} as rank,
      count(*) over ()::int as total
    from pages p
    join spaces s on s.id = p.space_id
    join users u on u.id = p.owner_id
    where ${sql.join(where, sql` and `)}
    order by ${order}
    limit ${limit} offset ${offset}`);

  const ids = rows.rows.map((r) => r.id);
  const paths = new Map<number, string[]>();
  if (ids.length) {
    const up = await db.execute<{ start: number; title: string; depth: number }>(sql`
      with recursive up as (
        select p.id as start, p.parent_id as id, 0 as depth from pages p
        where p.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        union all
        select up.start, pg.parent_id, up.depth + 1 from up join pages pg on pg.id = up.id where up.depth < 50
      )
      select up.start, pg.title, up.depth from up join pages pg on pg.id = up.id order by up.start, up.depth desc`);
    for (const r of up.rows) {
      const list = paths.get(r.start) ?? [];
      list.push(r.title);
      paths.set(r.start, list);
    }
  }

  const terms = [...parsed.terms];
  const hits: SearchHit[] = rows.rows.map((r) => {
    const source = params.codeOnly ? (r.search_code ?? '') : plainText(r.body);
    return {
      id: r.id, title: r.title, slug: r.slug, spaceKey: r.space_key, spaceName: r.space_name,
      path: paths.get(r.id) ?? [],
      owner: { id: r.owner_id, displayName: r.owner_name, active: r.owner_active },
      updatedAt: new Date(r.updated_at).toISOString(), template: r.template, tags: r.tags ?? [], reviewBy: r.review_by,
      titleHighlights: highlightAll(r.title, terms),
      snippet: makeSnippet(source, terms),
      attachments: (r.matched_attachments ?? []).map((a, i) => ({
        filename: a.filename, snippet: i === 0 ? makeSnippet(a.blob, terms, { requireHit: true }) : null,
      })),
    };
  });
  return { total: rows.rows[0]?.total ?? 0, hits, tookMs: Date.now() - started };
}

// ---------------------------------------------------------------------------------------------------------
// Snippets

/** Lowercases and strips accents without changing string length, so offsets map back to the original. */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    out += f.length === ch.length ? f : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
  }
  return out;
}

/**
 * What to look for when highlighting: the terms themselves, and as a fallback a stem-ish prefix of long
 * words, since a stemmed match ("restarting" for "restarts") has no exact substring.
 */
function needles(text: string, terms: string[]): string[] {
  const full = new Set<string>();
  const stems = new Set<string>();
  for (const t of terms) {
    const f = fold(t.trim());
    if (!f) continue;
    full.add(f);
    if (/^\p{L}{6,}$/u.test(f)) stems.add(f.slice(0, Math.max(4, f.length - 3)));
  }
  const found = [...full].filter((n) => text.includes(n));
  const list = found.length ? found : [...stems].filter((n) => text.includes(n));
  return list.sort((a, b) => b.length - a.length);
}

export function highlightAll(text: string, terms: string[]): [number, number][] {
  const folded = fold(text);
  const ranges: [number, number][] = [];
  for (const n of needles(folded, terms)) {
    let i = folded.indexOf(n);
    while (i >= 0 && ranges.length < 50) {
      if (!ranges.some(([a, b]) => i < b && i + n.length > a)) ranges.push([i, i + n.length]);
      i = folded.indexOf(n, i + n.length);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

const SNIPPET_LEN = 220;

export function makeSnippet(text: string, terms: string[], opts: { requireHit?: boolean } = {}): Snippet | null {
  if (!text.trim()) return null;
  const folded = fold(text);
  let first = -1;
  for (const n of needles(folded, terms)) {
    const i = folded.indexOf(n);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  if (first < 0 && opts.requireHit) return null;
  let start = first < 0 ? 0 : Math.max(0, first - 70);
  if (start > 0) {
    const ws = text.lastIndexOf(' ', start);
    start = ws > start - 20 && ws >= 0 ? ws + 1 : start;
  }
  let end = Math.min(text.length, start + SNIPPET_LEN);
  if (end < text.length) {
    const ws = text.indexOf(' ', end);
    end = ws >= 0 && ws < end + 20 ? ws : end;
  }
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  const out = (start > 0 ? '… ' : '') + body + (end < text.length ? ' …' : '');
  return { text: out, highlights: highlightAll(out, terms) };
}
