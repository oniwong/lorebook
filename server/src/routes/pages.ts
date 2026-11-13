import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { drafts, pageLinks, pages, revisions, spaces, users } from '../db/schema.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { idParam, parse } from '../lib/validate.js';
import {
  TITLE_MAX, breakCheckout, checkin, checkout, createPage, discard, getPage, heartbeat, listRevisions,
  purgeRevision, restoreRevision, saveDraft, setPageTemplate,
} from '../lib/pages.js';
import { normalizeTags } from '../lib/review.js';
import { movePage, subtreeCount, trashPage } from '../lib/tree.js';
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
      template: z.string().max(40).optional(),
      tags: z.array(z.string().max(100)).max(50).optional(),
    }), req.body);
    const space = await getSpaceByKey(body.spaceKey);
    return createPage(user, {
      spaceId: space.id, parentId: body.parentId, title: body.title, body: body.body, template: body.template,
      tags: body.tags ? normalizeTags(body.tags) : undefined,
    });
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

  /**
   * Title lookup for the Ctrl+K quick switcher: substring matches first (exact, prefix, contains), then
   * close trigram matches so a typo ("vpm") still finds "VPN".
   */
  app.get('/pages/quick', async (req) => {
    requireUser(req);
    const { q } = parse(z.object({ q: z.string().max(200).default('') }), req.query);
    const term = q.trim().toLowerCase();
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const title = sql`lower(${pages.title})`;
    return db
      .select({ id: pages.id, title: pages.title, slug: pages.slug, spaceKey: spaces.key, spaceName: spaces.name })
      .from(pages)
      .innerJoin(spaces, eq(spaces.id, pages.spaceId))
      .where(and(
        isNull(pages.deletedAt),
        term ? sql`(${title} like ${like} or (length(${term}) >= 3 and word_similarity(${term}, ${title}) >= 0.45))` : undefined,
      ))
      .orderBy(
        term ? sql`case when ${title} = ${term} then 0 when ${title} like ${`${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} then 1 when ${title} like ${like} then 2 else 3 end` : sql`1`,
        term ? sql`word_similarity(${term}, ${title}) desc` : sql`1`,
        desc(pages.updatedAt),
      )
      .limit(15);
  });

  /** Which of these page ids are live, with their titles. The page view uses it to mark broken links. */
  app.get('/pages/lookup', async (req) => {
    requireUser(req);
    const { ids } = parse(z.object({ ids: z.string().max(2000).default('') }), req.query);
    const list = [...new Set(ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 2 ** 31))].slice(0, 200);
    if (!list.length) return [];
    return db
      .select({ id: pages.id, title: pages.title, slug: pages.slug, spaceKey: spaces.key, spaceName: spaces.name })
      .from(pages)
      .innerJoin(spaces, eq(spaces.id, pages.spaceId))
      .where(and(inArray(pages.id, list), isNull(pages.deletedAt)));
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
    const body = parse(draftBody.extend({
      message: z.string().max(500).optional(),
      overwriteNewer: z.boolean().optional(),
      secretsAcknowledged: z.boolean().optional(),
      markReviewed: z.boolean().optional(),
    }), req.body);
    const r = await checkin(id, user, body);
    if (r.revisionId && r.secretFindings.length) {
      req.log.info({
        event: 'secret_save_anyway', by: user.id, pageId: id, revisionId: r.revisionId,
        rules: [...new Set(r.secretFindings.map((f) => f.ruleId))],
      }, 'checked in despite secret warning');
    }
    return { revisionId: r.revisionId };
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
        secretFindings: revisions.secretFindings, secretsAcknowledged: revisions.secretsAcknowledged,
      })
      .from(revisions)
      .innerJoin(users, eq(users.id, revisions.authorId))
      .where(and(eq(revisions.id, revId), eq(revisions.pageId, id)));
    if (!rev) throw notFound('Revision not found');
    return rev;
  });

  /** Admins permanently delete a revision, e.g. one with a leaked secret (spec §5). */
  app.delete('/pages/:id/revisions/:revId', async (req) => {
    const admin = requireAdmin(req);
    const { id, revId } = parse(idParam.extend({ revId: z.coerce.number().int().positive() }), req.params);
    await purgeRevision(id, revId, admin);
    req.log.info({ event: 'revision_purged', by: admin.id, pageId: id, revisionId: revId }, 'revision purged');
    return { ok: true };
  });

  app.post('/pages/:id/revisions/:revId/restore', async (req) => {
    const user = requireUser(req);
    const { id, revId } = parse(idParam.extend({ revId: z.coerce.number().int().positive() }), req.params);
    return restoreRevision(id, revId, user);
  });

  /** Pages that link to this one ("Linked from"). */
  app.get('/pages/:id/backlinks', async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    return db
      .select({ id: pages.id, title: pages.title, slug: pages.slug, spaceKey: spaces.key, spaceName: spaces.name })
      .from(pageLinks)
      .innerJoin(pages, eq(pages.id, pageLinks.fromPageId))
      .innerJoin(spaces, eq(spaces.id, pages.spaceId))
      .where(and(eq(pageLinks.toPageId, id), isNull(pages.deletedAt)))
      .orderBy(asc(pages.title));
  });

  app.post('/pages/:id/template', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { template } = parse(z.object({ template: z.string().max(40) }), req.body);
    await setPageTemplate(id, user, template);
    return { ok: true, template };
  });

  /** How many pages a delete would send to the trash (the page plus its subpages). */
  app.get('/pages/:id/subtree-count', async (req) => {
    requireUser(req);
    const { id } = parse(idParam, req.params);
    return { count: await subtreeCount(id) };
  });

  app.post('/pages/:id/move', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      spaceKey: z.string(),
      parentId: z.number().int().positive().nullable(),
      index: z.number().int().min(0).nullable().optional(),
    }), req.body);
    const space = await getSpaceByKey(body.spaceKey);
    const r = await movePage(id, user, { spaceId: space.id, parentId: body.parentId, index: body.index });
    return { ...r, spaceKey: space.key };
  });

  app.delete('/pages/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const r = await trashPage(id, user);
    req.log.info({ event: 'page_deleted', by: user.id, pageId: id, count: r.count }, 'page moved to trash');
    return r;
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
