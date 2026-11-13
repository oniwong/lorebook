import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth.js';
import { idParam, parse } from '../lib/validate.js';
import { listTrash, purgeFromTrash, restoreFromTrash } from '../lib/tree.js';
import { getSpaceByKey } from './spaces.js';

export async function trashRoutes(app: FastifyInstance) {
  app.get('/trash', async (req) => {
    requireAdmin(req);
    const { q } = parse(z.object({ q: z.string().max(200).optional() }), req.query);
    return listTrash({ q });
  });

  app.post('/trash/:id/restore', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      spaceKey: z.string().optional(),
      parentId: z.number().int().positive().nullable().default(null),
    }), req.body ?? {});
    const target = body.spaceKey ? { spaceId: (await getSpaceByKey(body.spaceKey)).id, parentId: body.parentId } : undefined;
    const r = await restoreFromTrash(id, admin, target);
    req.log.info({ event: 'page_restored', by: admin.id, pageId: id }, 'page restored from trash');
    return r;
  });

  app.post('/trash/:id/purge', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const r = await purgeFromTrash(id, admin);
    req.log.info({ event: 'page_purged', by: admin.id, pageId: id, count: r.count }, 'page purged from trash');
    return r;
  });
}
