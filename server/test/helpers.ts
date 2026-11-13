import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { db, runMigrations } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/passwords.js';

export const PASSWORD = 'correct horse battery';

export async function resetDb(): Promise<void> {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations();
}

export async function makeUser(username: string, role: 'user' | 'admin' = 'user') {
  const [u] = await db.insert(users).values({
    username, displayName: username[0].toUpperCase() + username.slice(1), passwordHash: await hashPassword(PASSWORD), role,
  }).returning();
  return u;
}

export type Client = {
  get: (url: string) => Promise<{ status: number; json: any }>;
  post: (url: string, body?: unknown) => Promise<{ status: number; json: any }>;
  put: (url: string, body?: unknown) => Promise<{ status: number; json: any }>;
  patch: (url: string, body?: unknown) => Promise<{ status: number; json: any }>;
};

export async function login(app: FastifyInstance, username: string, password = PASSWORD): Promise<Client> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'lorebook_session')!;
  const cookies = { lorebook_session: cookie.value };
  const s = await app.inject({ method: 'GET', url: '/api/v1/auth/session', cookies });
  const csrf = s.json().csrfToken as string;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH') => async (url: string, body?: unknown) => {
    const r = await app.inject({
      method, url, cookies, headers: { 'x-csrf-token': csrf },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: r.statusCode, json: r.body ? r.json() : null };
  };
  return { get: call('GET'), post: call('POST'), put: call('PUT'), patch: call('PATCH') };
}

export async function newApp(): Promise<FastifyInstance> {
  return buildApp({ logger: false });
}
