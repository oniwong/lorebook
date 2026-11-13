// Change requests (spec §6): suggested edits that the page owner reviews like a pull request.
//
// Lifecycle: draft (private, autosaved) → open (submitted) ⇄ changes_requested → approved | rejected,
// or withdrawn by the requester at any point before a decision. A request is "outdated" while its base
// revision isn't the page's current one; it must be updated onto the latest version before approval.
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Tx } from '../db/index.js';
import {
  changeRequestEvents, changeRequests, drafts, inboxItems, pages, revisions, spaces, users,
  type ChangeRequestStatus,
} from '../db/schema.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from './errors.js';
import {
  TITLE_MAX, checkedOutConflict, checkoutIsLive, lockPage, notifyOutdated, requiredSectionsFor,
} from './pages.js';
import { checkRequiredSections } from './sections.js';
import { scanMarkdown, toStored } from './secretConfig.js';
import { syncLinks } from './links.js';
import { indexPage } from './search.js';
import { slugify } from './slug.js';
import { hasConflictMarkers, merge3 } from './merge.js';
import { notify, resolveItems, reviewersFor } from './inbox.js';
import type { SessionUser } from './auth.js';

type CrRow = typeof changeRequests.$inferSelect;
type PageRow = typeof pages.$inferSelect;

export const ACTIVE: ChangeRequestStatus[] = ['draft', 'open', 'changes_requested'];
const DESCRIPTION_MAX = 5000;

const isActive = (s: ChangeRequestStatus) => ACTIVE.includes(s);

/** The page owner reviews; admins can always step in (owner away or gone). */
export function isReviewer(p: Pick<PageRow, 'ownerId'>, user: SessionUser): boolean {
  return p.ownerId === user.id || user.role === 'admin';
}

async function lockCr(tx: Tx, id: number): Promise<CrRow> {
  const [cr] = await tx.select().from(changeRequests).where(eq(changeRequests.id, id)).for('update');
  if (!cr) throw notFound('Change request not found');
  return cr;
}

/** Locks the request and then its page, always in that order. Drafts are private to their author. */
async function load(tx: Tx, id: number, user: SessionUser): Promise<{ cr: CrRow; p: PageRow }> {
  const cr = await lockCr(tx, id);
  if (cr.status === 'draft' && cr.authorId !== user.id) throw notFound('Change request not found');
  const p = await lockPage(tx, cr.pageId);
  return { cr, p };
}

function assertAuthor(cr: CrRow, user: SessionUser) {
  if (cr.authorId !== user.id) throw forbidden('Only the person who suggested this change can do that');
}

function assertActive(cr: CrRow) {
  if (!isActive(cr.status)) throw conflict(`This change request is already ${cr.status}`, { code: 'not_active', status: cr.status });
}

function validateTitle(title: string): string {
  const t = title.trim();
  if (!t) throw badRequest('Title is required');
  if (t.length > TITLE_MAX) throw badRequest(`Title must be at most ${TITLE_MAX} characters`);
  return t;
}

async function addEvent(tx: Tx, crId: number, actorId: number, kind: typeof changeRequestEvents.$inferInsert['kind'], body = '') {
  await tx.insert(changeRequestEvents).values({ changeRequestId: crId, actorId, kind, body: body.trim() });
}

/** Inbox items about a request that need no more attention once it is decided or withdrawn. */
async function resolveCrItems(tx: Tx, crId: number) {
  await resolveItems(tx, and(eq(inboxItems.changeRequestId, crId),
    sql`${inboxItems.kind} in ('cr_submitted', 'cr_resubmitted', 'cr_comment', 'cr_outdated', 'cr_changes_requested')`));
}

async function checkContent(tx: Tx, p: PageRow, body: string) {
  if (hasConflictMarkers(body)) {
    throw new HttpError(422, 'Resolve the conflicts first: remove the <<<<<<< / ======= / >>>>>>> lines and keep the text you want', {
      code: 'conflict_markers',
    });
  }
  const required = await requiredSectionsFor(tx, p.template);
  if (!required.length) return;
  const { missing, empty } = checkRequiredSections(body, required);
  if (missing.length || empty.length) {
    const parts = [missing.length ? `missing: ${missing.join(', ')}` : '', empty.length ? `empty: ${empty.join(', ')}` : ''].filter(Boolean);
    throw new HttpError(422, `Required sections are ${parts.join('; ')}`, { code: 'missing_sections', missing, empty, template: p.template });
  }
}

/**
 * "Suggest change": opens the viewer's unfinished request on this page, or starts a draft from the current
 * version. With `fromDraft`, the person's own check-out draft becomes the request (e.g. after the page was
 * locked while their draft was waiting).
 */
export async function startChangeRequest(pageId: number, user: SessionUser, opts: { fromDraft?: boolean } = {}): Promise<{ id: number; created: boolean }> {
  return db.transaction(async (tx) => {
    const p = await lockPage(tx, pageId);
    const [existing] = await tx.select({ id: changeRequests.id }).from(changeRequests)
      .where(and(eq(changeRequests.pageId, pageId), eq(changeRequests.authorId, user.id), inArray(changeRequests.status, ACTIVE)));
    if (existing) return { id: existing.id, created: false };
    if (p.ownerId === user.id) throw badRequest('You own this page, so you can edit it directly', { code: 'own_page' });
    let start = { title: p.title, body: p.body, baseRevisionId: p.currentRevisionId! };
    if (opts.fromDraft) {
      const [d] = await tx.select().from(drafts).where(and(eq(drafts.pageId, pageId), eq(drafts.userId, user.id)));
      if (!d) throw notFound('You have no draft of this page');
      if (p.checkedOutBy === user.id) {
        await tx.update(pages).set({ checkedOutBy: null, checkedOutAt: null, checkoutHeartbeatAt: null }).where(eq(pages.id, pageId));
      }
      await tx.delete(drafts).where(and(eq(drafts.pageId, pageId), eq(drafts.userId, user.id)));
      start = { title: d.title, body: d.body, baseRevisionId: d.baseRevisionId };
    }
    const [cr] = await tx.insert(changeRequests).values({ pageId, authorId: user.id, ...start }).returning({ id: changeRequests.id });
    return { id: cr.id, created: true };
  });
}

/** Autosave from the change request editor. Bumps the version when the content changes. */
export async function saveChangeRequest(
  id: number, user: SessionUser, input: { title: string; body: string; description?: string },
): Promise<{ version: number; updatedAt: Date }> {
  return db.transaction(async (tx) => {
    const cr = await lockCr(tx, id);
    assertAuthor(cr, user);
    assertActive(cr);
    const changed = input.title !== cr.title || input.body !== cr.body;
    const [row] = await tx.update(changeRequests).set({
      title: input.title, body: input.body,
      description: input.description !== undefined ? input.description.slice(0, DESCRIPTION_MAX) : cr.description,
      version: changed ? cr.version + 1 : cr.version,
      updatedAt: new Date(),
    }).where(eq(changeRequests.id, id)).returning({ version: changeRequests.version, updatedAt: changeRequests.updatedAt });
    return row;
  });
}

/** Sends a draft (or a request sent back for changes) to the reviewers. */
export async function submitChangeRequest(
  id: number, user: SessionUser, input: { description?: string; secretsAcknowledged?: boolean },
): Promise<{ status: ChangeRequestStatus }> {
  return db.transaction(async (tx) => {
    const { cr, p } = await load(tx, id, user);
    assertAuthor(cr, user);
    if (cr.status === 'open') throw conflict('This change request is already submitted', { code: 'already_open' });
    assertActive(cr);
    validateTitle(cr.title);
    const [base] = await tx.select({ title: revisions.title, body: revisions.body }).from(revisions).where(eq(revisions.id, cr.baseRevisionId));
    const ref = base ?? { title: p.title, body: p.body };
    if (ref.title === cr.title && ref.body === cr.body) throw badRequest('There are no changes to suggest yet', { code: 'no_changes' });
    await checkContent(tx, p, cr.body);
    const findings = await scanMarkdown(cr.body);
    if (findings.length && !input.secretsAcknowledged) {
      throw new HttpError(422, `This looks like it contains ${findings.length === 1 ? 'a secret' : `${findings.length} secrets`}`, {
        code: 'possible_secrets', findings,
      });
    }
    const resubmit = cr.submittedAt !== null;
    const description = input.description !== undefined ? input.description.slice(0, DESCRIPTION_MAX) : cr.description;
    await tx.update(changeRequests).set({
      status: 'open', description, secretFindings: toStored(findings), updatedAt: new Date(), submittedAt: cr.submittedAt ?? new Date(),
    }).where(eq(changeRequests.id, id));
    await addEvent(tx, id, user.id, resubmit ? 'resubmitted' : 'submitted', resubmit ? '' : description);
    const reviewers = await reviewersFor(tx, p.ownerId);
    await notify(tx, reviewers.map((r) => ({
      userId: r, kind: resubmit ? 'cr_resubmitted' as const : 'cr_submitted' as const, pageId: p.id, changeRequestId: id, actorId: user.id,
    })));
    return { status: 'open' as const };
  });
}

/**
 * A comment from the requester or a reviewer. With `requestChanges`, a reviewer sends the request back to
 * its author, who edits and resubmits it.
 */
export async function commentOnChangeRequest(
  id: number, user: SessionUser, input: { body: string; requestChanges?: boolean },
): Promise<{ status: ChangeRequestStatus }> {
  const text = input.body.trim();
  if (!text) throw badRequest('Write a comment');
  return db.transaction(async (tx) => {
    const { cr, p } = await load(tx, id, user);
    const author = cr.authorId === user.id;
    const reviewer = isReviewer(p, user) && !author;
    if (!author && !reviewer) throw forbidden('Only the requester, the page owner or an admin can comment');
    if (cr.status === 'draft') throw badRequest('Submit the change request first');
    let status = cr.status;
    if (input.requestChanges) {
      if (!reviewer) throw forbidden('Only the page owner or an admin can ask for changes');
      if (cr.status !== 'open') throw conflict('Only an open change request can be sent back', { code: 'not_open' });
      status = 'changes_requested';
      await tx.update(changeRequests).set({ status, updatedAt: new Date() }).where(eq(changeRequests.id, id));
      await resolveItems(tx, and(eq(inboxItems.changeRequestId, id), sql`${inboxItems.kind} in ('cr_submitted', 'cr_resubmitted')`));
    }
    await addEvent(tx, id, user.id, input.requestChanges ? 'changes_requested' : 'comment', text);
    const to = author ? await reviewersFor(tx, p.ownerId) : [cr.authorId];
    await notify(tx, to.map((u) => ({
      userId: u, kind: input.requestChanges ? 'cr_changes_requested' as const : 'cr_comment' as const,
      pageId: p.id, changeRequestId: id, actorId: user.id, text,
    })));
    return { status };
  });
}

/** Applies the request as a new revision credited to the requester, "approved by" the reviewer. */
export async function approveChangeRequest(
  id: number, user: SessionUser, input: { version: number; message?: string },
): Promise<{ revisionId: number }> {
  return db.transaction(async (tx) => {
    const { cr, p } = await load(tx, id, user);
    if (!isReviewer(p, user)) throw forbidden('Only the page owner or an admin can approve change requests');
    if (cr.authorId === user.id) throw forbidden("You can't approve your own change request");
    if (cr.status !== 'open') {
      throw conflict(cr.status === 'changes_requested'
        ? 'The requester is making changes. Wait for them to resubmit.'
        : `This change request is ${cr.status}`, { code: 'not_open', status: cr.status });
    }
    if (cr.version !== input.version) {
      throw conflict('The change request was edited while you were reviewing it. Look at the new version first.', { code: 'cr_changed', version: cr.version });
    }
    if (cr.baseRevisionId !== p.currentRevisionId) {
      throw conflict('The page changed after this request was made. The requester must update it onto the latest version first.', { code: 'cr_outdated' });
    }
    if (checkoutIsLive(p)) throw await checkedOutConflict(tx, p);
    const title = validateTitle(cr.title);
    await checkContent(tx, p, cr.body);
    const findings = await scanMarkdown(cr.body);
    const message = input.message?.trim() || cr.description.split('\n')[0].slice(0, 500) || `Change request #${cr.id}`;
    const [rev] = await tx.insert(revisions).values({
      pageId: p.id, title, body: cr.body, authorId: cr.authorId, kind: 'change_request', message,
      changeRequestId: cr.id, approvedBy: user.id,
      secretFindings: toStored(findings), secretsAcknowledged: findings.length > 0,
    }).returning({ id: revisions.id });
    const now = new Date();
    await tx.update(pages).set({
      title, slug: slugify(title), body: cr.body, currentRevisionId: rev.id, updatedAt: now, updatedBy: cr.authorId,
    }).where(eq(pages.id, p.id));
    await tx.update(changeRequests).set({
      status: 'approved', decidedAt: now, decidedBy: user.id, appliedRevisionId: rev.id, updatedAt: now,
    }).where(eq(changeRequests.id, id));
    await syncLinks(tx, p.id, cr.body);
    await indexPage(tx, p.id);
    await addEvent(tx, id, user.id, 'approved', input.message ?? '');
    await resolveCrItems(tx, id);
    await notify(tx, [{ userId: cr.authorId, kind: 'cr_approved', pageId: p.id, changeRequestId: id, actorId: user.id, text: input.message ?? '' }]);
    await notifyOutdated(tx, p.id, user.id);
    return { revisionId: rev.id };
  });
}

export async function rejectChangeRequest(id: number, user: SessionUser, input: { comment?: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const { cr, p } = await load(tx, id, user);
    if (!isReviewer(p, user)) throw forbidden('Only the page owner or an admin can reject change requests');
    if (cr.authorId === user.id) throw forbidden('Withdraw your own change request instead');
    if (cr.status !== 'open' && cr.status !== 'changes_requested') {
      throw conflict(`This change request is ${cr.status}`, { code: 'not_open', status: cr.status });
    }
    const now = new Date();
    await tx.update(changeRequests).set({ status: 'rejected', decidedAt: now, decidedBy: user.id, updatedAt: now })
      .where(eq(changeRequests.id, id));
    await addEvent(tx, id, user.id, 'rejected', input.comment ?? '');
    await resolveCrItems(tx, id);
    await notify(tx, [{ userId: cr.authorId, kind: 'cr_rejected', pageId: p.id, changeRequestId: id, actorId: user.id, text: input.comment ?? '' }]);
  });
}

/** The requester withdraws a submitted request, or throws away a draft (which deletes it). */
export async function withdrawChangeRequest(id: number, user: SessionUser): Promise<{ deleted: boolean }> {
  return db.transaction(async (tx) => {
    const cr = await lockCr(tx, id);
    assertAuthor(cr, user);
    assertActive(cr);
    if (cr.status === 'draft') {
      await tx.delete(changeRequests).where(eq(changeRequests.id, id));
      return { deleted: true };
    }
    const [p] = await tx.select({ ownerId: pages.ownerId }).from(pages).where(eq(pages.id, cr.pageId));
    await tx.update(changeRequests).set({ status: 'withdrawn', decidedAt: new Date(), updatedAt: new Date() }).where(eq(changeRequests.id, id));
    await addEvent(tx, id, user.id, 'withdrawn');
    await resolveCrItems(tx, id);
    if (p && cr.status === 'open') {
      const reviewers = await reviewersFor(tx, p.ownerId);
      await notify(tx, reviewers.map((r) => ({ userId: r, kind: 'cr_withdrawn' as const, pageId: cr.pageId, changeRequestId: id, actorId: user.id })));
    }
    return { deleted: false };
  });
}

/**
 * Updates an outdated request onto the page's current version with a three-way merge. Where the
 * request and the page changed the same lines, both versions are kept between conflict markers, which
 * the requester resolves in the editor before the request can be submitted or approved.
 */
export async function updateToLatest(id: number, user: SessionUser): Promise<{ conflicts: number; changed: boolean; version: number }> {
  return db.transaction(async (tx) => {
    const { cr, p } = await load(tx, id, user);
    assertAuthor(cr, user);
    assertActive(cr);
    if (cr.baseRevisionId === p.currentRevisionId) return { conflicts: 0, changed: false, version: cr.version };
    const [base] = await tx.select({ title: revisions.title, body: revisions.body }).from(revisions).where(eq(revisions.id, cr.baseRevisionId));
    // If the base revision was purged, there is nothing to merge against: everything that differs is a conflict.
    const merged = merge3(base?.body ?? '', cr.body, p.body);
    const title = base && cr.title === base.title ? p.title : cr.title;
    const version = cr.version + 1;
    await tx.update(changeRequests).set({
      title, body: merged.text, baseRevisionId: p.currentRevisionId!, version, updatedAt: new Date(),
    }).where(eq(changeRequests.id, id));
    if (cr.status !== 'draft') await addEvent(tx, id, user.id, 'updated_to_latest', merged.conflicts ? `${merged.conflicts} conflict(s) to resolve` : '');
    await resolveItems(tx, and(eq(inboxItems.changeRequestId, id), eq(inboxItems.kind, 'cr_outdated')));
    return { conflicts: merged.conflicts, changed: true, version };
  });
}

/** Everything the review screen and the change request editor need. */
export async function getChangeRequest(id: number, viewer: SessionUser) {
  const author = alias(users, 'author');
  const decider = alias(users, 'decider');
  const owner = alias(users, 'owner');
  const [row] = await db
    .select({
      cr: changeRequests,
      authorName: author.displayName,
      deciderName: decider.displayName,
      page: pages,
      spaceKey: spaces.key,
      spaceName: spaces.name,
      ownerName: owner.displayName,
      ownerActive: owner.active,
    })
    .from(changeRequests)
    .innerJoin(author, eq(author.id, changeRequests.authorId))
    .leftJoin(decider, eq(decider.id, changeRequests.decidedBy))
    .innerJoin(pages, eq(pages.id, changeRequests.pageId))
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .innerJoin(owner, eq(owner.id, pages.ownerId))
    .where(eq(changeRequests.id, id));
  if (!row) throw notFound('Change request not found');
  const { cr, page: p } = row;
  if (cr.status === 'draft' && cr.authorId !== viewer.id) throw notFound('Change request not found');
  if (p.deletedAt && viewer.role !== 'admin') throw notFound('Change request not found');
  const [base] = await db.select({ id: revisions.id, title: revisions.title, body: revisions.body, createdAt: revisions.createdAt })
    .from(revisions).where(eq(revisions.id, cr.baseRevisionId));
  const actor = alias(users, 'actor');
  const events = await db
    .select({
      id: changeRequestEvents.id, kind: changeRequestEvents.kind, body: changeRequestEvents.body, createdAt: changeRequestEvents.createdAt,
      actor: { id: actor.id, displayName: actor.displayName },
    })
    .from(changeRequestEvents)
    .innerJoin(actor, eq(actor.id, changeRequestEvents.actorId))
    .where(eq(changeRequestEvents.changeRequestId, id))
    .orderBy(asc(changeRequestEvents.id));
  const isAuthor = cr.authorId === viewer.id;
  const reviewer = isReviewer(p, viewer) && !isAuthor;
  const live = checkoutIsLive(p);
  let checkout = null;
  if (live) {
    const [h] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, p.checkedOutBy!));
    checkout = { userId: p.checkedOutBy!, displayName: h?.displayName ?? 'someone', since: p.checkedOutAt! };
  }
  return {
    id: cr.id,
    status: cr.status,
    title: cr.title,
    body: cr.body,
    description: cr.description,
    version: cr.version,
    createdAt: cr.createdAt,
    updatedAt: cr.updatedAt,
    submittedAt: cr.submittedAt,
    decidedAt: cr.decidedAt,
    decidedBy: cr.decidedBy ? { id: cr.decidedBy, displayName: row.deciderName ?? '' } : null,
    appliedRevisionId: cr.appliedRevisionId,
    secretFindings: cr.secretFindings ?? [],
    author: { id: cr.authorId, displayName: row.authorName },
    page: {
      id: p.id, title: p.title, slug: p.slug, body: p.body, spaceKey: row.spaceKey, spaceName: row.spaceName,
      template: p.template, locked: p.locked, currentRevisionId: p.currentRevisionId, trashed: !!p.deletedAt,
      owner: { id: p.ownerId, displayName: row.ownerName, active: row.ownerActive },
      checkout,
    },
    base: base ?? null,
    outdated: isActive(cr.status) && cr.baseRevisionId !== p.currentRevisionId,
    hasConflicts: hasConflictMarkers(cr.body),
    events,
    can: {
      edit: isAuthor && isActive(cr.status),
      submit: isAuthor && (cr.status === 'draft' || cr.status === 'changes_requested'),
      withdraw: isAuthor && isActive(cr.status),
      review: reviewer && (cr.status === 'open' || cr.status === 'changes_requested'),
      approve: reviewer && cr.status === 'open',
      comment: (isAuthor || reviewer) && cr.status !== 'draft',
    },
  };
}

export type CrListFilter = {
  pageId?: number;
  authorId?: number;
  /** Open requests waiting on this user's review. */
  reviewerId?: number;
  statuses?: ChangeRequestStatus[];
  limit?: number;
};

export async function listChangeRequests(filter: CrListFilter, viewer: SessionUser) {
  const author = alias(users, 'author');
  const owner = alias(users, 'owner');
  const cond: (SQL | undefined)[] = [
    isNull(pages.deletedAt),
    // Drafts are private.
    or(ne(changeRequests.status, 'draft'), eq(changeRequests.authorId, viewer.id)),
  ];
  if (filter.pageId) cond.push(eq(changeRequests.pageId, filter.pageId));
  if (filter.authorId) cond.push(eq(changeRequests.authorId, filter.authorId));
  if (filter.statuses?.length) cond.push(inArray(changeRequests.status, filter.statuses));
  if (filter.reviewerId) {
    const isAdmin = filter.reviewerId === viewer.id && viewer.role === 'admin';
    cond.push(eq(changeRequests.status, 'open'));
    cond.push(ne(changeRequests.authorId, filter.reviewerId));
    cond.push(isAdmin
      ? or(eq(pages.ownerId, filter.reviewerId), eq(owner.active, false))
      : eq(pages.ownerId, filter.reviewerId));
  }
  return db
    .select({
      id: changeRequests.id, status: changeRequests.status, title: changeRequests.title, description: changeRequests.description,
      createdAt: changeRequests.createdAt, updatedAt: changeRequests.updatedAt, submittedAt: changeRequests.submittedAt,
      decidedAt: changeRequests.decidedAt,
      outdated: sql<boolean>`${changeRequests.status} in ('draft', 'open', 'changes_requested') and ${changeRequests.baseRevisionId} <> ${pages.currentRevisionId}`,
      author: { id: author.id, displayName: author.displayName },
      page: { id: pages.id, title: pages.title, slug: pages.slug, spaceKey: spaces.key, spaceName: spaces.name },
      owner: { id: owner.id, displayName: owner.displayName, active: owner.active },
    })
    .from(changeRequests)
    .innerJoin(pages, eq(pages.id, changeRequests.pageId))
    .innerJoin(spaces, eq(spaces.id, pages.spaceId))
    .innerJoin(author, eq(author.id, changeRequests.authorId))
    .innerJoin(owner, eq(owner.id, pages.ownerId))
    .where(and(...cond))
    .orderBy(desc(changeRequests.updatedAt))
    .limit(filter.limit ?? 100);
}

export async function countToReview(viewer: SessionUser): Promise<number> {
  const rows = await listChangeRequests({ reviewerId: viewer.id, limit: 500 }, viewer);
  return rows.length;
}
