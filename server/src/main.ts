import { buildApp } from './app.js';
import { config } from './config.js';
import { pool, runMigrations } from './db/index.js';
import { expireCheckouts } from './lib/pages.js';
import { purgeIdleSessions } from './lib/auth.js';
import { maybeRunNightly } from './lib/jobs.js';
import { reindexPending } from './lib/search.js';
import { maybeSweepInbox } from './lib/inbox.js';

async function main() {
  const app = await buildApp();
  const plainHttp = config.baseUrl.toLowerCase().startsWith('http://');
  if (!config.cookieSecure) {
    app.log.warn('COOKIE_SECURE=false: session cookies work over plain HTTP. Use this for testing only, never in production.');
  } else if (plainHttp) {
    app.log.warn('BASE_URL is http:// but session cookies are Secure-only, so browsers will refuse to sign in. Set COOKIE_SECURE=false (docker-compose.http.yml does this) or use HTTPS.');
  }
  try {
    await runMigrations();
  } catch (e) {
    app.log.fatal({ err: e }, 'Database migration failed. Lorebook will not start. Restore the pre-upgrade dump or roll back to the previous image.');
    process.exit(1);
  }

  // Housekeeping: release idle check-outs, purge idle sessions, and once a day the nightly jobs.
  const tick = async () => {
    try {
      const n = await expireCheckouts();
      if (n) app.log.info({ event: 'checkouts_expired', count: n }, 'expired idle check-outs');
      await purgeIdleSessions();
      // Indexes pages and attachments from before milestone 3, or after a search-language change.
      await reindexPending(app.log);
      await maybeSweepInbox();
      await maybeRunNightly(app.log);
    } catch (e) {
      app.log.error({ err: e }, 'housekeeping failed');
    }
  };
  const timer = setInterval(tick, 60_000);
  void tick();

  const shutdown = async () => {
    clearInterval(timer);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: config.host });
}

void main();
