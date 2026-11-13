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
  del: (url: string) => Promise<{ status: number; json: any }>;
  upload: (pageId: number, filename: string, data: Buffer | string) => Promise<{ status: number; json: any }>;
  raw: (url: string) => Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>;
};

export async function login(app: FastifyInstance, username: string, password = PASSWORD): Promise<Client> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'lorebook_session')!;
  const cookies = { lorebook_session: cookie.value };
  const s = await app.inject({ method: 'GET', url: '/api/v1/auth/session', cookies });
  const csrf = s.json().csrfToken as string;
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') => async (url: string, body?: unknown) => {
    const r = await app.inject({
      method, url, cookies, headers: { 'x-csrf-token': csrf },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: r.statusCode, json: r.body ? r.json() : null };
  };
  const upload = async (pageId: number, filename: string, data: Buffer | string) => {
    const r = await app.inject({
      method: 'POST', url: `/api/v1/pages/${pageId}/attachments?filename=${encodeURIComponent(filename)}`, cookies,
      headers: { 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }, payload: data,
    });
    return { status: r.statusCode, json: r.body ? r.json() : null };
  };
  const raw = async (url: string) => {
    const r = await app.inject({ method: 'GET', url, cookies });
    return { status: r.statusCode, headers: r.headers as Record<string, unknown>, body: r.rawPayload };
  };
  return { get: call('GET'), post: call('POST'), put: call('PUT'), patch: call('PATCH'), del: call('DELETE'), upload, raw };
}

export async function newApp(): Promise<FastifyInstance> {
  return buildApp({ logger: false });
}
