function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

/**
 * Whether the session cookie gets the Secure flag. On by default; COOKIE_SECURE=false (or 0/no/off)
 * turns it off for plain-HTTP testing, where browsers would otherwise drop the cookie and sign-in
 * silently fails. docker-compose.http.yml sets it.
 */
export function parseCookieSecure(v: string | undefined): boolean {
  return !['false', '0', 'no', 'off'].includes((v ?? '').trim().toLowerCase());
}

export const config = {
  port: int('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://lorebook:lorebook@localhost:5432/lorebook',
  baseUrl: process.env.BASE_URL ?? 'https://localhost',
  cookieSecure: parseCookieSecure(process.env.COOKIE_SECURE),
  sessionIdleHours: int('SESSION_IDLE_HOURS', 12),
  checkoutTimeoutMinutes: int('CHECKOUT_TIMEOUT_MINUTES', 120),
  webDist: process.env.WEB_DIST ?? new URL('../../web/dist', import.meta.url).pathname,
  dataDir: process.env.DATA_DIR ?? '/data',
  minFreeDiskBytes: int('MIN_FREE_DISK_MB', 1024) * 1024 * 1024,
  // Hour (0-23, container local time) at which nightly jobs run: trash purge and attachment cleanup.
  nightlyHour: int('NIGHTLY_HOUR', 3),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
