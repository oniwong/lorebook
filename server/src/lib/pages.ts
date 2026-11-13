import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Tx } from '../db/index.js';
import { drafts, pages, revisions, spaces, users } from '../db/schema.js';
import { config } from '../config.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { slugify } from './slug.js';
import type { SessionUser } from './auth.js';

type PageRow = typeof pages.$inferSelect;

export const TITLE_MAX = 200;

function timeoutMs(): number {
  return config.checkoutTimeoutMinutes * 60_000;
}

/** A check-out is live while its heartbeat is newer than the timeout. */
export function checkoutIsLive(p: Pick<PageRow, 'checkedOutBy' | 'checkoutHeartbeatAt'>, now = Date.now()): boolean {
  return p.checkedOutBy !== null && p.checkoutHeartbeatAt !== null && now - p.checkoutHeartbeatAt.getTime() < timeoutMs();
}

/**
 * Releases check-outs whose heartbeat is older than the timeout. The holder's draft is kept
 * (marked expired) so it shows up in their "My drafts".
 */
export async function expireCheckouts(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    with expired as (
      select id, checked_out_by from pages
      where checked_out_by is not null
        and checkout_heartbeat_at < now() - make_interval(mins => ${config.checkoutTimeoutMinutes})
      for update
    ),
    marked as (
      update drafts set status = 'expired' from expired
      where drafts.page_id = expired.id and drafts.user_id = expired.checked_out_by
    ),
    released as (
      update pages set checked_out_by = null, checked_out_at = null, checkout_heartbeat_at = null
      from expired where pages.id = expired.id
      returning pages.id
    )
    select count(*)::int as n from released`);
  return res.rows[0]?.n ?? 0;
}

async function lockPage(tx: Tx, pageId: number): Promise<PageRow> {
  const [p] = await tx.select().from(pages).where(eq(pages.id, pageId)).for('update');
  if (!p || p.deletedAt) throw notFound('Page not found');
  return p;
}

async function holderName(tx: Tx, userId: number): Promise<string> {
  const [u] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
  return u?.displayName ?? 'someone';
}

async function checkedOutConflict(tx: Tx, p: PageRow) {
  const name = await holderName(tx, p.checkedOutBy!);
  return conflict(`Checked out by ${name}`, {
    code: 'checked_out',
    checkout: { userId: p.checkedOutBy, displayName: name, since: p.checkedOutAt },
  });
}

/**
 * Makes sure `user` holds the check-out on `p`, taking it if it is free or expired.
 * Throws 409 if someone else holds a live check-out.
 */
async function ensureHeldBy(tx: Tx, p: PageRow, user: SessionUser): Promise<PageRow> {
  const live = checkoutIsLive(p);
  if (live && p.checkedOutBy !== user.id) throw await checkedOutConflict(tx, p);
  const now = new Date();
  const fresh = !live || p.checkedOutBy !== user.id;
  if (fresh && p.checkedOutBy !== null && p.checkedOutBy !== user.id) {
    // Took over an expired check-out: keep the previous holder's draft for them.
    await tx.update(drafts).set({ status: 'expired' })
      .where(and(eq(drafts.pageId, p.id), eq(drafts.userId, p.checkedOutBy)));
  }
  const [updated] = await tx.update(pages).set({
    checkedOutBy: user.id,
    checkedOutAt: fresh ? now : p.checkedOutAt,
    checkoutHeartbeatAt: now,
  }).where(eq(pages.id, p.id)).returning();
  return updated;
}

/**
 * Autosave, heartbeat and check-in may silently re-take a check-out that merely expired, but not one
 * an admin broke: the user has to click Edit again for that.
 */
async function assertNotBroken(tx: Tx, p: PageRow, user: SessionUser): Promise<void> {
  if (p.checkedOutBy === user.id) return;
  const [d] = await tx.select({ status: drafts.status }).from(drafts)
    .where(and(eq(drafts.pageId, p.id), eq(drafts.userId, user.id)));
  if (d?.status === 'broken') {
    throw conflict('An admin broke your check-out. Your draft is kept in My drafts.', { code: 'checkout_lost' });
  }
}

export type DraftDto = {
  pageId: number;
  title: string;
  body: string;
  baseRevisionId: number;
  updatedAt: Date;
  status: string;
  /** True when the page has new revisions since this draft was started. */
  stale: boolean;
};

function draftDto(d: typeof drafts.$inferSelect, currentRevisionId: number | null): DraftDto {
  return {
    pageId: d.pageId, title: d.title, body: d.body, baseRevisionId: d.baseRevisionId,
    updatedAt: d.updatedAt, status: d.status, stale: d.baseRevisionId !== currentRevisionId,
  };
}

export async function checkout(pageId: number, user: SessionUser, opts: { fresh?: boolean } = {}): Promise<DraftDto> {
  return db.transaction(async (tx) => {
    let p = await lockPage(tx, pageId);
    p = await ensureHeldBy(tx, p, user);
    const [existing] = await tx.select().from(drafts)
      .where(and(eq(drafts.pageId, pageId), eq(drafts.userId, user.id)));
    if (existing && !opts.fresh) {
      const [d] = await tx.update(drafts).set({ status: 'active' })
        .where(and(eq(drafts.pageId, pageId), eq(drafts.userId, user.id))).returning();
      return draftDto(d, p.currentRevisionId);
    }
    const values = {
      pageId, userId: user.id, title: p.title, body: p.body,
      baseRevisionId: p.currentRevisionId!, status: 'active' as const, updatedAt: new Date(),
    };
    const [d] = await tx.insert(drafts).values(values)
      .onConflictDoUpdate({ target: [drafts.pageId, drafts.userId], set: values }).returning();
    return draftDto(d, p.currentRevisionId);
  });
}

export async function heartbeat(pageId: number, user: SessionUser): Promise<void> {
  await db.transaction(async (tx) => {
    const p = await lockPage(tx, pageId);
    await assertNotBroken(tx, p, user);
    await ensureHeldBy(tx, p, user);
  });
}

export async function saveDraft(pageId: number, user: SessionUser, input: { title: string; body: string }): Promise<DraftDto> {
  return db.transaction(async (tx) => {
    let p = await lockPage(tx, pageId);
    await assertNotBroken(tx, p, user);
    p = await ensureHeldBy(tx, p, user);
    const [d] = await tx.update(drafts)
      .set({ title: input.title, body: input.body, status: 'active', updatedAt: new Date() })
      .where(and(eq(drafts.pageId, pageId), eq(drafts.userId, user.id))).returning();
    if (!d) {
      // Draft vanished (e.g. discarded in another tab): start one from the submitted content.
      const [created] = await tx.insert(drafts).values({
        pageId, userId: user.id, title: input.title, body: input.body, baseRevisionId: p.currentRevisionId!,
      }).returning();
      return draftDto(created, p.currentRevisionId);
    }
    return draftDto(d, p.currentRevisionId);
  });
}

function validateTitle(title: string): string {
  const t = title.trim();
  if (!t) throw badRequest('Title is required');
  if (t.length > TITLE_MAX) throw badRequest(`Title must be at most ${TITLE_MAX} characters`);
  return t;
}

export async function checkin(
  pageId: number,
  user: SessionUser,
  input: { title: string; body: string; message?: string; overwriteNewer?: boolean },
): Promise<{ revisionId: number | null }> {
  const title = validateTitle(input.title);
  return db.transaction(async (tx) => {
    let p = await lockPage(tx, pageId);
    await assertNotBroken(tx, p, user);
    p = await ensureHeldBy(tx, p, user);
    const [draft] = await tx.select({ baseRevisionId: drafts.baseRevisionId }).from(drafts)
      .where(and(eq(drafts.pageId, pageId), eq(drafts.userId, user.id)));
    if (draft && draft.baseRevisionId !== p.currentRevisionId && !input.overwriteNewer) {
      throw conflict('The page has changed since you started editing. Checking in will replace those changes.', {
        code: 'stale_draft', baseRevisionId: draft.baseRevisionId, currentRevisionId: p.currentRevisionId,
      });
    }
    let revisionId: number | null = null;
    const now = new Date();
    if (title !== p.title || input.body !== p.body) {
      const [rev] = await tx.insert(revisions).values({
        pageId, title, body: input.body, authorId: user.id, kind: 'checkin', message: input.message?.trim() ?? '',
      }).returning({ id: revisions.id });
      revisionId = rev.id;
      await tx.update(pages).set({
        title, slug: slugify(title), body: input.body, currentRevisionId: rev.id, updatedAt: now, updatedBy: user.id,
      }).where(eq(pages.id, pageId));
    }
    await tx.update(pages).set({ checkedOutBy: null, checkedOutAt: null, checkoutHeartbeatAt: null })
      .where(eq(pages.id, pageId));
    await tx.delete(drafts).where(and(eq(drafts.pageId, pageId), eq(drafts.userId, user.id)));
    return { revisionId };
  });
}

/** Throws the draft away and releases the check-out if the user holds it. */
export async function discard(pageId: number, user: SessionUser): Promise<void> {
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(pages).where(eq(pages.id, pageId)).for('update');
    if (!p) throw notFound('Page not found');
    if (p.checkedOutBy === user.id) {
      await tx.update(pages).set({ checkedOutBy: null, checkedOutAt: null, checkoutHeartbeatAt: null })
        .where(eq(pages.id, pageId));
    }
    await tx.delete(drafts).where(and(eq(drafts.pageId, pageId), eq(drafts.userId, user.id)));
  });
}

export async function breakCheckout(pageId: number, admin: SessionUser): Promise<{ previousHolder: number | null }> {
  if (admin.role !== 'admin') throw forbidden('Admins only');
  return db.transaction(async (tx) => {
    const p = await lockPage(tx, pageId);
    if (p.checkedOutBy === null) return { previousHolder: null };
    await tx.update(drafts).set({ status: 'broken' })
      .where(and(eq(drafts.pageId, pageId), eq(drafts.userId, p.checkedOutBy)));
    await tx.update(pages).set({ checkedOutBy: null, checkedOutAt: null, checkoutHeartbeatAt: null })
      .where(eq(pages.id, pageId));
    return { previousHolder: p.checkedOutBy };
  });
}

export async function restoreRevision(pageId: number, revisionId: number, user: SessionUser): Promise<{ revisionId: number }> {
  return db.transaction(async (tx) => {
    const p = await lockPage(tx, pageId);
    if (checkoutIsLive(p)) throw await checkedOutConflict(tx, p);
    const [rev] = await tx.select().from(revisions).where(and(eq(revisions.id, revisionId), eq(revisions.pageId, pageId)));
    if (!rev) throw notFound('Revision not found');
    if (rev.id === p.currentRevisionId) throw badRequest('That revision is already the current version');
    const [created] = await tx.insert(revisions).values({
      pageId, title: rev.title, body: rev.body, authorId: user.id, kind: 'restore',
      message: `Restored revision ${rev.id}`, restoredFrom: rev.id,
    }).returning({ id: revisions.id });
    await tx.update(pages).set({
      title: rev.title, slug: slugify(rev.title), body: rev.body, currentRevisionId: created.id,
      updatedAt: new Date(), updatedBy: user.id,
      checkedOutBy: null, checkedOutAt: null, checkoutHeartbeatAt: null,
    }).where(eq(pages.id, pageId));
    return { revisionId: created.id };
  });
}

export async function createPage(
  user: SessionUser,
  input: { spaceId: number; parentId: number | null; title: string; body?: string },
): Promise<{ id: number; slug: string }> {
  const title = validateTitle(input.title);
  return db.transaction(async (tx) => {
    const [space] = await tx.select().from(spaces).where(eq(spaces.id, input.spaceId));
    if (!space) throw notFound('Space not found');
    if (input.parentId !== null) {
      const [parent] = await tx.select().from(pages).where(eq(pages.id, input.parentId));
      if (!parent || parent.deletedAt) throw notFound('Parent page not found');
      if (parent.spaceId !== input.spaceId) throw badRequest('Parent page is in another Space');
    }
    // Serialise sibling inserts so positions stay unique.
    await tx.execute(sql`select pg_advisory_xact_lock(${input.spaceId})`);
    const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${pages.position}), -1) + 1` })
      .from(pages)
      .where(and(
        eq(pages.spaceId, input.spaceId),
        input.parentId === null ? isNull(pages.parentId) : eq(pages.parentId, input.parentId),
      ));
    const slug = slugify(title);
    const body = input.body ?? '';
    const [p] = await tx.insert(pages).values({
      spaceId: input.spaceId, parentId: input.parentId, position: Number(next), title, slug, body,
      ownerId: user.id, createdBy: user.id, updatedBy: user.id,
    }).returning({ id: pages.id });
    const [rev] = await tx.insert(revisions).values({
      pageId: p.id, title, body, authorId: user.id, kind: 'create', message: 'Created page',
    }).returning({ id: revisions.id });
    await tx.update(pages).set({ currentRevisionId: rev.id }).where(eq(pages.id, p.id));
    return { id: p.id, slug };
  });
}

export async function getPage(pageId: number, viewer: SessionUser) {
  const owner = alias(users, 'owner');
  const updater = alias(users, 'updater');
  const holder = alias(users, 'holder');
  const [row] = await db
    .select({
      page: pages,
      spaceKey: spaces.key,
      spaceName: spaces.name,
      ownerName: owner.displayName,
      ownerActive: owner.active,
      updatedByName: updater.displayName,
      holderName: holder.displayName,
    })
    .from(pages)
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .innerJoin(owner, eq(owner.id, pages.ownerId))
    .innerJoin(updater, eq(updater.id, pages.updatedBy))
    .leftJoin(holder, eq(holder.id, pages.checkedOutBy))
    .where(eq(pages.id, pageId));
  if (!row || row.page.deletedAt) throw notFound('Page not found');
  const p = row.page;
  const crumbs = await db.execute<{ id: number; title: string; slug: string }>(sql`
    with recursive up as (
      select id, parent_id, title, slug, 0 as depth from pages where id = ${p.parentId}
      union all
      select pg.id, pg.parent_id, pg.title, pg.slug, up.depth + 1 from pages pg join up on pg.id = up.parent_id
    )
    select id, title, slug from up order by depth desc`);
  const [myDraft] = await db.select({ updatedAt: drafts.updatedAt, status: drafts.status }).from(drafts)
    .where(and(eq(drafts.pageId, pageId), eq(drafts.userId, viewer.id)));
  const live = checkoutIsLive(p);
  return {
    id: p.id,
    spaceId: p.spaceId,
    spaceKey: row.spaceKey,
    spaceName: row.spaceName,
    parentId: p.parentId,
    title: p.title,
    slug: p.slug,
    body: p.body,
    template: p.template,
    currentRevisionId: p.currentRevisionId,
    owner: { id: p.ownerId, displayName: row.ownerName, active: row.ownerActive },
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    updatedBy: { id: p.updatedBy, displayName: row.updatedByName },
    checkout: live
      ? { userId: p.checkedOutBy!, displayName: row.holderName!, since: p.checkedOutAt!, mine: p.checkedOutBy === viewer.id }
      : null,
    myDraft: myDraft ?? null,
    breadcrumbs: crumbs.rows,
  };
}

export async function listRevisions(pageId: number) {
  return db
    .select({
      id: revisions.id, title: revisions.title, kind: revisions.kind, message: revisions.message,
      restoredFrom: revisions.restoredFrom, createdAt: revisions.createdAt,
      author: { id: users.id, displayName: users.displayName },
    })
    .from(revisions)
    .innerJoin(users, eq(users.id, revisions.authorId))
    .where(eq(revisions.pageId, pageId))
    .orderBy(desc(revisions.id));
}
