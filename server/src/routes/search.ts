import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { idParam, parse } from '../lib/validate.js';
import { availableSearchLanguages, search } from '../lib/search.js';
import { listStale, listTags, markReviewed, normalizeTag, setReviewDate, setTags } from '../lib/review.js';

const csv = z.string().max(2000).optional().transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined));
const flag = z.enum(['1', 'true', '0', 'false', '']).optional().transform((v) => v === '1' || v === 'true');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional().or(z.literal('').transform(() => undefined));

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search', async (req) => {
    requireUser(req);
    const q = parse(z.object({
      q: z.string().max(500).default(''),
      space: csv,
      tag: csv,
      owner: z.coerce.number().int().positive().optional(),
      author: z.coerce.number().int().positive().optional(),
      template: z.string().max(40).optional().or(z.literal('').transform(() => undefined)),
      updatedFrom: dateStr,
      updatedTo: dateStr,
      review: z.enum(['overdue', 'due', 'current', 'none']).optional().or(z.literal('').transform(() => undefined)),
      hasAttachments: flag,
      codeOnly: flag,
      sort: z.enum(['relevance', 'updated']).default('relevance'),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).max(10_000).default(0),
    }), req.query);
    const tags = q.tag?.map(normalizeTag).filter((t): t is string => !!t);
    return search({
      q: q.q, spaces: q.space, tags, owner: q.owner, author: q.author, template: q.template,
      updatedFrom: q.updatedFrom, updatedTo: q.updatedTo, review: q.review, hasAttachments: q.hasAttachments,
      codeOnly: q.codeOnly, sort: q.sort, limit: q.limit, offset: q.offset,
    });
  });

  app.get('/search/languages', async (req) => {
    requireAdmin(req);
    return availableSearchLanguages();
  });

  app.get('/tags', async (req) => {
    requireUser(req);
    const { q } = parse(z.object({ q: z.string().max(40).default('') }), req.query);
    return listTags(q);
  });

  app.put('/pages/:id/tags', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { tags } = parse(z.object({ tags: z.array(z.string().max(100)).max(50) }), req.body);
    return { tags: await setTags(id, user, tags) };
  });

  /** Set or clear the review-by date (owner or admin). */
  app.put('/pages/:id/review', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { reviewBy } = parse(z.object({ reviewBy: z.string().max(10).nullable() }), req.body);
    await setReviewDate(id, user, reviewBy);
    return { ok: true };
  });

  /** Mark as reviewed (owner or admin): records who and when, and moves the review date forward. */
  app.post('/pages/:id/review', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const { nextReviewBy } = parse(z.object({ nextReviewBy: z.string().max(10).nullable().optional() }), req.body ?? {});
    return markReviewed(id, user, nextReviewBy);
  });

  app.get('/stale', async (req) => {
    requireUser(req);
    const q = parse(z.object({
      space: z.string().max(40).optional().or(z.literal('').transform(() => undefined)),
      owner: z.coerce.number().int().positive().optional(),
      includeDue: flag,
      former: flag,
    }), req.query);
    return listStale({ spaceKey: q.space, ownerId: q.owner, includeDue: q.includeDue, formerOwners: q.former });
  });

  /** Everyone's name, for owner/author filters. */
  app.get('/users/directory', async (req) => {
    requireUser(req);
    return db.select({ id: users.id, displayName: users.displayName, active: users.active })
      .from(users).orderBy(asc(users.displayName));
  });
}
