// Moving pages, and the trash (spec §10). Ids never change, so links survive moves and restores.
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Tx } from '../db/index.js';
import { pages, spaces, users } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { canEditDirectly, checkoutIsLive, lockPage } from './pages.js';
import { HttpError } from './errors.js';
import type { SessionUser } from './auth.js';

export const TRASH_RETENTION_DAYS = 30;

/** Serialises tree changes in a Space (same lock key createPage uses). Locks in id order to avoid deadlocks. */
async function lockSpaces(tx: Tx, ...spaceIds: number[]): Promise<void> {
  for (const id of [...new Set(spaceIds)].sort((a, b) => a - b)) {
    await tx.execute(sql`select pg_advisory_xact_lock(${id})`);
  }
}

/** The page and all its live descendants, row-locked. */
async function lockSubtree(tx: Tx, pageId: number) {
  const res = await tx.execute<{ id: number }>(sql`
    with recursive sub as (
      select id from pages where id = ${pageId} and deleted_at is null
      union all
      select p.id from pages p join sub on p.parent_id = sub.id where p.deleted_at is null
    )
    select id from sub`);
  const ids = res.rows.map((r) => Number(r.id));
  if (!ids.length) return [];
  return tx.select().from(pages).where(inArray(pages.id, ids)).orderBy(asc(pages.id)).for('update');
}

/** 409 if anyone other than `user` has a live check-out in the subtree. */
async function assertNoForeignCheckouts(tx: Tx, rows: (typeof pages.$inferSelect)[], user: SessionUser, verb: string) {
  const held = rows.filter((r) => checkoutIsLive(r) && r.checkedOutBy !== user.id);
  if (!held.length) return;
  const names = await tx.select({ id: users.id, displayName: users.displayName }).from(users)
    .where(inArray(users.id, held.map((r) => r.checkedOutBy!)));
  const nameOf = new Map(names.map((n) => [n.id, n.displayName]));
  const list = held.map((r) => `“${r.title}” (${nameOf.get(r.checkedOutBy!) ?? 'someone'})`).join(', ');
  throw conflict(`Can't ${verb} while pages are checked out: ${list}`, {
    code: 'checked_out',
    pages: held.map((r) => ({ id: r.id, title: r.title, displayName: nameOf.get(r.checkedOutBy!) })),
  });
}

/** Renumbers siblings 0..n with `movedId` placed at `index` (end if null). */
async function placeAmongSiblings(tx: Tx, spaceId: number, parentId: number | null, movedId: number, index: number | null) {
  const siblings = await tx.select({ id: pages.id }).from(pages)
    .where(and(
      eq(pages.spaceId, spaceId),
      parentId === null ? isNull(pages.parentId) : eq(pages.parentId, parentId),
      isNull(pages.deletedAt),
      ne(pages.id, movedId),
    ))
    .orderBy(asc(pages.position), asc(pages.id));
  const ids = siblings.map((s) => s.id);
  const at = index === null ? ids.length : Math.max(0, Math.min(index, ids.length));
  ids.splice(at, 0, movedId);
  for (let i = 0; i < ids.length; i++) {
    await tx.update(pages).set({ position: i }).where(eq(pages.id, ids[i]));
  }
}

async function liveParentIn(tx: Tx, parentId: number, spaceId: number) {
  const [parent] = await tx.select().from(pages).where(eq(pages.id, parentId));
  if (!parent || parent.deletedAt) throw notFound('Target parent page not found');
  if (parent.spaceId !== spaceId) throw badRequest('Target parent page is in another Space');
  return parent;
}

/** How many live pages a delete or move of this page would affect. */
export async function subtreeCount(pageId: number): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`
    with recursive sub as (
      select id from pages where id = ${pageId} and deleted_at is null
      union all
      select p.id from pages p join sub on p.parent_id = sub.id where p.deleted_at is null
    )
    select count(*)::int as n from sub`);
  const n = res.rows[0]?.n ?? 0;
  if (!n) throw notFound('Page not found');
  return n;
}

/**
 * Moves a page (and its subtree) under `parentId` in `spaceId`, at sibling position `index`
 * (end of the list if omitted). Moving to another Space moves the whole subtree.
 */
export async function movePage(
  pageId: number,
  user: SessionUser,
  target: { spaceId: number; parentId: number | null; index?: number | null },
): Promise<{ id: number; spaceId: number; parentId: number | null }> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ spaceId: pages.spaceId, deletedAt: pages.deletedAt }).from(pages).where(eq(pages.id, pageId));
    if (!current || current.deletedAt) throw notFound('Page not found');
    const [space] = await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, target.spaceId));
    if (!space) throw notFound('Space not found');
    await lockSpaces(tx, current.spaceId, target.spaceId);
    const rows = await lockSubtree(tx, pageId);
    const page = rows.find((r) => r.id === pageId);
    if (!page) throw notFound('Page not found');
    await assertNoForeignCheckouts(tx, rows, user, 'move this page');
    if (target.parentId !== null) {
      if (rows.some((r) => r.id === target.parentId)) throw badRequest("A page can't be moved under itself or one of its subpages");
      await liveParentIn(tx, target.parentId, target.spaceId);
    }
    await tx.update(pages).set({ parentId: target.parentId }).where(eq(pages.id, pageId));
    if (target.spaceId !== page.spaceId) {
      await tx.update(pages).set({ spaceId: target.spaceId }).where(inArray(pages.id, rows.map((r) => r.id)));
    }
    await placeAmongSiblings(tx, target.spaceId, target.parentId, pageId, target.index ?? null);
    return { id: pageId, spaceId: target.spaceId, parentId: target.parentId };
  });
}

/** Moves a page and its subpages to the trash. Returns how many pages were trashed. */
export async function trashPage(pageId: number, user: SessionUser): Promise<{ count: number }> {
  return db.transaction(async (tx) => {
    const p = await lockPage(tx, pageId);
    await lockSpaces(tx, p.spaceId);
    const rows = await lockSubtree(tx, pageId);
    await assertNoForeignCheckouts(tx, rows, user, 'delete this page');
    const locked = rows.filter((r) => !canEditDirectly(r, user));
    if (locked.length) {
      throw new HttpError(403, `Can't delete: ${locked.map((r) => `“${r.title}”`).join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked by the owner`, {
        code: 'locked', pages: locked.map((r) => ({ id: r.id, title: r.title })),
      });
    }
    const ids = rows.map((r) => r.id);
    // The deleting user's own check-outs are released; their drafts stay but are hidden while trashed.
    await tx.update(pages).set({
      deletedAt: new Date(), deletedBy: user.id, trashRootId: pageId,
      checkedOutBy: null, checkedOutAt: null, checkoutHeartbeatAt: null,
    }).where(inArray(pages.id, ids));
    return { count: ids.length };
  });
}

export async function listTrash(filter: { q?: string } = {}) {
  const deleter = alias(users, 'deleter');
  const parent = alias(pages, 'parent');
  const like = filter.q?.trim() ? `%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db
    .select({
      id: pages.id,
      title: pages.title,
      spaceKey: spaces.key,
      spaceName: spaces.name,
      deletedAt: pages.deletedAt,
      deletedBy: deleter.displayName,
      parentId: pages.parentId,
      parentTitle: parent.title,
      parentLive: sql<boolean>`${parent.id} is not null and ${parent.deletedAt} is null`,
      count: sql<number>`(select count(*)::int from pages g where g.trash_root_id = ${pages.id} and g.deleted_at is not null)`,
      purgeAt: sql<Date>`${pages.deletedAt} + make_interval(days => ${TRASH_RETENTION_DAYS})`,
    })
    .from(pages)
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .leftJoin(deleter, eq(deleter.id, pages.deletedBy))
    .leftJoin(parent, eq(parent.id, pages.parentId))
    .where(and(
      sql`${pages.deletedAt} is not null`,
      eq(pages.trashRootId, pages.id),
      like ? sql`exists (select 1 from pages g where g.trash_root_id = ${pages.id} and g.deleted_at is not null and (g.title ilike ${like} or g.body ilike ${like}))` : undefined,
    ))
    .orderBy(sql`${pages.deletedAt} desc`);
  return rows;
}

async function trashGroup(tx: Tx, rootId: number) {
  const rows = await tx.select().from(pages)
    .where(and(eq(pages.trashRootId, rootId), sql`${pages.deletedAt} is not null`))
    .orderBy(asc(pages.id)).for('update');
  const root = rows.find((r) => r.id === rootId);
  if (!root) throw notFound('Not found in the trash');
  return { rows, root };
}

/**
 * Restores a trashed page and the subpages that were deleted with it. They go back under the original
 * parent if it still exists, otherwise to the root of the original Space, unless a target is given.
 */
export async function restoreFromTrash(
  rootId: number,
  admin: SessionUser,
  target?: { spaceId: number; parentId: number | null },
): Promise<{ id: number; spaceId: number; parentId: number | null }> {
  if (admin.role !== 'admin') throw forbidden('Admins only');
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ spaceId: pages.spaceId }).from(pages).where(eq(pages.id, rootId));
    if (!peek) throw notFound('Not found in the trash');
    await lockSpaces(tx, peek.spaceId, target?.spaceId ?? peek.spaceId);
    const { rows, root } = await trashGroup(tx, rootId);
    let spaceId = root.spaceId;
    let parentId: number | null = null;
    if (target) {
      const [space] = await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, target.spaceId));
      if (!space) throw notFound('Space not found');
      if (target.parentId !== null) await liveParentIn(tx, target.parentId, target.spaceId);
      spaceId = target.spaceId;
      parentId = target.parentId;
    } else if (root.parentId !== null) {
      const [parent] = await tx.select({ deletedAt: pages.deletedAt, spaceId: pages.spaceId }).from(pages).where(eq(pages.id, root.parentId));
      if (parent && !parent.deletedAt && parent.spaceId === root.spaceId) parentId = root.parentId;
    }
    const ids = rows.map((r) => r.id);
    await tx.update(pages).set({ deletedAt: null, deletedBy: null, trashRootId: null, spaceId }).where(inArray(pages.id, ids));
    await tx.update(pages).set({ parentId }).where(eq(pages.id, rootId));
    await placeAmongSiblings(tx, spaceId, parentId, rootId, null);
    return { id: rootId, spaceId, parentId };
  });
}

/** Permanently deletes a trash group with its revisions, drafts, links and attachment rows. */
async function purgeGroup(tx: Tx, rootId: number): Promise<number> {
  const { rows } = await trashGroup(tx, rootId);
  const ids = rows.map((r) => r.id);
  // Pages trashed earlier from inside this subtree lose their parent; restoring them later puts them at the Space root.
  await tx.update(pages).set({ parentId: null })
    .where(and(inArray(pages.parentId, ids), sql`${pages.id} not in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
  await tx.delete(pages).where(inArray(pages.id, ids));
  return ids.length;
}

export async function purgeFromTrash(rootId: number, admin: SessionUser): Promise<{ count: number }> {
  if (admin.role !== 'admin') throw forbidden('Admins only');
  return db.transaction(async (tx) => ({ count: await purgeGroup(tx, rootId) }));
}

/** Nightly: purges trash groups older than the retention period. */
export async function purgeExpiredTrash(days = TRASH_RETENTION_DAYS): Promise<{ groups: number; pages: number }> {
  const roots = await db.select({ id: pages.id }).from(pages)
    .where(and(eq(pages.trashRootId, pages.id), sql`${pages.deletedAt} < now() - make_interval(days => ${days})`));
  let total = 0;
  for (const r of roots) {
    total += await db.transaction((tx) => purgeGroup(tx, r.id));
  }
  return { groups: roots.length, pages: total };
}

/** Admin: delete a Space. Only allowed when it holds no pages at all, including the trash. */
export async function deleteSpace(spaceId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSpaces(tx, spaceId);
    const [{ live, trashed }] = await tx.select({
      live: sql<number>`count(*) filter (where ${pages.deletedAt} is null)::int`,
      trashed: sql<number>`count(*) filter (where ${pages.deletedAt} is not null)::int`,
    }).from(pages).where(eq(pages.spaceId, spaceId));
    if (live || trashed) {
      throw conflict(`This Space still has ${live} page(s)${trashed ? ` and ${trashed} in the trash` : ''}. Move or delete them first${trashed ? ', and purge them from the trash' : ''}.`, {
        code: 'space_not_empty', live, trashed,
      });
    }
    await tx.delete(spaces).where(eq(spaces.id, spaceId));
  });
}
