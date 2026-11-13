import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../lib/auth.js';
import { parse } from '../lib/validate.js';
import { getAppSettings, setSetting } from '../lib/settings.js';
import { badRequest } from '../lib/errors.js';
import { availableSearchLanguages, invalidateSearchIndex, reindexPending } from '../lib/search.js';

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
      searchLanguage: z.string().max(63).optional(),
      defaultReviewMonths: z.number().int().min(1).max(120).optional(),
    }), req.body);
    const before = await getAppSettings();
    if (body.searchLanguage !== undefined && !(await availableSearchLanguages()).includes(body.searchLanguage)) {
      throw badRequest(`Unknown search language "${body.searchLanguage}"`);
    }
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined) await setSetting(k, v);
    }
    if (body.searchLanguage !== undefined && body.searchLanguage !== before.searchLanguage) {
      // Rebuild the index with the new language; the housekeeping timer finishes anything left over.
      await invalidateSearchIndex();
      void reindexPending(req.log).catch((e) => req.log.error({ err: e }, 'reindex failed'));
    }
    req.log.info({ event: 'settings_changed', by: admin.id, changes: body }, 'settings changed');
    return getAppSettings();
  });
}
