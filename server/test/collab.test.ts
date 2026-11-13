import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { rm } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { pages } from '../src/db/schema.js';
import { expireCheckouts } from '../src/lib/pages.js';
import { sweepInbox } from '../src/lib/inbox.js';
import { login, makeUser, newApp, resetDb, type Client } from './helpers.js';

let app: FastifyInstance;
let admin: Client;
let anna: Client;
let bob: Client;
let carol: Client;
let annaId: number;
let bobId: number;
let carolId: number;

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
  annaId = (await makeUser('anna')).id;
  bobId = (await makeUser('bob')).id;
  carolId = (await makeUser('carol')).id;
  admin = await login(app, 'admin');
  anna = await login(app, 'anna');
  bob = await login(app, 'bob');
  carol = await login(app, 'carol');
  await admin.post('/api/v1/spaces', { key: 'net', name: 'Network' });
});

async function page(c: Client, title: string, body = 'Original text.\n\nSecond paragraph.\n') {
  const r = await c.post('/api/v1/pages', { spaceKey: 'net', title, body });
  expect(r.status).toBe(200);
  return r.json.id as number;
}

async function edit(c: Client, id: number, body: string) {
  const co = await c.post(`/api/v1/pages/${id}/checkout`, {});
  expect(co.status).toBe(200);
  const r = await c.post(`/api/v1/pages/${id}/checkin`, { title: co.json.title, body });
  expect(r.status).toBe(200);
  return r;
}

async function inbox(c: Client) {
  const r = await c.get('/api/v1/inbox');
  expect(r.status).toBe(200);
  return r.json as any[];
}

/** Starts a request, writes `body` into it and submits it. */
async function suggest(c: Client, pageId: number, body: string, description = 'Fix it') {
  const start = await c.post(`/api/v1/pages/${pageId}/change-requests`, {});
  expect(start.status).toBe(200);
  const id = start.json.id as number;
  const cr = (await c.get(`/api/v1/change-requests/${id}`)).json;
  expect((await c.put(`/api/v1/change-requests/${id}`, { title: cr.title, body })).status).toBe(200);
  const sub = await c.post(`/api/v1/change-requests/${id}/submit`, { description });
  expect(sub.status).toBe(200);
  return id;
}

describe('locking', () => {
  it('lets only the owner or an admin lock, and then only they can edit directly', async () => {
    const id = await page(anna, 'Firewall runbook');
    expect((await bob.post(`/api/v1/pages/${id}/lock`, { locked: true })).status).toBe(403);
    expect((await anna.post(`/api/v1/pages/${id}/lock`, { locked: true })).json).toEqual({ locked: true });

    const view = (await bob.get(`/api/v1/pages/${id}`)).json;
    expect(view).toMatchObject({ locked: true, canEdit: false, lock: { by: { id: annaId } } });
    const co = await bob.post(`/api/v1/pages/${id}/checkout`, {});
    expect(co.status).toBe(403);
    expect(co.json.details.code).toBe('locked');
    expect((await bob.post(`/api/v1/pages/${id}/revisions/1/restore`)).status).toBe(403);
    expect((await bob.del(`/api/v1/pages/${id}`)).status).toBe(403);

    expect((await anna.post(`/api/v1/pages/${id}/checkout`, {})).status).toBe(200);
    await anna.post(`/api/v1/pages/${id}/discard`);
    expect((await admin.post(`/api/v1/pages/${id}/checkout`, {})).status).toBe(200);
    await admin.post(`/api/v1/pages/${id}/discard`);

    // An admin unlocking tells the owner.
    expect((await admin.post(`/api/v1/pages/${id}/lock`, { locked: false })).status).toBe(200);
    expect((await inbox(anna)).map((i) => i.kind)).toContain('page_unlocked');
    expect((await bob.post(`/api/v1/pages/${id}/checkout`, {})).status).toBe(200);
  });

  it("refuses to lock while someone else has the page checked out", async () => {
    const id = await page(anna, 'Busy');
    await bob.post(`/api/v1/pages/${id}/checkout`, {});
    const r = await anna.post(`/api/v1/pages/${id}/lock`, { locked: true });
    expect(r.status).toBe(409);
    expect(r.json.details.code).toBe('checked_out');
  });

  it('shows locks in the tree and keeps attachments removable only by the owner', async () => {
    const id = await page(anna, 'Locked with files');
    const up = await bob.upload(id, 'notes.txt', 'hello');
    expect(up.status).toBe(200);
    await anna.post(`/api/v1/pages/${id}/lock`, { locked: true });
    const tree = (await bob.get('/api/v1/spaces/net/tree')).json;
    expect(tree.pages[0].locked).toBe(true);
    expect((await bob.upload(id, 'more.txt', 'more')).status).toBe(200);
    expect((await bob.del(`/api/v1/attachments/${up.json.id}`)).status).toBe(403);
    expect((await anna.del(`/api/v1/attachments/${up.json.id}`)).status).toBe(200);
  });
});

describe('change requests', () => {
  it('runs the whole review loop: submit, ask for changes, resubmit, approve', async () => {
    const id = await page(anna, 'VPN runbook');
    await anna.post(`/api/v1/pages/${id}/lock`, { locked: true });

    const start = await bob.post(`/api/v1/pages/${id}/change-requests`, {});
    expect(start.json.created).toBe(true);
    const crId = start.json.id;
    // Starting again resumes the same one.
    expect((await bob.post(`/api/v1/pages/${id}/change-requests`, {})).json).toEqual({ id: crId, created: false });
    // Drafts are private.
    expect((await anna.get(`/api/v1/change-requests/${crId}`)).status).toBe(404);
    expect((await anna.get(`/api/v1/pages/${id}/change-requests`)).json).toHaveLength(0);

    // No changes yet.
    const empty = await bob.post(`/api/v1/change-requests/${crId}/submit`, {});
    expect(empty.status).toBe(400);
    expect(empty.json.details.code).toBe('no_changes');

    await bob.put(`/api/v1/change-requests/${crId}`, { title: 'VPN runbook', body: 'Better text.\n\nSecond paragraph.\n' });
    expect((await bob.post(`/api/v1/change-requests/${crId}/submit`, { description: 'Clearer intro' })).status).toBe(200);

    const items = await inbox(anna);
    expect(items[0]).toMatchObject({ kind: 'cr_submitted', changeRequestId: crId, actor: { id: bobId }, page: { id: id } });
    expect((await anna.get('/api/v1/inbox/count')).json).toEqual({ unread: 1, toReview: 1 });

    let cr = (await anna.get(`/api/v1/change-requests/${crId}`)).json;
    expect(cr).toMatchObject({ status: 'open', outdated: false, can: { approve: true, review: true, edit: false } });
    expect(cr.base.body).toBe('Original text.\n\nSecond paragraph.\n');

    // Ask for changes.
    const back = await anna.post(`/api/v1/change-requests/${crId}/comments`, { body: 'Mention the MFA step', requestChanges: true });
    expect(back.json.status).toBe('changes_requested');
    expect((await inbox(bob))[0]).toMatchObject({ kind: 'cr_changes_requested', text: 'Mention the MFA step' });
    const early = await anna.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version });
    expect(early.json.details.code).toBe('not_open');

    await bob.put(`/api/v1/change-requests/${crId}`, { title: 'VPN runbook', body: 'Better text. Approve the MFA prompt.\n\nSecond paragraph.\n' });
    await bob.post(`/api/v1/change-requests/${crId}/submit`, {});
    expect((await inbox(anna))[0].kind).toBe('cr_resubmitted');

    // A stale version can't be approved.
    const stale = await anna.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version });
    expect(stale.status).toBe(409);
    expect(stale.json.details.code).toBe('cr_changed');

    cr = (await anna.get(`/api/v1/change-requests/${crId}`)).json;
    const ok = await anna.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version });
    expect(ok.status).toBe(200);

    const p = (await anna.get(`/api/v1/pages/${id}`)).json;
    expect(p.body).toContain('Approve the MFA prompt');
    expect(p.updatedBy.id).toBe(bobId);
    const [rev] = (await anna.get(`/api/v1/pages/${id}/revisions`)).json;
    expect(rev).toMatchObject({
      kind: 'change_request', author: { id: bobId }, approvedBy: { id: annaId }, changeRequestId: crId, message: 'Clearer intro',
    });
    expect((await inbox(bob))[0]).toMatchObject({ kind: 'cr_approved', actor: { id: annaId } });
    // The owner's items about the request are settled.
    expect((await anna.get('/api/v1/inbox/count')).json).toEqual({ unread: 0, toReview: 0 });
    cr = (await bob.get(`/api/v1/change-requests/${crId}`)).json;
    expect(cr.events.map((e: any) => e.kind)).toEqual(['submitted', 'changes_requested', 'resubmitted', 'approved']);
    // A new suggestion starts a new request.
    expect((await bob.post(`/api/v1/pages/${id}/change-requests`, {})).json.created).toBe(true);
  });

  it('marks requests outdated and merges them onto the latest version', async () => {
    const id = await page(anna, 'Merge me', 'Line one.\n\nLine two.\n\nLine three.\n');
    const crId = await suggest(bob, id, 'Line one, by Bob.\n\nLine two.\n\nLine three.\n');
    await edit(anna, id, 'Line one.\n\nLine two.\n\nLine three, by Anna.\n');

    let cr = (await anna.get(`/api/v1/change-requests/${crId}`)).json;
    expect(cr.outdated).toBe(true);
    expect((await inbox(bob)).map((i) => i.kind)).toContain('cr_outdated');
    const blocked = await anna.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version });
    expect(blocked.json.details.code).toBe('cr_outdated');
    expect((await bob.post(`/api/v1/change-requests/${crId}/update-to-latest`)).status).toBe(200);
    cr = (await anna.get(`/api/v1/change-requests/${crId}`)).json;
    expect(cr.outdated).toBe(false);
    expect(cr.body).toBe('Line one, by Bob.\n\nLine two.\n\nLine three, by Anna.\n');
    expect((await anna.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version })).status).toBe(200);
  });

  it('keeps conflicting edits between markers until the requester resolves them', async () => {
    const id = await page(anna, 'Conflict', 'Port 443.\n');
    const crId = await suggest(bob, id, 'Port 8443.\n');
    await edit(anna, id, 'Port 4443.\n');
    const up = await bob.post(`/api/v1/change-requests/${crId}/update-to-latest`);
    expect(up.json).toMatchObject({ conflicts: 1, changed: true });
    let cr = (await bob.get(`/api/v1/change-requests/${crId}`)).json;
    expect(cr.hasConflicts).toBe(true);
    // Still open, but approval refuses the markers.
    const a = await anna.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version });
    expect(a.json.details.code).toBe('conflict_markers');
    await bob.put(`/api/v1/change-requests/${crId}`, { title: cr.title, body: 'Port 8443.\n' });
    cr = (await anna.get(`/api/v1/change-requests/${crId}`)).json;
    expect((await anna.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version })).status).toBe(200);
  });

  it("can't be approved while the page is checked out, or by its author", async () => {
    const id = await page(anna, 'Busy page');
    const crId = await suggest(bob, id, 'Changed.\n');
    await carol.post(`/api/v1/pages/${id}/checkout`, {});
    const cr = (await anna.get(`/api/v1/change-requests/${crId}`)).json;
    const r = await anna.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version });
    expect(r.status).toBe(409);
    expect(r.json.details.code).toBe('checked_out');
    expect((await bob.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version })).status).toBe(403);
    expect((await carol.post(`/api/v1/change-requests/${crId}/approve`, { version: cr.version })).status).toBe(403);
  });

  it('can be rejected with a comment, or withdrawn', async () => {
    const id = await page(anna, 'Reject me');
    const crId = await suggest(bob, id, 'Nope.\n');
    expect((await anna.post(`/api/v1/change-requests/${crId}/reject`, { comment: 'Not accurate' })).status).toBe(200);
    expect((await inbox(bob))[0]).toMatchObject({ kind: 'cr_rejected', text: 'Not accurate' });
    expect((await bob.put(`/api/v1/change-requests/${crId}`, { title: 'x', body: 'y' })).status).toBe(409);

    const cr2 = await suggest(carol, id, 'Another.\n');
    expect((await carol.post(`/api/v1/change-requests/${cr2}/withdraw`)).json).toEqual({ deleted: false });
    expect((await inbox(anna)).map((i) => i.kind)).toContain('cr_withdrawn');
    expect((await anna.get('/api/v1/inbox/count')).json.toReview).toBe(0);

    // Withdrawing a draft deletes it.
    const d = (await carol.post(`/api/v1/pages/${id}/change-requests`, {})).json.id;
    expect((await carol.post(`/api/v1/change-requests/${d}/withdraw`)).json).toEqual({ deleted: true });
    expect((await carol.get(`/api/v1/change-requests/${d}`)).status).toBe(404);
  });

  it("isn't for the page owner, and lists mine and to-review", async () => {
    const id = await page(anna, 'Mine');
    const own = await anna.post(`/api/v1/pages/${id}/change-requests`, {});
    expect(own.json.details.code).toBe('own_page');
    const crId = await suggest(bob, id, 'Changed.\n');
    expect((await bob.get('/api/v1/change-requests?mine=1')).json.map((c: any) => c.id)).toEqual([crId]);
    expect((await anna.get('/api/v1/change-requests?toReview=1')).json.map((c: any) => c.id)).toEqual([crId]);
    expect((await carol.get('/api/v1/change-requests?toReview=1')).json).toHaveLength(0);
    expect((await anna.get(`/api/v1/pages/${id}`)).json.changeRequests).toEqual({ open: 1, mineId: null });
    expect((await bob.get(`/api/v1/pages/${id}`)).json.changeRequests).toEqual({ open: 1, mineId: crId });
  });

  it('enforces required sections and warns about secrets on submit', async () => {
    const r = await anna.post('/api/v1/pages', { spaceKey: 'net', title: 'How', template: 'howto', body: '## Goal\n\nDo it.\n\n## Steps\n\n1. Go\n' });
    const id = r.json.id;
    const crId = (await bob.post(`/api/v1/pages/${id}/change-requests`, {})).json.id;
    await bob.put(`/api/v1/change-requests/${crId}`, { title: 'How', body: '## Goal\n\nDo it better.\n' });
    const miss = await bob.post(`/api/v1/change-requests/${crId}/submit`, {});
    expect(miss.json.details).toMatchObject({ code: 'missing_sections', missing: ['Steps'] });
    await bob.put(`/api/v1/change-requests/${crId}`, { title: 'How', body: '## Goal\n\nDo it.\n\n## Steps\n\n1. Go\n2. password = "Tr0ub4dor&3xyz"\n' });
    const sec = await bob.post(`/api/v1/change-requests/${crId}/submit`, {});
    expect(sec.json.details.code).toBe('possible_secrets');
    expect((await bob.post(`/api/v1/change-requests/${crId}/submit`, { secretsAcknowledged: true })).status).toBe(200);
  });

  it('turns a waiting check-out draft into a change request after the page was locked', async () => {
    const id = await page(anna, 'Draft first');
    await bob.post(`/api/v1/pages/${id}/checkout`, {});
    await bob.put(`/api/v1/pages/${id}/draft`, { title: 'Draft first', body: 'Bob was here.\n' });
    await db.update(pages).set({ checkoutHeartbeatAt: sql`now() - interval '3 hours'` }).where(eq(pages.id, id));
    await anna.post(`/api/v1/pages/${id}/lock`, { locked: true });
    const r = await bob.post(`/api/v1/pages/${id}/change-requests`, { fromDraft: true });
    const cr = (await bob.get(`/api/v1/change-requests/${r.json.id}`)).json;
    expect(cr).toMatchObject({ status: 'draft', body: 'Bob was here.\n' });
    expect((await bob.get('/api/v1/me/drafts')).json).toHaveLength(0);
  });
});

describe('owners and admins', () => {
  it('lets admins review when the owner has left, and reassign the owner', async () => {
    const id = await page(anna, 'Orphaned');
    await admin.patch(`/api/v1/users/${annaId}`, { active: false });
    const crId = await suggest(bob, id, 'Changed.\n');
    expect((await inbox(admin)).map((i) => i.kind)).toContain('cr_submitted');
    expect((await admin.get('/api/v1/change-requests?toReview=1')).json.map((c: any) => c.id)).toEqual([crId]);

    await sweepInbox();
    expect((await inbox(admin)).map((i) => i.kind)).toContain('former_owner');
    await sweepInbox();
    expect((await inbox(admin)).filter((i) => i.kind === 'former_owner')).toHaveLength(1);

    expect((await bob.post(`/api/v1/pages/${id}/owner`, { userId: carolId })).status).toBe(403);
    expect((await admin.post(`/api/v1/pages/${id}/owner`, { userId: annaId })).status).toBe(400);
    expect((await admin.post(`/api/v1/pages/${id}/owner`, { userId: carolId })).json).toEqual({ count: 1 });
    expect((await carol.get(`/api/v1/pages/${id}`)).json.owner.id).toBe(carolId);
    const carolItems = (await inbox(carol)).map((i) => i.kind);
    expect(carolItems).toEqual(expect.arrayContaining(['owner_assigned', 'cr_submitted']));
    expect((await carol.get('/api/v1/change-requests?toReview=1')).json).toHaveLength(1);
    const formerItem = (await inbox(admin)).find((i) => i.kind === 'former_owner');
    expect(formerItem.readAt).not.toBeNull();
  });

  it("reassigns all of a former user's pages at once", async () => {
    await page(anna, 'A1');
    await page(anna, 'A2');
    await page(bob, 'B1');
    const r = await admin.post(`/api/v1/users/${annaId}/reassign-pages`, { toUserId: carolId });
    expect(r.json).toEqual({ count: 2 });
  });
});

describe('inbox', () => {
  it('tells people about broken and expired check-outs', async () => {
    const a = await page(anna, 'Broken');
    await bob.post(`/api/v1/pages/${a}/checkout`, {});
    await admin.post(`/api/v1/pages/${a}/break-checkout`);
    const b = await page(anna, 'Expired');
    await bob.post(`/api/v1/pages/${b}/checkout`, {});
    await db.update(pages).set({ checkoutHeartbeatAt: sql`now() - interval '3 hours'` }).where(eq(pages.id, b));
    await expireCheckouts();
    const items = await inbox(bob);
    expect(items.map((i) => [i.kind, i.page.title])).toEqual([['checkout_expired', 'Expired'], ['checkout_broken', 'Broken']]);
    expect(items[1].actor.displayName).toBe('Admin');
  });

  it('reminds owners about reviews once per date, and clears them when reviewed', async () => {
    const id = await page(anna, 'Due soon');
    await db.update(pages).set({ reviewBy: sql`current_date - 1` }).where(eq(pages.id, id));
    await sweepInbox();
    await sweepInbox();
    let items = await inbox(anna);
    expect(items.filter((i) => i.kind === 'review_overdue')).toHaveLength(1);
    expect((await anna.post(`/api/v1/pages/${id}/review`, {})).status).toBe(200);
    items = await inbox(anna);
    expect(items[0].readAt).not.toBeNull();
  });

  it('marks items read one by one or all at once', async () => {
    const id = await page(anna, 'Readme');
    await suggest(bob, id, 'One.\n');
    await suggest(carol, id, 'Two.\n');
    const items = await inbox(anna);
    expect(items).toHaveLength(2);
    await anna.post('/api/v1/inbox/read', { ids: [items[0].id] });
    expect((await anna.get('/api/v1/inbox/count')).json.unread).toBe(1);
    expect((await anna.get('/api/v1/inbox?unread=1')).json).toHaveLength(1);
    // Can't touch someone else's items.
    await bob.post('/api/v1/inbox/read', { ids: [items[1].id] });
    expect((await anna.get('/api/v1/inbox/count')).json.unread).toBe(1);
    await anna.post('/api/v1/inbox/read', { all: true });
    expect((await anna.get('/api/v1/inbox/count')).json.unread).toBe(0);
  });
});
