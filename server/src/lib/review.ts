// Page metadata that is not part of a revision: tags (spec §5) and review dates (spec §11).
import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pages, templates } from '../db/schema.js';
import { badRequest, forbidden } from './errors.js';
import { checkedOutConflict, checkoutIsLive, lockPage } from './pages.js';
import { getAppSettings } from './settings.js';
import { indexPage, REVIEW_DUE_DAYS, reviewCondition } from './search.js';
import type { SessionUser } from './auth.js';

export const TAG_MAX = 40;
export const TAGS_PER_PAGE = 20;

/** Lowercase, spaces to dashes, letters/digits/._- only. Returns null for something that isn't a usable tag. */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, TAG_MAX);
  return t.replace(/^[-.]+|[-.]+$/g, '') || null;
}

export function normalizeTags(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const t = normalizeTag(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  if (out.length > TAGS_PER_PAGE) throw badRequest(`A page can have at most ${TAGS_PER_PAGE} tags`);
  return out.sort();
}

/** Anyone may tag a page, except while someone else has it checked out. */
export async function setTags(pageId: number, user: SessionUser, tags: string[]): Promise<string[]> {
  const clean = normalizeTags(tags);
  await db.transaction(async (tx) => {
    const p = await lockPage(tx, pageId);
    if (checkoutIsLive(p) && p.checkedOutBy !== user.id) throw await checkedOutConflict(tx, p);
    await tx.update(pages).set({ tags: clean }).where(eq(pages.id, pageId));
    await indexPage(tx, pageId);
  });
  return clean;
}

export async function listTags(q = ''): Promise<{ tag: string; count: number }[]> {
  const like = `${q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const r = await db.execute<{ tag: string; count: number }>(sql`
    select t as tag, count(*)::int as count
    from pages, unnest(tags) as t
    where deleted_at is null and t like ${like}
    group by t order by count(*) desc, t limit 50`);
  return r.rows;
}

function assertOwnerOrAdmin(p: { ownerId: number }, user: SessionUser) {
  if (p.ownerId !== user.id && user.role !== 'admin') throw forbidden('Only the page owner or an admin can change its review date');
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(d: string): string {
  if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw badRequest('Use a date like 2027-03-01');
  return d;
}

/** Owner or admin sets or clears the review-by date. */
export async function setReviewDate(pageId: number, user: SessionUser, reviewBy: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const p = await lockPage(tx, pageId);
    assertOwnerOrAdmin(p, user);
    await tx.update(pages).set({ reviewBy: reviewBy === null ? null : checkDate(reviewBy) }).where(eq(pages.id, pageId));
  });
}

/** Months until the next review for a page: its template's interval, else the admin default. */
export async function reviewIntervalFor(templateKey: string): Promise<number> {
  const [t] = await db.select({ months: templates.reviewIntervalMonths }).from(templates).where(eq(templates.key, templateKey));
  return t?.months ?? (await getAppSettings()).defaultReviewMonths;
}

/** Template default for a new page, or null when the template sets no interval. */
export function initialReviewBy(intervalMonths: number | null): SQL | null {
  return intervalMonths ? sql`(current_date + make_interval(months => ${intervalMonths}))::date` : null;
}

/**
 * Records a review without a content edit (spec §11) and moves the review date forward: to `nextReviewBy`
 * when given, otherwise by the page's interval. A page with no review date keeps none.
 */
export async function markReviewed(pageId: number, user: SessionUser, nextReviewBy?: string | null): Promise<{ reviewBy: string | null }> {
  return db.transaction(async (tx) => {
    const p = await lockPage(tx, pageId);
    assertOwnerOrAdmin(p, user);
    let next: SQL | string | null;
    if (nextReviewBy !== undefined) next = nextReviewBy === null ? null : checkDate(nextReviewBy);
    else next = p.reviewBy === null ? null : initialReviewBy(await reviewIntervalFor(p.template));
    await tx.update(pages).set({ reviewBy: next, reviewedAt: new Date(), reviewedBy: user.id }).where(eq(pages.id, pageId));
    const [row] = await tx.select({ reviewBy: pages.reviewBy }).from(pages).where(eq(pages.id, pageId));
    return { reviewBy: row.reviewBy };
  });
}

export type ReviewStatus = 'none' | 'ok' | 'due' | 'overdue';

/** SQL for a page's review status. Uses the database's current_date so filters and badges agree. */
export function reviewStatusSql(col: SQL): SQL<ReviewStatus> {
  return sql<ReviewStatus>`case when ${col} is null then 'none' when ${col} < current_date then 'overdue'
    when ${col} <= current_date + ${REVIEW_DUE_DAYS}::int then 'due' else 'ok' end`;
}

export type StaleRow = {
  id: number; title: string; slug: string; spaceKey: string; spaceName: string; template: string;
  reviewBy: string; status: ReviewStatus; lastReviewedAt: string; reviewedByName: string | null; updatedAt: string;
  owner: { id: number; displayName: string; active: boolean };
};

/** The Stale pages list (spec §11): overdue pages, optionally also those due soon, by Space and owner. */
export async function listStale(opts: { spaceKey?: string; ownerId?: number; includeDue?: boolean; formerOwners?: boolean }): Promise<StaleRow[]> {
  const cond: SQL[] = [sql`p.deleted_at is null`];
  cond.push(opts.includeDue ? sql`(${reviewCondition('overdue')} or ${reviewCondition('due')})` : reviewCondition('overdue'));
  if (opts.spaceKey) cond.push(sql`s.key = ${opts.spaceKey}`);
  if (opts.ownerId) cond.push(sql`p.owner_id = ${opts.ownerId}`);
  if (opts.formerOwners) cond.push(sql`not u.active`);
  const r = await db.execute<{
    id: number; title: string; slug: string; space_key: string; space_name: string; template: string; review_by: string;
    status: ReviewStatus; last_reviewed_at: Date; reviewed_by_name: string | null; updated_at: Date;
    owner_id: number; owner_name: string; owner_active: boolean;
  }>(sql`
    select p.id, p.title, p.slug, s.key as space_key, s.name as space_name, p.template,
      to_char(p.review_by, 'YYYY-MM-DD') as review_by, ${reviewStatusSql(sql`p.review_by`)} as status,
      coalesce(p.reviewed_at, p.created_at) as last_reviewed_at, rv.display_name as reviewed_by_name, p.updated_at,
      u.id as owner_id, u.display_name as owner_name, u.active as owner_active
    from pages p
    join spaces s on s.id = p.space_id
    join users u on u.id = p.owner_id
    left join users rv on rv.id = p.reviewed_by
    where ${sql.join(cond, sql` and `)}
    order by p.review_by, p.title
    limit 500`);
  return r.rows.map((x) => ({
    id: x.id, title: x.title, slug: x.slug, spaceKey: x.space_key, spaceName: x.space_name, template: x.template,
    reviewBy: x.review_by, status: x.status, lastReviewedAt: new Date(x.last_reviewed_at).toISOString(),
    reviewedByName: x.reviewed_by_name, updatedAt: new Date(x.updated_at).toISOString(),
    owner: { id: x.owner_id, displayName: x.owner_name, active: x.owner_active },
  }));
}
