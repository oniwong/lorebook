import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { rm, utimes } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { pages } from '../src/db/schema.js';
import { blobPath, gcAttachments } from '../src/lib/attachments.js';
import { purgeExpiredTrash } from '../src/lib/tree.js';
import { login, makeUser, newApp, resetDb, type Client } from './helpers.js';

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
  await rm('/tmp/lorebook-test-data/attachments', { recursive: true, force: true });
  await makeUser('admin', 'admin');
  await makeUser('anna');
  await makeUser('bob');
  admin = await login(app, 'admin');
  anna = await login(app, 'anna');
  bob = await login(app, 'bob');
  expect((await admin.post('/api/v1/spaces', { key: 'net', name: 'Network' })).status).toBe(200);
  expect((await admin.post('/api/v1/spaces', { key: 'srv', name: 'Servers' })).status).toBe(200);
});

async function page(c: Client, title: string, extra: Record<string, unknown> = {}) {
  const r = await c.post('/api/v1/pages', { spaceKey: 'net', title, ...extra });
  expect(r.status).toBe(200);
  return r.json.id as number;
}

async function edit(c: Client, id: number, body: string, title?: string) {
  const co = await c.post(`/api/v1/pages/${id}/checkout`, {});
  expect(co.status).toBe(200);
  return c.post(`/api/v1/pages/${id}/checkin`, { title: title ?? co.json.title, body });
}

async function tree(key = 'net') {
  return (await anna.get(`/api/v1/spaces/${key}/tree`)).json.pages as { id: number; parentId: number | null; position: number; title: string }[];
}

describe('templates', () => {
  it('ships the built-in templates', async () => {
    const list = (await bob.get('/api/v1/templates')).json;
    expect(list.map((t: any) => t.key)).toEqual(['blank', 'runbook', 'howto', 'architecture']);
    const runbook = list.find((t: any) => t.key === 'runbook');
    expect(runbook.requiredSections).toEqual(['Purpose', 'Prerequisites', 'Steps', 'Verification', 'Rollback', 'Contacts/Escalation']);
    expect(runbook.reviewIntervalMonths).toBe(6);
  });

  it('starts a page from a template and enforces its required sections on check-in', async () => {
    const id = await page(anna, 'Restart DNS', { template: 'howto' });
    const p = (await anna.get(`/api/v1/pages/${id}`)).json;
    expect(p.template).toBe('howto');
    expect(p.templateInfo.requiredSections).toEqual(['Goal', 'Steps']);
    expect(p.body).toContain('## Goal');

    const r = await edit(anna, id, '## Goal\n\nDNS answers again.\n');
    expect(r.status).toBe(422);
    expect(r.json.details).toMatchObject({ code: 'missing_sections', missing: ['Steps'], empty: [] });
    const empty = await anna.post(`/api/v1/pages/${id}/checkin`, { title: 'Restart DNS', body: '## Goal\n\nok\n\n## Steps\n\n<!-- hint -->\n' });
    expect(empty.json.details.empty).toEqual(['Steps']);
    // Still checked out after a refused check-in
    expect((await anna.get(`/api/v1/pages/${id}`)).json.checkout.mine).toBe(true);

    expect((await anna.post(`/api/v1/pages/${id}/checkin`, { title: 'Restart DNS', body: '## Goal\n\nok\n\n## Steps\n\n1. Restart\n' })).status).toBe(200);
  });

  it('lets the owner or an admin switch a page to blank', async () => {
    const id = await page(anna, 'Odd one', { template: 'runbook' });
    expect((await bob.post(`/api/v1/pages/${id}/template`, { template: 'blank' })).status).toBe(403);
    expect((await anna.post(`/api/v1/pages/${id}/template`, { template: 'nope' })).status).toBe(400);
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    expect((await anna.post(`/api/v1/pages/${id}/template`, { template: 'blank' })).status).toBe(200);
    expect((await anna.post(`/api/v1/pages/${id}/checkin`, { title: 'Odd one', body: 'just notes' })).status).toBe(200);
  });

  it('lets admins add, edit and delete templates', async () => {
    const t = { key: 'postmortem', name: 'Post-mortem', body: '## Impact\n', requiredSections: ['Impact'] };
    expect((await anna.post('/api/v1/templates', t)).status).toBe(403);
    expect((await admin.post('/api/v1/templates', t)).status).toBe(200);
    expect((await admin.post('/api/v1/templates', t)).status).toBe(409);
    const id = await page(anna, 'Outage 12 Nov', { template: 'postmortem' });
    expect((await admin.patch('/api/v1/templates/postmortem', { requiredSections: ['Impact', 'Timeline'] })).status).toBe(200);
    expect((await edit(anna, id, '## Impact\nAll DNS down\n')).json.details.missing).toEqual(['Timeline']);
    await anna.post(`/api/v1/pages/${id}/discard`);
    expect((await admin.patch('/api/v1/templates/blank', { requiredSections: ['X'] })).status).toBe(400);
    expect((await admin.del('/api/v1/templates/runbook')).status).toBe(400);
    expect((await admin.del('/api/v1/templates/postmortem')).json.pagesSwitchedToBlank).toBe(1);
    expect((await anna.get(`/api/v1/pages/${id}`)).json.template).toBe('blank');
  });
});

describe('attachments', () => {
  it('stores uploads once by hash, lists, previews and serves them safely', async () => {
    const id = await page(anna, 'Core switch');
    const cfg = 'hostname core-sw-01\ninterface vlan10\n';
    const up = await anna.upload(id, 'core-sw-01.conf', cfg);
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({ filename: 'core-sw-01.conf', contentType: 'text/plain', size: cfg.length, isText: true });
    const again = await bob.upload(id, 'copy.conf', cfg);
    const [a, b] = (await bob.get(`/api/v1/pages/${id}/attachments`)).json;
    expect(a.filename).toBe('copy.conf');
    expect(b.id).toBe(up.json.id);

    const preview = (await bob.get(`/api/v1/attachment-previews/${up.json.id}`)).json;
    expect(preview.text).toBe(cfg);

    const file = await bob.raw(up.json.url);
    expect(file.status).toBe(200);
    expect(file.body.toString()).toBe(cfg);
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="core-sw-01.conf"/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain('sandbox');

    const svg = await anna.upload(id, 'diagram.drawio.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const img = await bob.raw(svg.json.url);
    expect(img.headers['content-type']).toBe('image/svg+xml');
    expect(img.headers['content-disposition']).toMatch(/^inline/);
    expect(img.headers['content-security-policy']).toContain('sandbox');
    expect((await bob.raw(`${svg.json.url}?download=1`)).headers['content-disposition']).toMatch(/^attachment/);

    // Two rows, one file
    expect(again.json.id).not.toBe(up.json.id);
    expect(existsSync(blobPath(await sha(up.json.id)))).toBe(true);
  });

  it('enforces the admin upload cap', async () => {
    const id = await page(anna, 'Big files');
    expect((await anna.patch('/api/v1/settings', { uploadMaxMb: 1 })).status).toBe(403);
    expect((await admin.patch('/api/v1/settings', { uploadMaxMb: 1 })).json.uploadMaxMb).toBe(1);
    expect((await anna.upload(id, 'big.bin', Buffer.alloc(1024 * 1024 + 1))).status).toBe(413);
    expect((await anna.upload(id, 'ok.bin', Buffer.alloc(1024))).status).toBe(200);
    await admin.patch('/api/v1/settings', { uploadMaxMb: null });
    expect((await anna.upload(id, 'big.bin', Buffer.alloc(1024 * 1024 + 1))).status).toBe(200);
  });

  it('blocks uploads while someone else has the page checked out', async () => {
    const id = await page(anna, 'Busy');
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    expect((await anna.upload(id, 'mine.png', 'x')).status).toBe(200);
    expect((await bob.upload(id, 'theirs.png', 'x')).status).toBe(409);
  });

  it('keeps removed attachments downloadable and only GCs files nothing references', async () => {
    const id = await page(anna, 'GC');
    const up = await anna.upload(id, 'old.txt', 'old content');
    const hash = await sha(up.json.id);
    expect((await anna.del(`/api/v1/attachments/${up.json.id}`)).status).toBe(200);
    expect((await anna.get(`/api/v1/pages/${id}/attachments`)).json).toEqual([]);
    // Old revisions may still link to it
    expect((await anna.raw(up.json.url)).status).toBe(200);
    await backdate(hash);
    expect((await gcAttachments()).removed).toBe(0);
    // Purging the page removes the last reference
    await anna.del(`/api/v1/pages/${id}`);
    await admin.post(`/api/v1/trash/${id}/purge`);
    expect((await gcAttachments()).removed).toBe(1);
    expect(existsSync(blobPath(hash))).toBe(false);
  });
});

async function sha(attachmentId: number): Promise<string> {
  const r = await db.execute<{ sha256: string }>(sql`select sha256 from attachments where id = ${attachmentId}`);
  return r.rows[0].sha256;
}
async function backdate(hash: string) {
  const old = new Date(Date.now() - 2 * 3600_000);
  await utimes(blobPath(hash), old, old);
}

describe('links and backlinks', () => {
  it('tracks links on save and reports backlinks and broken targets', async () => {
    const target = await page(anna, 'DNS servers');
    const other = await page(anna, 'Other');
    const src = await page(bob, 'Failover', { body: `Uses [DNS](/p/${target}) and [gone](/p/99999).` });
    expect((await anna.get(`/api/v1/pages/${target}/backlinks`)).json.map((p: any) => p.id)).toEqual([src]);
    await edit(bob, src, `Now [other](/s/net/p/${other}/other)`);
    expect((await anna.get(`/api/v1/pages/${target}/backlinks`)).json).toEqual([]);
    expect((await anna.get(`/api/v1/pages/${other}/backlinks`)).json.map((p: any) => p.id)).toEqual([src]);
    // Lookup reports only live pages
    await anna.del(`/api/v1/pages/${target}`);
    const live = (await anna.get(`/api/v1/pages/lookup?ids=${target},${other},99999`)).json;
    expect(live.map((p: any) => p.id)).toEqual([other]);
    // Backlinks from trashed pages are hidden
    await bob.del(`/api/v1/pages/${src}`);
    expect((await anna.get(`/api/v1/pages/${other}/backlinks`)).json).toEqual([]);
  });
});

describe('move', () => {
  it('reorders siblings, reparents, and moves subtrees between Spaces', async () => {
    const a = await page(anna, 'A');
    const b = await page(anna, 'B');
    const c = await page(anna, 'C');
    const child = await page(anna, 'A child', { parentId: a });
    // Put C first
    expect((await bob.post(`/api/v1/pages/${c}/move`, { spaceKey: 'net', parentId: null, index: 0 })).status).toBe(200);
    expect((await tree()).filter((p) => p.parentId === null).sort((x, y) => x.position - y.position).map((p) => p.title)).toEqual(['C', 'A', 'B']);
    // Under B
    await bob.post(`/api/v1/pages/${a}/move`, { spaceKey: 'net', parentId: b });
    expect((await tree()).find((p) => p.id === a)!.parentId).toBe(b);
    // Not under itself or its own subpage
    expect((await bob.post(`/api/v1/pages/${a}/move`, { spaceKey: 'net', parentId: child })).status).toBe(400);
    expect((await bob.post(`/api/v1/pages/${a}/move`, { spaceKey: 'net', parentId: a })).status).toBe(400);
    // To another Space, with its subpage
    const r = await bob.post(`/api/v1/pages/${a}/move`, { spaceKey: 'srv', parentId: null });
    expect(r.json.spaceKey).toBe('srv');
    expect((await tree('srv')).map((p) => p.title).sort()).toEqual(['A', 'A child']);
    expect((await bob.get(`/api/v1/pages/${child}`)).json.spaceKey).toBe('srv');
    // Parent must be in the target Space
    expect((await bob.post(`/api/v1/pages/${c}/move`, { spaceKey: 'srv', parentId: b })).status).toBe(400);
  });

  it('is blocked while someone else has a page in the subtree checked out', async () => {
    const a = await page(anna, 'A');
    const child = await page(anna, 'A child', { parentId: a });
    await anna.post(`/api/v1/pages/${child}/checkout`, {});
    const r = await bob.post(`/api/v1/pages/${a}/move`, { spaceKey: 'srv', parentId: null });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/A child.*Anna/);
    expect((await bob.del(`/api/v1/pages/${a}`)).status).toBe(409);
  });
});

describe('trash', () => {
  it('deletes a subtree, hides it, and restores it under the original parent', async () => {
    const root = await page(anna, 'Root');
    const a = await page(anna, 'A', { parentId: root });
    await page(anna, 'A1', { parentId: a });
    expect((await bob.get(`/api/v1/pages/${a}/subtree-count`)).json.count).toBe(2);
    expect((await bob.del(`/api/v1/pages/${a}`)).json.count).toBe(2);
    expect((await bob.get(`/api/v1/pages/${a}`)).status).toBe(404);
    expect((await tree()).map((p) => p.title)).toEqual(['Root']);
    expect((await bob.post(`/api/v1/pages/${a}/checkout`, {})).status).toBe(404);

    expect((await bob.get('/api/v1/trash')).status).toBe(403);
    const trash = (await admin.get('/api/v1/trash')).json;
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ id: a, title: 'A', count: 2, deletedBy: 'Bob', parentTitle: 'Root', parentLive: true });
    expect((await admin.get('/api/v1/trash?q=A1')).json).toHaveLength(1);
    expect((await admin.get('/api/v1/trash?q=zzz')).json).toHaveLength(0);

    expect((await bob.post(`/api/v1/trash/${a}/restore`)).status).toBe(403);
    expect((await admin.post(`/api/v1/trash/${a}/restore`)).json).toMatchObject({ parentId: root });
    expect((await tree()).map((p) => p.title).sort()).toEqual(['A', 'A1', 'Root']);
  });

  it('restores to the Space root when the parent is gone, or to a chosen place', async () => {
    const root = await page(anna, 'Root');
    const a = await page(anna, 'A', { parentId: root });
    await anna.del(`/api/v1/pages/${a}`);
    await anna.del(`/api/v1/pages/${root}`);
    // Restoring the child alone: its parent is in the trash, so it lands at the root
    expect((await admin.post(`/api/v1/trash/${a}/restore`)).json.parentId).toBeNull();
    // Purge the parent; restore elsewhere
    await anna.del(`/api/v1/pages/${a}`);
    expect((await admin.post(`/api/v1/trash/${root}/purge`)).json.count).toBe(1);
    expect((await db.select().from(pages).where(eq(pages.id, a)))[0].parentId).toBeNull();
    const dest = (await anna.post('/api/v1/pages', { spaceKey: 'srv', title: 'Dest' })).json.id;
    expect((await admin.post(`/api/v1/trash/${a}/restore`, { spaceKey: 'srv', parentId: dest })).json).toMatchObject({ parentId: dest });
    expect((await anna.get(`/api/v1/pages/${a}`)).json.spaceKey).toBe('srv');
  });

  it('purges trash older than 30 days, with revisions', async () => {
    const old = await page(anna, 'Old');
    const recent = await page(anna, 'Recent');
    await anna.del(`/api/v1/pages/${old}`);
    await anna.del(`/api/v1/pages/${recent}`);
    await db.update(pages).set({ deletedAt: sql`now() - interval '31 days'` }).where(eq(pages.id, old));
    expect(await purgeExpiredTrash()).toEqual({ groups: 1, pages: 1 });
    expect((await admin.get('/api/v1/trash')).json.map((t: any) => t.id)).toEqual([recent]);
    const revs = await db.execute(sql`select 1 from revisions where page_id = ${old}`);
    expect(revs.rows).toHaveLength(0);
  });

  it('only deletes empty Spaces', async () => {
    const id = await page(anna, 'Only page');
    expect((await admin.del('/api/v1/spaces/net')).status).toBe(409);
    await anna.del(`/api/v1/pages/${id}`);
    const r = await admin.del('/api/v1/spaces/net');
    expect(r.status).toBe(409);
    expect(r.json.details.trashed).toBe(1);
    await admin.post(`/api/v1/trash/${id}/purge`);
    expect((await admin.del('/api/v1/spaces/net')).status).toBe(200);
  });
});
