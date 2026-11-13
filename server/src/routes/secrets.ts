import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { BUILTIN_SECRET_RULES, scanSecrets, validateRule } from '../lib/secrets.js';
import {
  DEFAULT_SECRET_SETTINGS, getSecretSettings, setSecretSettings, toScanConfig, toStored, type SecretSettings,
} from '../lib/secretConfig.js';
import { indexAttachment } from '../lib/search.js';
import type { StoredFinding } from '../db/schema.js';

async function rulesResponse(s: SecretSettings) {
  return {
    builtin: BUILTIN_SECRET_RULES,
    settings: s,
    defaults: DEFAULT_SECRET_SETTINGS,
    /** What the editor scans with. */
    config: toScanConfig(s),
  };
}

/** Re-scans every revision and text attachment with the current rules. */
export async function rescanAll(): Promise<{ revisions: number; flagged: number; attachments: number }> {
  const config = toScanConfig(await getSecretSettings());
  let lastId = 0;
  let revisionCount = 0;
  let flagged = 0;
  for (;;) {
    const batch = await db.execute<{ id: number; body: string }>(
      sql`select id, body from revisions where id > ${lastId} order by id limit 200`,
    );
    if (!batch.rows.length) break;
    for (const r of batch.rows) {
      const findings = toStored(scanSecrets(r.body, config));
      if (findings.length) flagged++;
      await db.execute(sql`update revisions set secret_findings = ${JSON.stringify(findings)}::jsonb where id = ${r.id}`);
      lastId = r.id;
    }
    revisionCount += batch.rows.length;
  }
  const atts = await db.execute<{ id: number }>(sql`select id from attachments where search_blob is not null or not text_extracted`);
  for (const a of atts.rows) await indexAttachment(a.id);
  return { revisions: revisionCount, flagged, attachments: atts.rows.length };
}

export async function secretRoutes(app: FastifyInstance) {
  // Everyone can read the rules: the editor scans live with the same rules the server uses.
  app.get('/secret-rules', async (req) => {
    requireUser(req);
    return rulesResponse(await getSecretSettings());
  });

  app.put('/secret-rules', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(z.object({
      disabledRules: z.array(z.string().max(64)).max(200),
      customRules: z.array(z.object({
        id: z.string().regex(/^custom-[a-z0-9-]{1,40}$/, 'Custom rule ids look like custom-name'),
        name: z.string().trim().min(1).max(100),
        pattern: z.string().min(1).max(1000),
        flags: z.string().regex(/^[imsu]*$/, 'Flags can be i, m, s and u').max(4).optional(),
      })).max(100),
      allowlist: z.array(z.string().trim().min(1).max(200)).max(500),
    }), req.body);
    const ids = new Set<string>();
    for (const r of body.customRules) {
      if (ids.has(r.id) || BUILTIN_SECRET_RULES.some((b) => b.id === r.id)) throw badRequest(`Duplicate rule id ${r.id}`);
      ids.add(r.id);
      const problem = validateRule(r);
      if (problem) throw badRequest(`Rule "${r.name}": ${problem}`);
    }
    await setSecretSettings(body);
    req.log.info({ event: 'settings_changed', by: admin.id, setting: 'secretScan', changes: body }, 'secret rules changed');
    return rulesResponse(body);
  });

  /** "Possible secrets" report (spec §8): flagged current pages, older revisions and attachments. */
  app.get('/admin/secrets', async (req) => {
    requireAdmin(req);
    const revs = await db.execute<{
      revision_id: number; page_id: number; title: string; slug: string; space_key: string; space_name: string;
      created_at: Date; author: string; findings: StoredFinding[]; acknowledged: boolean; is_current: boolean;
      page_deleted: boolean;
    }>(sql`
      select r.id as revision_id, p.id as page_id, p.title, p.slug, s.key as space_key, s.name as space_name,
        r.created_at, u.display_name as author, r.secret_findings as findings, r.secrets_acknowledged as acknowledged,
        (p.current_revision_id = r.id) as is_current, (p.deleted_at is not null) as page_deleted
      from revisions r
      join pages p on p.id = r.page_id
      join spaces s on s.id = p.space_id
      join users u on u.id = r.author_id
      where jsonb_array_length(coalesce(r.secret_findings, '[]'::jsonb)) > 0
      order by (p.current_revision_id = r.id) desc, r.created_at desc
      limit 1000`);
    const atts = await db.execute<{
      id: number; filename: string; page_id: number; title: string; slug: string; space_key: string;
      created_at: Date; uploader: string; findings: StoredFinding[]; removed: boolean; page_deleted: boolean;
    }>(sql`
      select a.id, a.filename, p.id as page_id, p.title, p.slug, s.key as space_key, a.created_at,
        u.display_name as uploader, a.secret_findings as findings, (a.removed_at is not null) as removed,
        (p.deleted_at is not null) as page_deleted
      from attachments a
      join pages p on p.id = a.page_id
      join spaces s on s.id = p.space_id
      join users u on u.id = a.uploaded_by
      where jsonb_array_length(coalesce(a.secret_findings, '[]'::jsonb)) > 0
      order by a.created_at desc
      limit 1000`);
    return {
      revisions: revs.rows.map((r) => ({
        revisionId: r.revision_id, pageId: r.page_id, title: r.title, slug: r.slug, spaceKey: r.space_key,
        spaceName: r.space_name, createdAt: r.created_at, author: r.author, findings: r.findings,
        acknowledged: r.acknowledged, isCurrent: r.is_current, pageDeleted: r.page_deleted,
      })),
      attachments: atts.rows.map((a) => ({
        id: a.id, filename: a.filename, pageId: a.page_id, title: a.title, slug: a.slug, spaceKey: a.space_key,
        createdAt: a.created_at, uploader: a.uploader, findings: a.findings, removed: a.removed, pageDeleted: a.page_deleted,
      })),
    };
  });

  app.post('/admin/secrets/rescan', async (req) => {
    const admin = requireAdmin(req);
    const r = await rescanAll();
    req.log.info({ event: 'secrets_rescanned', by: admin.id, ...r }, 'secret rescan done');
    return r;
  });
}
