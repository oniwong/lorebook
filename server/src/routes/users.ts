import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { destroyUserSessions, requireAdmin } from '../lib/auth.js';
import { hashPassword, validatePassword } from '../lib/passwords.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, parse } from '../lib/validate.js';

const publicCols = {
  id: users.id, username: users.username, displayName: users.displayName, email: users.email,
  role: users.role, active: users.active, authSource: users.authSource, createdAt: users.createdAt,
};

const usernameRe = /^[a-zA-Z0-9._-]{2,64}$/;

export async function userRoutes(app: FastifyInstance) {
  app.get('/users', async (req) => {
    requireAdmin(req);
    return db.select(publicCols).from(users).orderBy(asc(users.username));
  });

  app.post('/users', async (req) => {
    requireAdmin(req);
    const body = parse(z.object({
      username: z.string().regex(usernameRe, 'Use 2-64 letters, digits, dots, dashes or underscores'),
      displayName: z.string().trim().min(1).max(200),
      email: z.string().email().optional().or(z.literal('')),
      password: z.string(),
      role: z.enum(['user', 'admin']).default('user'),
    }), req.body);
    const problem = validatePassword(body.password);
    if (problem) throw badRequest(problem);
    const [existing] = await db.select({ id: users.id }).from(users)
      .where(sql`lower(${users.username}) = lower(${body.username})`);
    if (existing) throw conflict('That username is taken');
    const [u] = await db.insert(users).values({
      username: body.username, displayName: body.displayName, email: body.email || null,
      passwordHash: await hashPassword(body.password), role: body.role,
    }).returning(publicCols);
    req.log.info({ event: 'user_created', by: req.user!.id, userId: u.id }, 'user created');
    return u;
  });

  app.patch('/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({
      displayName: z.string().trim().min(1).max(200).optional(),
      email: z.string().email().nullable().optional().or(z.literal('')),
      role: z.enum(['user', 'admin']).optional(),
      active: z.boolean().optional(),
      password: z.string().optional(),
    }), req.body);
    const [u] = await db.select().from(users).where(eq(users.id, id));
    if (!u) throw notFound('User not found');
    if (id === admin.id && (body.role === 'user' || body.active === false)) {
      throw badRequest('You cannot demote or disable yourself');
    }
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.email !== undefined) patch.email = body.email || null;
    if (body.role !== undefined) patch.role = body.role;
    if (body.active !== undefined) patch.active = body.active;
    if (body.password !== undefined) {
      if (u.authSource !== 'local') throw badRequest('Only local accounts have a password here');
      const problem = validatePassword(body.password);
      if (problem) throw badRequest(problem);
      patch.passwordHash = await hashPassword(body.password);
      patch.failedLogins = 0;
      patch.lastFailedLoginAt = null;
    }
    if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');
    const [updated] = await db.update(users).set(patch).where(eq(users.id, id)).returning(publicCols);
    if (body.active === false || body.password !== undefined || body.role !== undefined) {
      await destroyUserSessions(id);
    }
    req.log.info({ event: 'user_updated', by: admin.id, userId: id, fields: Object.keys(patch) }, 'user updated');
    return updated;
  });
}
