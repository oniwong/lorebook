import type { FastifyInstance } from 'fastify';
import { statfs, access, constants } from 'node:fs/promises';
import { pool } from '../db/index.js';
import { config } from '../config.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      await pool.query('select 1');
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, detail: (e as Error).message };
    }
    try {
      await access(config.dataDir, constants.W_OK);
      const s = await statfs(config.dataDir);
      const free = s.bavail * s.bsize;
      checks.disk = {
        ok: free >= config.minFreeDiskBytes,
        detail: `${Math.round(free / 1024 / 1024)} MB free in ${config.dataDir}`,
      };
    } catch (e) {
      checks.disk = { ok: false, detail: `${config.dataDir} not writable: ${(e as Error).message}` };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.status(ok ? 200 : 503).send({ ok, checks });
  });
}
