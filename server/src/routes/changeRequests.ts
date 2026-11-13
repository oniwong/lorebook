import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CR_STATUSES } from '../db/schema.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { idParam, parse } from '../lib/validate.js';
import { TITLE_MAX, reassignOwner, setLocked } from '../lib/pages.js';
import {
  approveChangeRequest, commentOnChangeRequest, countToReview, getChangeRequest, listChangeRequests, rejectChangeRequest,
  saveChangeRequest, startChangeRequest, submitChangeRequest, updateToLatest, withdrawChangeRequest,
} from '../lib/changeRequests.js';
import { listInbox, markRead, unreadCount } from '../lib/inbox.js';
import { db } from '../db/index.js';
import { pages } from '../db/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { flag } from './search.js';

const BODY_MAX = 2 * 1024 * 1024;
const statusList = z.string().max(200).optional().transform((s, ctx) => {
  if (!s) return undefined;
  const list = s.split(',').filter(Boolean);
  for (const x of list) {
    if (!(CR_STATUSES as readonly string[]).includes(x)) {
      ctx.addIssue({ code: 'custom', message: `Unknown status "${x}"` });
      return z.NEVER;
    }
  }
  return list as (typeof CR_STATUSES[number])[];
});

/** Locking, owner reassignment, change requests and the inbox (milestone 4). */
export async function collaborationRoutes(app: FastifyInstance) {
  app.post('/pages/:id/lock', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { locked } = parse(z.object({ locked: z.boolean() }), req.body);
    const r = await setLocked(id, user, locked);
    req.log.info({ event: locked ? 'page_locked' : 'page_unlocked', by: user.id, pageId: id }, locked ? 'page locked' : 'page unlocked');
    return r;
  });

  app.post('/pages/:id/owner', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { userId } = parse(z.object({ userId: z.number().int().positive() }), req.body);
    const r = await reassignOwner([id], admin, userId);
    req.log.info({ event: 'owner_reassigned', by: admin.id, pageIds: [id], to: userId }, 'page owner reassigned');
    return r;
  });

  /** Hands every page a (usually former) user owns to someone else. */
  app.post('/users/:id/reassign-pages', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { toUserId } = parse(z.object({ toUserId: z.number().int().positive() }), req.body);
    const owned = await db.select({ id: pages.id }).from(pages).where(and(eq(pages.ownerId, id), isNull(pages.deletedAt)));
    const r = await reassignOwner(owned.map((p) => p.id), admin, toUserId);
    req.log.info({ event: 'owner_reassigned', by: admin.id, from: id, to: toUserId, count: r.count }, 'pages reassigned');
    return r;
  });

  app.get('/pages/:id/change-requests', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ status: statusList }), req.query);
    return listChangeRequests({ pageId: id, statuses: q.status }, user);
  });

  /** "Suggest change": resumes the viewer's unfinished request on the page or starts one. */
  app.post('/pages/:id/change-requests', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { fromDraft } = parse(z.object({ fromDraft: z.boolean().default(false) }), req.body ?? {});
    return startChangeRequest(id, user, { fromDraft });
  });

  app.get('/change-requests', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({
      mine: flag,
      toReview: flag,
      status: statusList,
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }), req.query);
    return listChangeRequests({
      authorId: q.mine ? user.id : undefined, reviewerId: q.toReview ? user.id : undefined, statuses: q.status, limit: q.limit,
    }, user);
  });

  app.get('/change-requests/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    return getChangeRequest(id, user);
  });

  app.put('/change-requests/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      title: z.string().max(TITLE_MAX), body: z.string().max(BODY_MAX), description: z.string().max(5000).optional(),
    }), req.body);
    return saveChangeRequest(id, user, body);
  });

  app.post('/change-requests/:id/submit', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ description: z.string().max(5000).optional(), secretsAcknowledged: z.boolean().optional() }), req.body ?? {});
    const r = await submitChangeRequest(id, user, body);
    if (body.secretsAcknowledged) {
      req.log.info({ event: 'secret_save_anyway', by: user.id, changeRequestId: id }, 'change request submitted despite secret warning');
    }
    return r;
  });

  app.post('/change-requests/:id/comments', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ body: z.string().max(5000), requestChanges: z.boolean().optional() }), req.body);
    return commentOnChangeRequest(id, user, body);
  });

  app.post('/change-requests/:id/approve', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ version: z.number().int().positive(), message: z.string().max(500).optional() }), req.body);
    const r = await approveChangeRequest(id, user, body);
    req.log.info({ event: 'change_request_approved', by: user.id, changeRequestId: id, revisionId: r.revisionId }, 'change request approved');
    return r;
  });

  app.post('/change-requests/:id/reject', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ comment: z.string().max(5000).optional() }), req.body ?? {});
    await rejectChangeRequest(id, user, body);
    return { ok: true };
  });

  app.post('/change-requests/:id/withdraw', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    return withdrawChangeRequest(id, user);
  });

  app.post('/change-requests/:id/update-to-latest', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    return updateToLatest(id, user);
  });

  app.get('/inbox', async (req) => {
    const user = requireUser(req);
    const q = parse(z.object({
      unread: flag,
      before: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }), req.query);
    return listInbox(user.id, { unreadOnly: q.unread, before: q.before, limit: q.limit });
  });

  /** Polled by the bell icon. */
  app.get('/inbox/count', async (req) => {
    const user = requireUser(req);
    const [unread, toReview] = await Promise.all([unreadCount(user.id), countToReview(user)]);
    return { unread, toReview };
  });

  app.post('/inbox/read', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ ids: z.array(z.number().int().positive()).max(500).optional(), all: z.boolean().optional() }), req.body);
    await markRead(user.id, body.all ? 'all' : body.ids ?? []);
    return { ok: true };
  });
}
