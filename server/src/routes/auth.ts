import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, sessions } from '../db/schema.js';
import {
  clearSessionCookie, createSession, destroySession, loginRetryAfterMs, requireUser, setSessionCookie,
} from '../lib/auth.js';
import { dummyHash, hashPassword, validatePassword, verifyPassword } from '../lib/passwords.js';
import { HttpError, badRequest, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

const loginBody = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(1024) });

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const { username, password } = parse(loginBody, req.body);
    const [u] = await db.select().from(users).where(sql`lower(${users.username}) = lower(${username.trim()})`);
    if (!u || !u.passwordHash || u.authSource !== 'local') {
      await verifyPassword(await dummyHash(), password);
      req.log.info({ event: 'login_failed', username }, 'login failed: unknown user');
      throw unauthorized('Wrong username or password');
    }
    const wait = loginRetryAfterMs(u.failedLogins, u.lastFailedLoginAt);
    if (wait > 0) {
      reply.header('Retry-After', Math.ceil(wait / 1000));
      throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`);
    }
    const ok = await verifyPassword(u.passwordHash, password);
    if (!ok || !u.active) {
      if (!ok) {
        await db.update(users)
          .set({ failedLogins: sql`${users.failedLogins} + 1`, lastFailedLoginAt: new Date() })
          .where(eq(users.id, u.id));
      }
      req.log.info({ event: 'login_failed', username, userId: u.id }, 'login failed');
      throw unauthorized(ok ? 'This account is disabled' : 'Wrong username or password');
    }
    await db.update(users).set({ failedLogins: 0, lastFailedLoginAt: null }).where(eq(users.id, u.id));
    const { token } = await createSession(u.id);
    setSessionCookie(reply, token);
    req.log.info({ event: 'login', userId: u.id }, 'login');
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionId) await destroySession(req.sessionId);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/session', async (req) => {
    const user = requireUser(req);
    const [row] = await db.select({ prefs: users.prefs }).from(users).where(eq(users.id, user.id));
    return { user, csrfToken: req.csrfToken, prefs: row?.prefs ?? {} };
  });

  app.post('/me/password', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    if (u.authSource !== 'local' || !u.passwordHash) throw badRequest('Your password is managed elsewhere');
    if (!(await verifyPassword(u.passwordHash, body.currentPassword))) throw badRequest('Current password is wrong');
    const problem = validatePassword(body.newPassword);
    if (problem) throw badRequest(problem);
    await db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, user.id));
    // Sign out every other session for this user.
    await db.delete(sessions).where(sql`${sessions.userId} = ${user.id} and ${sessions.id} <> ${req.sessionId}`);
    return { ok: true };
  });

  app.put('/me/prefs', async (req) => {
    const user = requireUser(req);
    const prefs = parse(z.record(z.string(), z.unknown()), req.body);
    if (JSON.stringify(prefs).length > 64 * 1024) throw badRequest('Preferences are too large');
    await db.update(users).set({ prefs }).where(eq(users.id, user.id));
    return { ok: true };
  });
}
