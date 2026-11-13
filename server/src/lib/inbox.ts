// The in-app inbox (spec §6). With no email or chat in v1, this is how people hear about change requests,
// lost check-outs, pages due for review and pages whose owner has left.
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Tx } from '../db/index.js';
import { changeRequests, inboxItems, pages, spaces, users } from '../db/schema.js';
import { REVIEW_DUE_DAYS } from './search.js';

export const INBOX_KINDS = [
  'cr_submitted', 'cr_resubmitted', 'cr_comment', 'cr_changes_requested', 'cr_approved', 'cr_rejected',
  'cr_withdrawn', 'cr_outdated',
  'checkout_broken', 'checkout_expired',
  'page_locked', 'page_unlocked', 'owner_assigned', 'owner_removed',
  'review_due', 'review_overdue', 'former_owner',
] as const;
export type InboxKind = typeof INBOX_KINDS[number];

export type NewItem = {
  userId: number;
  kind: InboxKind;
  pageId?: number | null;
  changeRequestId?: number | null;
  actorId?: number | null;
  text?: string;
  dedupeKey?: string | null;
};

/** Adds inbox items. Nobody is notified about their own action; duplicate dedupe keys are skipped. */
export async function notify(tx: Tx | typeof db, items: NewItem[]): Promise<void> {
  const rows = items
    .filter((i) => i.userId !== i.actorId)
    .map((i) => ({
      userId: i.userId, kind: i.kind, pageId: i.pageId ?? null, changeRequestId: i.changeRequestId ?? null,
      actorId: i.actorId ?? null, text: (i.text ?? '').slice(0, 300), dedupeKey: i.dedupeKey ?? null,
    }));
  if (!rows.length) return;
  await tx.insert(inboxItems).values(rows).onConflictDoNothing();
}

/** Marks items read for everyone once what they were about is dealt with (e.g. a request was decided). */
export async function resolveItems(tx: Tx | typeof db, where: SQL | undefined): Promise<void> {
  await tx.update(inboxItems).set({ readAt: new Date() }).where(and(isNull(inboxItems.readAt), where));
}

/** Active admins, who stand in for owners who have left. */
export async function activeAdminIds(tx: Tx | typeof db): Promise<number[]> {
  const rows = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'admin'), eq(users.active, true)));
  return rows.map((r) => r.id);
}

/**
 * The people who review change requests on a page: its owner, or every admin when the owner has left
 * (spec §15, "pending change requests become reviewable by admins").
 */
export async function reviewersFor(tx: Tx | typeof db, ownerId: number): Promise<number[]> {
  const [o] = await tx.select({ active: users.active }).from(users).where(eq(users.id, ownerId));
  return o?.active ? [ownerId] : activeAdminIds(tx);
}

/**
 * Adds the items that come from the state of pages rather than from someone's action: pages due or
 * overdue for review (to their owner), and pages whose owner is disabled (to admins). Each one is added
 * once per review date or per former owner.
 */
export async function sweepInbox(): Promise<number> {
  const review = await db.execute(sql`
    insert into inbox_items (user_id, kind, page_id, dedupe_key)
    select p.owner_id,
      case when p.review_by < current_date then 'review_overdue' else 'review_due' end,
      p.id,
      'review:' || case when p.review_by < current_date then 'overdue' else 'due' end || ':' || p.id || ':' || p.review_by
    from pages p join users u on u.id = p.owner_id
    where p.deleted_at is null and u.active and p.review_by is not null
      and p.review_by <= current_date + ${REVIEW_DUE_DAYS}::int
    on conflict do nothing`);
  const former = await db.execute(sql`
    insert into inbox_items (user_id, kind, page_id, dedupe_key)
    select a.id, 'former_owner', p.id, 'former_owner:' || p.id || ':' || p.owner_id
    from pages p
    join users o on o.id = p.owner_id and not o.active
    join users a on a.role = 'admin' and a.active
    where p.deleted_at is null
    on conflict do nothing`);
  return (review.rowCount ?? 0) + (former.rowCount ?? 0);
}

let lastSweep = 0;
const SWEEP_EVERY_MS = 15 * 60_000;

/** Called from the housekeeping tick; sweeps at most every 15 minutes. */
export async function maybeSweepInbox(now = Date.now()): Promise<number> {
  if (now - lastSweep < SWEEP_EVERY_MS) return 0;
  lastSweep = now;
  return sweepInbox();
}

export async function unreadCount(userId: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(inboxItems)
    .where(and(eq(inboxItems.userId, userId), isNull(inboxItems.readAt)));
  return r?.n ?? 0;
}

export async function listInbox(userId: number, opts: { unreadOnly?: boolean; limit?: number; before?: number }) {
  const actor = alias(users, 'actor');
  const rows = await db
    .select({
      id: inboxItems.id, kind: inboxItems.kind, text: inboxItems.text, createdAt: inboxItems.createdAt,
      readAt: inboxItems.readAt, changeRequestId: inboxItems.changeRequestId,
      crStatus: changeRequests.status,
      actor: { id: actor.id, displayName: actor.displayName },
      page: {
        id: pages.id, title: pages.title, slug: pages.slug, spaceKey: spaces.key, deletedAt: pages.deletedAt,
      },
    })
    .from(inboxItems)
    .leftJoin(actor, eq(actor.id, inboxItems.actorId))
    .leftJoin(pages, eq(pages.id, inboxItems.pageId))
    .leftJoin(spaces, eq(spaces.id, pages.spaceId))
    .leftJoin(changeRequests, eq(changeRequests.id, inboxItems.changeRequestId))
    .where(and(
      eq(inboxItems.userId, userId),
      opts.unreadOnly ? isNull(inboxItems.readAt) : undefined,
      opts.before ? sql`${inboxItems.id} < ${opts.before}` : undefined,
    ))
    .orderBy(desc(inboxItems.id))
    .limit(opts.limit ?? 50);
  return rows.map((r) => ({
    ...r,
    actor: r.actor?.id ? r.actor : null,
    page: r.page?.id ? { id: r.page.id, title: r.page.title, slug: r.page.slug, spaceKey: r.page.spaceKey!, trashed: !!r.page.deletedAt } : null,
  }));
}

export async function markRead(userId: number, ids: number[] | 'all'): Promise<void> {
  await db.update(inboxItems).set({ readAt: new Date() })
    .where(and(
      eq(inboxItems.userId, userId),
      isNull(inboxItems.readAt),
      ids === 'all' ? undefined : inArray(inboxItems.id, ids.length ? ids : [-1]),
    ));
}
