import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pages, spaces } from '../db/schema.js';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { checkoutIsLive } from '../lib/pages.js';
import { deleteSpace } from '../lib/tree.js';

const keyRe = /^[a-z0-9][a-z0-9-]{1,31}$/;
const keyParam = z.object({ key: z.string() });

export async function getSpaceByKey(key: string) {
  const [s] = await db.select().from(spaces).where(eq(spaces.key, key.toLowerCase()));
  if (!s) throw notFound('Space not found');
  return s;
}

export async function spaceRoutes(app: FastifyInstance) {
  app.get('/spaces', async (req) => {
    requireUser(req);
    return db
      .select({
        id: spaces.id, key: spaces.key, name: spaces.name, description: spaces.description,
        pageCount: sql<number>`(select count(*)::int from pages p where p.space_id = ${spaces.id} and p.deleted_at is null)`,
      })
      .from(spaces)
      .orderBy(asc(spaces.name));
  });

  app.post('/spaces', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(z.object({
      key: z.string().trim().toLowerCase().regex(keyRe, 'Use 2-32 lowercase letters, digits or dashes'),
      name: z.string().trim().min(1).max(100),
      description: z.string().max(1000).default(''),
    }), req.body);
    const [existing] = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.key, body.key));
    if (existing) throw conflict('A Space with that key already exists');
    const [s] = await db.insert(spaces).values({ ...body, createdBy: admin.id }).returning();
    return s;
  });

  app.get('/spaces/:key', async (req) => {
    requireUser(req);
    const { key } = parse(keyParam, req.params);
    return getSpaceByKey(key);
  });

  app.patch('/spaces/:key', async (req) => {
    requireAdmin(req);
    const { key } = parse(keyParam, req.params);
    const s = await getSpaceByKey(key);
    const body = parse(z.object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().max(1000).optional(),
    }), req.body);
    const [updated] = await db.update(spaces).set(body).where(eq(spaces.id, s.id)).returning();
    return updated;
  });

  app.delete('/spaces/:key', async (req) => {
    const admin = requireAdmin(req);
    const { key } = parse(keyParam, req.params);
    const s = await getSpaceByKey(key);
    await deleteSpace(s.id);
    req.log.info({ event: 'space_deleted', by: admin.id, spaceId: s.id, key: s.key }, 'space deleted');
    return { ok: true };
  });

  /** The whole page tree of a Space as a flat list, ordered for display. */
  app.get('/spaces/:key/tree', async (req) => {
    requireUser(req);
    const { key } = parse(keyParam, req.params);
    const s = await getSpaceByKey(key);
    const rows = await db
      .select({
        id: pages.id, parentId: pages.parentId, position: pages.position, title: pages.title, slug: pages.slug,
        checkedOutBy: pages.checkedOutBy, checkoutHeartbeatAt: pages.checkoutHeartbeatAt,
      })
      .from(pages)
      .where(and(eq(pages.spaceId, s.id), isNull(pages.deletedAt)))
      .orderBy(asc(pages.parentId), asc(pages.position), asc(pages.id));
    return {
      space: { id: s.id, key: s.key, name: s.name, description: s.description },
      pages: rows.map(({ checkedOutBy, checkoutHeartbeatAt, ...r }) => ({
        ...r,
        checkedOut: checkoutIsLive({ checkedOutBy, checkoutHeartbeatAt }),
      })),
    };
  });
}
