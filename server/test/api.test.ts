import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { pages } from '../src/db/schema.js';
import { expireCheckouts } from '../src/lib/pages.js';
import { login, makeUser, newApp, resetDb, PASSWORD, type Client } from './helpers.js';

let app: FastifyInstance;
let admin: Client;
let anna: Client;
let bob: Client;

beforeAll(async () => {
  app = await newApp();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  await makeUser('admin', 'admin');
  await makeUser('anna');
  await makeUser('bob');
  admin = await login(app, 'admin');
  anna = await login(app, 'anna');
  bob = await login(app, 'bob');
});

async function makeSpaceAndPage(title = 'DNS failover') {
  expect((await admin.post('/api/v1/spaces', { key: 'net', name: 'Network' })).status).toBe(200);
  const r = await anna.post('/api/v1/pages', { spaceKey: 'net', title, body: '# Hello' });
  expect(r.status).toBe(200);
  return r.json.id as number;
}

describe('auth', () => {
  it('rejects wrong passwords and throttles after repeated failures', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'bob', password: 'nope-nope-nope' } });
      expect(r.statusCode).toBe(401);
    }
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'bob', password: PASSWORD } });
    expect(r.statusCode).toBe(429);
  });

  it('requires a session and a CSRF token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/spaces' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anna', password: PASSWORD } });
    const cookie = res.cookies.find((c) => c.name === 'lorebook_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    const noToken = await app.inject({
      method: 'POST', url: '/api/v1/pages', cookies: { lorebook_session: cookie.value }, payload: { spaceKey: 'x', title: 'y' },
    });
    expect(noToken.statusCode).toBe(403);
  });

  it('rejects cross-origin writes but accepts same-origin ones', async () => {
    const payload = { username: 'anna', password: PASSWORD };
    const evil = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://evil.example', host: 'kb.local' }, payload });
    expect(evil.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'https://kb.local:8443', host: 'kb.local:8443' }, payload });
    expect(ok.statusCode).toBe(200);
    // Plain-HTTP mode: same-origin over http is fine too.
    const http = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://kb.local:8080', host: 'kb.local:8080' }, payload });
    expect(http.statusCode).toBe(200);
  });

  it('sets an HttpOnly session cookie without Secure when COOKIE_SECURE=false', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'anna', password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'lorebook_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBeFalsy();
  });

  it('only lets admins create users and spaces, and enforces password length', async () => {
    expect((await anna.post('/api/v1/spaces', { key: 'net', name: 'Network' })).status).toBe(403);
    expect((await anna.post('/api/v1/users', { username: 'x1', displayName: 'X', password: PASSWORD })).status).toBe(403);
    expect((await admin.post('/api/v1/users', { username: 'carl', displayName: 'Carl', password: 'short' })).status).toBe(400);
    expect((await admin.post('/api/v1/users', { username: 'carl', displayName: 'Carl', password: PASSWORD })).status).toBe(200);
    await login(app, 'carl');
  });

  it('signs a disabled user out', async () => {
    const users = (await admin.get('/api/v1/users')).json as { id: number; username: string }[];
    const annaId = users.find((u) => u.username === 'anna')!.id;
    expect((await admin.patch(`/api/v1/users/${annaId}`, { active: false })).status).toBe(200);
    expect((await anna.get('/api/v1/spaces')).status).toBe(401);
  });
});

describe('pages and tree', () => {
  it('builds a tree with ordered siblings and breadcrumbs', async () => {
    const root = await makeSpaceAndPage('Root');
    const a = (await anna.post('/api/v1/pages', { spaceKey: 'net', parentId: root, title: 'Child A' })).json.id;
    await anna.post('/api/v1/pages', { spaceKey: 'net', parentId: root, title: 'Child B' });
    const grand = (await anna.post('/api/v1/pages', { spaceKey: 'net', parentId: a, title: 'Grandchild' })).json.id;
    const tree = (await bob.get('/api/v1/spaces/net/tree')).json;
    const kids = tree.pages.filter((p: any) => p.parentId === root);
    expect(kids.map((p: any) => [p.title, p.position])).toEqual([['Child A', 0], ['Child B', 1]]);
    const page = (await bob.get(`/api/v1/pages/${grand}`)).json;
    expect(page.breadcrumbs.map((b: any) => b.title)).toEqual(['Root', 'Child A']);
    expect(page.slug).toBe('grandchild');
  });
});

describe('check-out', () => {
  it('lets exactly one person check out at a time', async () => {
    const id = await makeSpaceAndPage();
    const [r1, r2] = await Promise.all([anna.post(`/api/v1/pages/${id}/checkout`, {}), bob.post(`/api/v1/pages/${id}/checkout`, {})]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.json.error).toMatch(/Checked out by/);
  });

  it('autosaves drafts, resumes them, and checks in a new revision', async () => {
    const id = await makeSpaceAndPage();
    expect((await anna.post(`/api/v1/pages/${id}/checkout`, {})).json.body).toBe('# Hello');
    await anna.put(`/api/v1/pages/${id}/draft`, { title: 'DNS failover', body: '# Hello\n\nmore' });
    // Bob can't edit, can't save into Anna's check-out
    expect((await bob.put(`/api/v1/pages/${id}/draft`, { title: 'x', body: 'y' })).status).toBe(409);
    expect((await bob.get(`/api/v1/pages/${id}`)).json.checkout.displayName).toBe('Anna');
    // Reopening resumes the draft
    expect((await anna.post(`/api/v1/pages/${id}/checkout`, {})).json.body).toBe('# Hello\n\nmore');
    const ci = await anna.post(`/api/v1/pages/${id}/checkin`, { title: 'DNS failover v2', body: '# Hello\n\nmore', message: 'add more' });
    expect(ci.status).toBe(200);
    const page = (await bob.get(`/api/v1/pages/${id}`)).json;
    expect(page.checkout).toBeNull();
    expect(page.title).toBe('DNS failover v2');
    expect(page.slug).toBe('dns-failover-v2');
    const revs = (await bob.get(`/api/v1/pages/${id}/revisions`)).json;
    expect(revs.map((r: any) => r.kind)).toEqual(['checkin', 'create']);
    expect(revs[0].message).toBe('add more');
    expect((await anna.get('/api/v1/me/drafts')).json).toEqual([]);
  });

  it('expires idle check-outs and keeps the draft for its owner', async () => {
    const id = await makeSpaceAndPage();
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    await anna.put(`/api/v1/pages/${id}/draft`, { title: 'DNS failover', body: 'anna draft' });
    await db.update(pages).set({ checkoutHeartbeatAt: sql`now() - interval '3 hours'` }).where(eq(pages.id, id));
    expect(await expireCheckouts()).toBe(1);
    expect((await bob.post(`/api/v1/pages/${id}/checkout`, {})).status).toBe(200);
    const drafts = (await anna.get('/api/v1/me/drafts')).json;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe('expired');
  });

  it('takes over an expired check-out even before the sweeper runs', async () => {
    const id = await makeSpaceAndPage();
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    await db.update(pages).set({ checkoutHeartbeatAt: sql`now() - interval '3 hours'` }).where(eq(pages.id, id));
    expect((await bob.post(`/api/v1/pages/${id}/checkout`, {})).status).toBe(200);
    expect((await anna.get('/api/v1/me/drafts')).json[0].status).toBe('expired');
    // Anna's late check-in is refused because Bob now holds it
    expect((await anna.post(`/api/v1/pages/${id}/checkin`, { title: 't', body: 'b' })).status).toBe(409);
  });

  it('lets admins break a check-out, keeping the draft', async () => {
    const id = await makeSpaceAndPage();
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    expect((await bob.post(`/api/v1/pages/${id}/break-checkout`)).status).toBe(403);
    expect((await admin.post(`/api/v1/pages/${id}/break-checkout`)).json.previousHolder).toBeTruthy();
    expect((await anna.get('/api/v1/me/drafts')).json[0].status).toBe('broken');
    expect((await bob.post(`/api/v1/pages/${id}/checkout`, {})).status).toBe(200);
    await bob.post(`/api/v1/pages/${id}/discard`);
    // Anna's open editor must not silently re-take the page
    const r = await anna.put(`/api/v1/pages/${id}/draft`, { title: 'x', body: 'y' });
    expect(r.status).toBe(409);
    expect(r.json.details.code).toBe('checkout_lost');
    // Clicking Edit again resumes her draft
    expect((await anna.post(`/api/v1/pages/${id}/checkout`, {})).status).toBe(200);
    expect((await anna.put(`/api/v1/pages/${id}/draft`, { title: 'x', body: 'y' })).status).toBe(200);
  });

  it('refuses to check in a stale draft over newer work unless confirmed', async () => {
    const id = await makeSpaceAndPage();
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    await anna.put(`/api/v1/pages/${id}/draft`, { title: 'DNS failover', body: 'anna' });
    await db.update(pages).set({ checkoutHeartbeatAt: sql`now() - interval '3 hours'` }).where(eq(pages.id, id));
    await bob.post(`/api/v1/pages/${id}/checkout`, {});
    await bob.post(`/api/v1/pages/${id}/checkin`, { title: 'DNS failover', body: 'bob' });
    // Anna returns; autosave re-takes the free page and reports the draft as stale
    const saved = await anna.put(`/api/v1/pages/${id}/draft`, { title: 'DNS failover', body: 'anna 2' });
    expect(saved.json.stale).toBe(true);
    const r = await anna.post(`/api/v1/pages/${id}/checkin`, { title: 'DNS failover', body: 'anna 2' });
    expect(r.status).toBe(409);
    expect(r.json.details.code).toBe('stale_draft');
    expect((await anna.post(`/api/v1/pages/${id}/checkin`, { title: 'DNS failover', body: 'anna 2', overwriteNewer: true })).status).toBe(200);
  });

  it('discard releases the page and deletes the draft', async () => {
    const id = await makeSpaceAndPage();
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    await anna.post(`/api/v1/pages/${id}/discard`);
    expect((await anna.get('/api/v1/me/drafts')).json).toEqual([]);
    expect((await bob.post(`/api/v1/pages/${id}/checkout`, {})).status).toBe(200);
  });
});

describe('revisions', () => {
  it('restores an old revision as a new revision', async () => {
    const id = await makeSpaceAndPage();
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    await anna.post(`/api/v1/pages/${id}/checkin`, { title: 'DNS failover', body: 'second' });
    const revs = (await bob.get(`/api/v1/pages/${id}/revisions`)).json;
    const first = revs[revs.length - 1].id;
    // Can't restore while someone has it checked out
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    expect((await bob.post(`/api/v1/pages/${id}/revisions/${first}/restore`)).status).toBe(409);
    await anna.post(`/api/v1/pages/${id}/discard`);
    const r = await bob.post(`/api/v1/pages/${id}/revisions/${first}/restore`);
    expect(r.status).toBe(200);
    const page = (await bob.get(`/api/v1/pages/${id}`)).json;
    expect(page.body).toBe('# Hello');
    const after = (await bob.get(`/api/v1/pages/${id}/revisions`)).json;
    expect(after).toHaveLength(3);
    expect(after[0]).toMatchObject({ kind: 'restore', restoredFrom: first });
    const old = (await bob.get(`/api/v1/pages/${id}/revisions/${first}`)).json;
    expect(old.body).toBe('# Hello');
  });
});
