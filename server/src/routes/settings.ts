import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { parse } from '../lib/validate.js';
import { getAppSettings, setSetting } from '../lib/settings.js';

export async function settingsRoutes(app: FastifyInstance) {
  // Readable by everyone: the editor shows the upload limit before a large upload starts.
  app.get('/settings', async (req) => {
    requireUser(req);
    return getAppSettings();
  });

  app.patch('/settings', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(z.object({
      uploadMaxMb: z.number().int().min(1).max(1_000_000).nullable().optional(),
    }), req.body);
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) await setSetting(k, v);
    }
    req.log.info({ event: 'settings_changed', by: admin.id, changes: body }, 'settings changed');
    return getAppSettings();
  });
}
