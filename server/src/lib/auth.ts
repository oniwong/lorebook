import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { config } from '../config.js';
import { forbidden, unauthorized } from './errors.js';

export const SESSION_COOKIE = 'lorebook_session';

export type SessionUser = {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  role: 'user' | 'admin';
  authSource: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
    csrfToken: string | null;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(userId: number): Promise<{ token: string; csrfToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  await db.insert(sessions).values({ id: sha256(token), userId, csrfToken });
  return { token, csrfToken };
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function destroyUserSessions(userId: number): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function purgeIdleSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.lastSeenAt, sql`now() - make_interval(hours => ${config.sessionIdleHours})`));
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    // Browser-side expiry is a backstop; the server enforces the idle timeout.
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Resolves the session cookie into request.user. Touches last_seen_at at most once a minute. */
export async function loadSession(req: FastifyRequest): Promise<void> {
  req.user = null;
  req.sessionId = null;
  req.csrfToken = null;
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const id = sha256(token);
  const rows = await db
    .select({
      sessionId: sessions.id,
      csrfToken: sessions.csrfToken,
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      role: users.role,
      authSource: users.authSource,
      active: users.active,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), sql`${sessions.lastSeenAt} > now() - make_interval(hours => ${config.sessionIdleHours})`));
  const row = rows[0];
  if (!row || !row.active) return;
  if (Date.now() - row.lastSeenAt.getTime() > 60_000) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, id));
  }
  req.sessionId = row.sessionId;
  req.csrfToken = row.csrfToken;
  req.user = {
    id: row.id, username: row.username, displayName: row.displayName, email: row.email,
    role: row.role, authSource: row.authSource,
  };
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role !== 'admin') throw forbidden('Admins only');
  return u;
}

// Login throttling: after FREE_ATTEMPTS consecutive failures, each further attempt must wait
// an exponentially growing delay (capped) since the last failure.
const FREE_ATTEMPTS = 5;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;

export function loginRetryAfterMs(failedLogins: number, lastFailedAt: Date | null, now = Date.now()): number {
  if (failedLogins < FREE_ATTEMPTS || !lastFailedAt) return 0;
  const delay = Math.min(BASE_DELAY_MS * 2 ** (failedLogins - FREE_ATTEMPTS), MAX_DELAY_MS);
  return Math.max(0, lastFailedAt.getTime() + delay - now);
}
