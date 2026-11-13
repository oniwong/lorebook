import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { drafts, pages, revisions, spaces, users } from '../db/schema.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { idParam, parse } from '../lib/validate.js';
import {
  TITLE_MAX, breakCheckout, checkin, checkout, createPage, discard, getPage, heartbeat, listRevisions,
  restoreRevision, saveDraft,
} from '../lib/pages.js';
import { getSpaceByKey } from './spaces.js';

const BODY_MAX = 2 * 1024 * 1024;
const draftBody = z.object({ title: z.string().max(TITLE_MAX), body: z.string().max(BODY_MAX) });

export async function pageRoutes(app: FastifyInstance) {
  app.post('/pages', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({
      spaceKey: z.string(),
      parentId: z.number().int().positive().nullable().default(null),
      title: z.string().max(TITLE_MAX),
      body: z.string().max(BODY_MAX).optional(),
    }), req.body);
    const space = await getSpaceByKey(body.spaceKey);
    return createPage(user, { spaceId: space.id, parentId: body.parentId, title: body.title, body: body.body });
  });

  app.get('/pages/recent', async (req) => {
    requireUser(req);
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
    return db
      .select({
        id: pages.id, title: pages.title, slug: pages.slug, updatedAt: pages.updatedAt,
        spaceKey: spaces.key, spaceName: spaces.name, updatedBy: users.displayName,
      })
      .from(pages)
      .innerJoin(spaces, eq(spaces.id, pages.spaceId))
      .innerJoin(users, eq(users.id, pages.updatedBy))
      .where(isNull(pages.deletedAt))
      .orderBy(desc(pages.updatedAt))
      .limit(limit);
  });

  /** Title lookup for the Ctrl+K quick switcher. */
  app.get('/pages/quick', async (req) => {
    requireUser(req);
    const { q } = parse(z.object({ q: z.string().max(200).default('') }), req.query);
    const term = q.trim();
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return db
      .select({ id: pages.id, title: pages.title, slug: pages.slug, spaceKey: spaces.key, spaceName: spaces.name })
      .from(pages)
      .innerJoin(spaces, eq(spaces.id, pages.spaceId))
      .where(and(isNull(pages.deletedAt), term ? sql`${pages.title} ilike ${like}` : undefined))
      .orderBy(
        term ? sql`case when lower(${pages.title}) = lower(${term}) then 0 when ${pages.title} ilike ${`${term}%`} then 1 else 2 end` : sql`1`,
        desc(pages.updatedAt),
      )
      .limit(15);
  });

  app.get('/pages/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    return getPage(id, user);
  });

  app.post('/pages/:id/checkout', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { fresh } = parse(z.object({ fresh: z.boolean().default(false) }), req.body ?? {});
    return checkout(id, user, { fresh });
  });

  app.post('/pages/:id/heartbeat', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    await heartbeat(id, user);
    return { ok: true };
  });

  app.put('/pages/:id/draft', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    return saveDraft(id, user, parse(draftBody, req.body));
  });

  app.post('/pages/:id/checkin', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(draftBody.extend({ message: z.string().max(500).optional(), overwriteNewer: z.boolean().optional() }), req.body);
    return checkin(id, user, body);
  });

  app.post('/pages/:id/discard', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    await discard(id, user);
    return { ok: true };
  });

  app.post('/pages/:id/break-checkout', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const r = await breakCheckout(id, admin);
    req.log.info({ event: 'checkout_broken', by: admin.id, pageId: id, previousHolder: r.previousHolder }, 'checkout broken');
    return r;
  });

  app.get('/pages/:id/revisions', async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    return listRevisions(id);
  });

  app.get('/pages/:id/revisions/:revId', async (req) => {
    requireUser(req);
    const { id, revId } = parse(idParam.extend({ revId: z.coerce.number().int().positive() }), req.params);
    const [rev] = await db
      .select({
        id: revisions.id, pageId: revisions.pageId, title: revisions.title, body: revisions.body, kind: revisions.kind,
        message: revisions.message, restoredFrom: revisions.restoredFrom, createdAt: revisions.createdAt,
        author: { id: users.id, displayName: users.displayName },
      })
      .from(revisions)
      .innerJoin(users, eq(users.id, revisions.authorId))
      .where(and(eq(revisions.id, revId), eq(revisions.pageId, id)));
    if (!rev) throw notFound('Revision not found');
    return rev;
  });

  app.post('/pages/:id/revisions/:revId/restore', async (req) => {
    const user = requireUser(req);
    const { id, revId } = parse(idParam.extend({ revId: z.coerce.number().int().positive() }), req.params);
    return restoreRevision(id, revId, user);
  });

  app.get('/me/drafts', async (req) => {
    const user = requireUser(req);
    return db
      .select({
        pageId: drafts.pageId, title: drafts.title, status: drafts.status, updatedAt: drafts.updatedAt,
        stale: sql<boolean>`${drafts.baseRevisionId} <> ${pages.currentRevisionId}`,
        slug: pages.slug, spaceKey: spaces.key, spaceName: spaces.name,
      })
      .from(drafts)
      .innerJoin(pages, eq(pages.id, drafts.pageId))
      .innerJoin(spaces, eq(spaces.id, pages.spaceId))
      .where(and(eq(drafts.userId, user.id), isNull(pages.deletedAt)))
      .orderBy(desc(drafts.updatedAt));
  });
}
