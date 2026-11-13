#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { sql } from 'drizzle-orm';
import { db, pool, runMigrations } from './db/index.js';
import { users } from './db/schema.js';
import { hashPassword, validatePassword } from './lib/passwords.js';
import { runNightly } from './lib/jobs.js';
import { reindexPending } from './lib/search.js';
import { rescanAll } from './routes/secrets.js';

function usage(): never {
  console.log(`Usage: lorebook <command>

Commands:
  create-admin [--username NAME] [--display-name NAME] [--password-stdin]
      Create a local admin account (or promote and reset an existing local one).
  migrate
      Apply database migrations.
  nightly
      Run the nightly jobs now: purge trash older than 30 days, delete unreferenced attachment files.
  reindex
      Rebuild the search index for every page and text attachment.
  rescan-secrets
      Re-scan every revision and text attachment with the current secret detection rules.`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Mask typed characters.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(question);
      else if (s === '\r\n' || s === '\n') process.stdout.write('\n');
      else process.stdout.write('*');
    };
  }
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function createAdmin() {
  await runMigrations();
  const username = (arg('--username') ?? (await ask('Username: '))).trim();
  if (!/^[a-zA-Z0-9._-]{2,64}$/.test(username)) throw new Error('Username must be 2-64 letters, digits, dots, dashes or underscores');
  const displayName = (arg('--display-name') ?? (await ask(`Display name [${username}]: `))).trim() || username;
  let password: string;
  if (process.argv.includes('--password-stdin')) {
    password = await readStdin();
  } else {
    password = await ask('Password (min 12 characters): ', true);
    const again = await ask('Repeat password: ', true);
    if (password !== again) throw new Error('Passwords do not match');
  }
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  const passwordHash = await hashPassword(password);
  const [existing] = await db.select().from(users).where(sql`lower(${users.username}) = lower(${username})`);
  if (existing) {
    if (existing.authSource !== 'local') throw new Error('That username belongs to a directory account');
    await db.update(users).set({ role: 'admin', active: true, passwordHash, failedLogins: 0, lastFailedLoginAt: null })
      .where(sql`${users.id} = ${existing.id}`);
    console.log(`Updated ${username}: now an active admin with the new password.`);
  } else {
    await db.insert(users).values({ username, displayName, passwordHash, role: 'admin' });
    console.log(`Created admin ${username}.`);
  }
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === 'create-admin') await createAdmin();
    else if (cmd === 'migrate') { await runMigrations(); console.log('Migrations applied.'); }
    else if (cmd === 'nightly') {
      await runMigrations();
      const r = await runNightly();
      console.log(`Purged ${r.trash.pages} page(s) from the trash; removed ${r.attachmentsGc.removed} unreferenced file(s) (${Math.round(r.attachmentsGc.bytes / 1024)} KB).`);
    }
    else if (cmd === 'reindex') {
      await runMigrations();
      await db.execute(sql`update pages set search_version = 0`);
      await db.execute(sql`update attachments set text_extracted = false`);
      let total = { pages: 0, attachments: 0 };
      for (;;) {
        const r = await reindexPending(undefined, 50);
        total = { pages: total.pages + r.pages, attachments: total.attachments + r.attachments };
        if (!r.pages && !r.attachments) break;
      }
      console.log(`Indexed ${total.pages} page(s) and ${total.attachments} attachment(s).`);
    }
    else if (cmd === 'rescan-secrets') {
      await runMigrations();
      const r = await rescanAll();
      console.log(`Scanned ${r.revisions} revision(s) and ${r.attachments} attachment(s); ${r.flagged} revision(s) flagged.`);
    }
    else usage();
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
