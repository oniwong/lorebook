import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { reindexPending } from '../src/lib/search.js';
import { login, makeUser, newApp, resetDb, type Client } from './helpers.js';

let app: FastifyInstance;
let admin: Client;
let anna: Client;
let bob: Client;
let annaId: number;

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
  await makeUser('bob');
  admin = await login(app, 'admin');
  anna = await login(app, 'anna');
  bob = await login(app, 'bob');
  await admin.post('/api/v1/spaces', { key: 'net', name: 'Network' });
  await admin.post('/api/v1/spaces', { key: 'srv', name: 'Servers' });
});

async function page(c: Client, title: string, body = '', extra: Record<string, unknown> = {}) {
  const r = await c.post('/api/v1/pages', { spaceKey: 'net', title, body, ...extra });
  expect(r.status).toBe(200);
  return r.json.id as number;
}

async function edit(c: Client, id: number, body: string, extra: Record<string, unknown> = {}) {
  const co = await c.post(`/api/v1/pages/${id}/checkout`, {});
  expect(co.status).toBe(200);
  return c.post(`/api/v1/pages/${id}/checkin`, { title: co.json.title, body, ...extra });
}

async function find(c: Client, query: string) {
  const r = await c.get(`/api/v1/search?${query}`);
  expect(r.status).toBe(200);
  return r.json as { total: number; hits: any[] };
}
const titles = (r: { hits: any[] }) => r.hits.map((h) => h.title).sort();

describe('search', () => {
  beforeEach(async () => {
    await page(anna, 'VPN troubleshooting', 'If users cannot connect, restart the gateway on fw-edge-02.\n\n```\nnetsh int ip reset\n```');
    await page(anna, 'Database failover', '## Steps\n\nPromote the replica on srv-db-01 (10.20.30.41).\n\nError `0x80070005` means access denied.');
    await page(bob, 'Printers in Göteborg', 'The office printers use VLAN 40.', { spaceKey: 'srv', tags: ['Printing', 'office'] });
  });

  it('finds words, hostnames, IPs and error codes', async () => {
    expect(titles(await find(bob, 'q=gateway'))).toEqual(['VPN troubleshooting']);
    expect(titles(await find(bob, 'q=srv-db-01'))).toEqual(['Database failover']);
    expect(titles(await find(bob, 'q=db-01'))).toEqual(['Database failover']);
    expect(titles(await find(bob, 'q=10.20.30.41'))).toEqual(['Database failover']);
    expect(titles(await find(bob, 'q=0x80070005'))).toEqual(['Database failover']);
    expect(titles(await find(bob, 'q=goteborg'))).toEqual(['Printers in Göteborg']);
    expect(titles(await find(bob, 'q=nothing-like-this'))).toEqual([]);
  });

  it('supports phrases, exclusion and OR', async () => {
    expect(titles(await find(bob, `q=${encodeURIComponent('"restart the gateway"')}`))).toEqual(['VPN troubleshooting']);
    expect(titles(await find(bob, `q=${encodeURIComponent('"gateway restart"')}`))).toEqual([]);
    expect(titles(await find(bob, `q=${encodeURIComponent('printers -vlan')}`))).toEqual([]);
    expect(titles(await find(bob, `q=${encodeURIComponent('gateway OR replica')}`))).toEqual(['Database failover', 'VPN troubleshooting']);
  });

  it('ranks title matches first and returns snippets, paths and highlights', async () => {
    const r = await find(bob, 'q=printers');
    expect(r.hits[0]).toMatchObject({ title: 'Printers in Göteborg', spaceKey: 'srv', tags: ['office', 'printing'], path: [] });
    expect(r.hits[0].titleHighlights).toEqual([[0, 8]]);
    const snip = r.hits[0].snippet;
    expect(snip.text.slice(...snip.highlights[0])).toBe('printers');
  });

  it('can search only inside code blocks', async () => {
    expect(titles(await find(bob, 'q=reset&codeOnly=1'))).toEqual(['VPN troubleshooting']);
    expect(titles(await find(bob, 'q=gateway&codeOnly=1'))).toEqual([]);
    expect(titles(await find(bob, 'q=0x80070005&codeOnly=1'))).toEqual(['Database failover']);
  });

  it('filters by Space, tag, owner, author, template, date and attachments', async () => {
    expect(titles(await find(bob, 'space=srv'))).toEqual(['Printers in Göteborg']);
    expect(titles(await find(bob, 'tag=printing'))).toEqual(['Printers in Göteborg']);
    expect(titles(await find(bob, `owner=${annaId}`))).toEqual(['Database failover', 'VPN troubleshooting']);
    expect(titles(await find(bob, `author=${annaId}&q=vpn`))).toEqual(['VPN troubleshooting']);
    expect((await find(bob, 'template=runbook')).total).toBe(0);
    expect((await find(bob, 'updatedFrom=2000-01-01&updatedTo=2000-12-31')).total).toBe(0);
    expect((await find(bob, 'updatedFrom=2000-01-01')).total).toBe(3);
    expect((await find(bob, 'hasAttachments=1')).total).toBe(0);
    expect((await bob.get('/api/v1/search?updatedFrom=yesterday')).status).toBe(400);
  });

  it('matches text inside attachments and names the file', async () => {
    const id = (await find(bob, 'q=VPN')).hits[0].id;
    await anna.upload(id, 'gateway.conf', 'crypto isakmp policy 10\n encryption aes-256\n peer 203.0.113.9\n');
    await anna.upload(id, 'photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    const r = await find(bob, 'q=203.0.113.9');
    expect(titles(r)).toEqual(['VPN troubleshooting']);
    expect(r.hits[0].attachments).toHaveLength(1);
    expect(r.hits[0].attachments[0].filename).toBe('gateway.conf');
    expect(r.hits[0].attachments[0].snippet.text).toContain('203.0.113.9');
    expect(titles(await find(bob, 'hasAttachments=1'))).toEqual(['VPN troubleshooting']);
  });

  it('leaves trashed pages out and updates the index on edits', async () => {
    const id = (await find(bob, 'q=replica')).hits[0].id;
    expect((await edit(anna, id, '## Steps\n\nNow uses Patroni.')).status).toBe(200);
    expect((await find(bob, 'q=replica')).total).toBe(0);
    expect((await find(bob, 'q=patroni')).total).toBe(1);
    await anna.del(`/api/v1/pages/${id}`);
    expect((await find(bob, 'q=patroni')).total).toBe(0);
  });

  it('indexes pages written before search existed', async () => {
    await db.execute(sql`update pages set search_tsv = null, search_blob = null, search_version = 0`);
    expect((await find(bob, 'q=srv-db-01')).total).toBe(0);
    expect((await reindexPending()).pages).toBe(3);
    expect((await find(bob, 'q=srv-db-01')).total).toBe(1);
  });

  it('uses the configured language for stemming', async () => {
    expect((await find(bob, 'q=restarting')).total).toBe(0);
    expect((await anna.patch('/api/v1/settings', { searchLanguage: 'english' })).status).toBe(403);
    expect((await admin.patch('/api/v1/settings', { searchLanguage: 'klingon' })).status).toBe(400);
    expect((await admin.patch('/api/v1/settings', { searchLanguage: 'english' })).status).toBe(200);
    await reindexPending();
    expect(titles(await find(bob, 'q=restarting'))).toEqual(['VPN troubleshooting']);
    expect((await admin.get('/api/v1/search/languages')).json).toContain('swedish');
  });

  it('quick switcher tolerates typos', async () => {
    const r = (await bob.get('/api/v1/pages/quick?q=troublesooting')).json;
    expect(r.map((p: any) => p.title)).toEqual(['VPN troubleshooting']);
    expect((await bob.get('/api/v1/pages/quick?q=data')).json[0].title).toBe('Database failover');
  });
});

describe('secret warnings', () => {
  it('asks before checking in a secret, then flags the revision', async () => {
    const id = await page(anna, 'SQL service account');
    const body = 'Connect with:\n\n```\nServer=sql01;User Id=svc;Password=Winter2025!;\n```';
    const r = await edit(anna, id, body);
    expect(r.status).toBe(422);
    expect(r.json.details.code).toBe('possible_secrets');
    expect(r.json.details.findings).toHaveLength(1);
    expect(r.json.details.findings[0]).toMatchObject({ line: 4, ruleId: 'password-assignment' });
    expect(JSON.stringify(r.json)).not.toContain('Winter2025');

    const ok = await anna.post(`/api/v1/pages/${id}/checkin`, { title: 'SQL service account', body, secretsAcknowledged: true });
    expect(ok.status).toBe(200);
    const revs = (await bob.get(`/api/v1/pages/${id}/revisions`)).json;
    expect(revs[0]).toMatchObject({ secretsAcknowledged: true });
    expect(revs[0].secretFindings[0].preview).not.toContain('Winter2025');
    expect(revs[1].secretFindings).toEqual([]);
    expect((await bob.get(`/api/v1/pages/${id}`)).json.secretFindings).toHaveLength(1);
  });

  it('lists flagged content for admins and lets them purge old revisions', async () => {
    const id = await page(anna, 'Leaky');
    await edit(anna, id, 'token: ghp_0123456789abcdefghijABCDEFGHIJ012345', { secretsAcknowledged: true });
    expect((await anna.get('/api/v1/admin/secrets')).status).toBe(403);
    let report = (await admin.get('/api/v1/admin/secrets')).json;
    expect(report.revisions).toHaveLength(1);
    expect(report.revisions[0]).toMatchObject({ pageId: id, isCurrent: true, acknowledged: true });
    const leaked = report.revisions[0].revisionId;

    // The current revision can't be purged; fix the page first.
    expect((await admin.del(`/api/v1/pages/${id}/revisions/${leaked}`)).status).toBe(400);
    expect((await edit(anna, id, 'token: see the vault')).status).toBe(200);
    report = (await admin.get('/api/v1/admin/secrets')).json;
    expect(report.revisions[0]).toMatchObject({ isCurrent: false });
    expect((await anna.del(`/api/v1/pages/${id}/revisions/${leaked}`)).status).toBe(403);
    expect((await admin.del(`/api/v1/pages/${id}/revisions/${leaked}`)).status).toBe(200);
    expect((await admin.get('/api/v1/admin/secrets')).json.revisions).toHaveLength(0);
    expect((await bob.get(`/api/v1/pages/${id}/revisions`)).json).toHaveLength(2);
  });

  it('warns about secrets in uploaded text files', async () => {
    const id = await page(anna, 'Router');
    const up = await anna.upload(id, 'router.cfg', 'enable secret Cisc0Rocks!\nusername admin password 0 Adm1nPass!\n');
    expect(up.status).toBe(200);
    expect(up.json.warnings.map((w: any) => w.line)).toEqual([1, 2]);
    const report = (await admin.get('/api/v1/admin/secrets')).json;
    expect(report.attachments[0]).toMatchObject({ filename: 'router.cfg', pageId: id });
    expect((await admin.del(`/api/v1/attachments/${up.json.id}/purge`)).status).toBe(200);
    expect((await anna.get(`/api/v1/pages/${id}/attachments`)).json).toHaveLength(0);
  });

  it('lets admins tune the rules, and rescans with them', async () => {
    const rules = (await bob.get('/api/v1/secret-rules')).json;
    expect(rules.config.rules.length).toBe(rules.builtin.length);
    const id = await page(anna, 'Employee ids');
    expect((await edit(anna, id, 'Badge CORP-123456')).status).toBe(200);

    const settings = { ...rules.settings, customRules: [{ id: 'custom-badge', name: 'Badge number', pattern: 'CORP-[0-9]{6}' }] };
    expect((await bob.put('/api/v1/secret-rules', settings)).status).toBe(403);
    expect((await admin.put('/api/v1/secret-rules', { ...settings, customRules: [{ id: 'custom-x', name: 'X', pattern: '(' }] })).status).toBe(400);
    expect((await admin.put('/api/v1/secret-rules', settings)).status).toBe(200);
    expect((await admin.post('/api/v1/admin/secrets/rescan')).json.flagged).toBe(1);
    expect((await edit(anna, id, 'Badge CORP-654321')).json.details.findings[0].ruleName).toBe('Badge number');
    await anna.post(`/api/v1/pages/${id}/discard`);

    // Disabling a rule and allowlisting a value
    await admin.put('/api/v1/secret-rules', { ...settings, disabledRules: ['custom-badge'], allowlist: [...settings.allowlist, 'Labpass123'] });
    expect((await edit(anna, id, 'Badge CORP-654321\npassword=Labpass123')).status).toBe(200);
  });
});

describe('tags and review dates', () => {
  it('normalises, sets and lists tags', async () => {
    const id = await page(anna, 'AD sites');
    expect((await bob.put(`/api/v1/pages/${id}/tags`, { tags: ['Active Directory', 'dns', 'DNS', '!!'] })).json.tags).toEqual(['active-directory', 'dns']);
    await page(anna, 'DNS forwarders', '', { tags: ['dns'] });
    expect((await bob.get('/api/v1/tags?q=d')).json).toEqual([{ tag: 'dns', count: 2 }]);
    await anna.post(`/api/v1/pages/${id}/checkout`, {});
    expect((await bob.put(`/api/v1/pages/${id}/tags`, { tags: [] })).status).toBe(409);
    expect((await bob.get(`/api/v1/pages/${id}`)).json.tags).toEqual(['active-directory', 'dns']);
  });

  it('sets a review date from the template and lets the owner change or clear it', async () => {
    const id = await page(anna, 'Restore backups', undefined, { template: 'runbook' });
    const p = (await bob.get(`/api/v1/pages/${id}`)).json;
    const expected = new Date();
    expected.setMonth(expected.getMonth() + 6);
    expect(p.review.reviewBy.slice(0, 7)).toBe(expected.toISOString().slice(0, 7));
    expect(p.review.status).toBe('ok');
    expect((await page(anna, 'Notes')) && (await bob.get('/api/v1/search?review=none')).json.total).toBe(1);

    expect((await bob.put(`/api/v1/pages/${id}/review`, { reviewBy: '2020-01-01' })).status).toBe(403);
    expect((await anna.put(`/api/v1/pages/${id}/review`, { reviewBy: '2020-13-45' })).status).toBe(400);
    expect((await anna.put(`/api/v1/pages/${id}/review`, { reviewBy: '2020-01-01' })).status).toBe(200);
    expect((await bob.get(`/api/v1/pages/${id}`)).json.review.status).toBe('overdue');
    expect((await admin.put(`/api/v1/pages/${id}/review`, { reviewBy: null })).status).toBe(200);
    expect((await bob.get(`/api/v1/pages/${id}`)).json.review).toMatchObject({ reviewBy: null, status: 'none' });
  });

  it('lists stale pages and moves the date forward when marked reviewed', async () => {
    const a = await page(anna, 'Old runbook', undefined, { template: 'howto' });
    const b = await page(bob, 'Due soon', undefined, { spaceKey: 'srv' });
    await anna.put(`/api/v1/pages/${a}/review`, { reviewBy: '2021-03-01' });
    const soon = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
    await bob.put(`/api/v1/pages/${b}/review`, { reviewBy: soon });

    expect((await bob.get('/api/v1/stale')).json.map((r: any) => r.title)).toEqual(['Old runbook']);
    const both = (await bob.get('/api/v1/stale?includeDue=1')).json;
    expect(both.map((r: any) => [r.title, r.status])).toEqual([['Old runbook', 'overdue'], ['Due soon', 'due']]);
    expect((await bob.get('/api/v1/stale?includeDue=1&space=srv')).json).toHaveLength(1);
    expect((await bob.get(`/api/v1/stale?includeDue=1&owner=${annaId}`)).json).toHaveLength(1);
    expect(titles(await find(bob, 'review=overdue'))).toEqual(['Old runbook']);
    expect(titles(await find(bob, 'review=due'))).toEqual(['Due soon']);

    expect((await bob.post(`/api/v1/pages/${a}/review`)).status).toBe(403);
    const r = await anna.post(`/api/v1/pages/${a}/review`);
    expect(r.status).toBe(200);
    const expected = new Date();
    expected.setMonth(expected.getMonth() + 12);
    expect(r.json.reviewBy.slice(0, 7)).toBe(expected.toISOString().slice(0, 7));
    const p = (await bob.get(`/api/v1/pages/${a}`)).json;
    expect(p.review).toMatchObject({ status: 'ok', reviewedBy: { displayName: 'Anna' } });
    expect((await bob.get('/api/v1/stale')).json).toHaveLength(0);

    // A custom next date, and "also mark as reviewed" on check-in
    expect((await anna.post(`/api/v1/pages/${a}/review`, { nextReviewBy: '2030-01-01' })).json.reviewBy).toBe('2030-01-01');
    await anna.put(`/api/v1/pages/${a}/review`, { reviewBy: '2021-03-01' });
    expect((await edit(anna, a, '## Goal\n\nx\n\n## Steps\n\ny', { markReviewed: true })).status).toBe(200);
    expect((await bob.get(`/api/v1/pages/${a}`)).json.review.status).toBe('ok');
  });

  it('flags pages of former users', async () => {
    const id = await page(anna, 'Orphan');
    await anna.put(`/api/v1/pages/${id}/review`, { reviewBy: '2021-01-01' });
    await admin.patch(`/api/v1/users/${annaId}`, { active: false });
    const [row] = (await bob.get('/api/v1/stale?former=1')).json;
    expect(row).toMatchObject({ title: 'Orphan', owner: { active: false } });
    expect((await bob.get('/api/v1/users/directory')).json.map((u: any) => u.displayName)).toEqual(['Admin', 'Anna', 'Bob']);
  });
});
