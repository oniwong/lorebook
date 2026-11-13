// Nightly housekeeping: purge expired trash, then delete attachment files nothing references.
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { getSetting, setSetting } from './settings.js';
import { purgeExpiredTrash } from './tree.js';
import { gcAttachments } from './attachments.js';

const LAST_RUN = 'jobs.nightly.lastRun';

export async function runNightly(log?: Pick<FastifyBaseLogger, 'info'>) {
  const trash = await purgeExpiredTrash();
  const gc = await gcAttachments();
  log?.info({ event: 'nightly_done', trash, attachmentsGc: gc }, 'nightly jobs done');
  return { trash, attachmentsGc: gc };
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Called every minute; runs the nightly jobs once a day at or after NIGHTLY_HOUR (container local time). */
export async function maybeRunNightly(log: Pick<FastifyBaseLogger, 'info'>, now = new Date()): Promise<boolean> {
  if (now.getHours() < config.nightlyHour) return false;
  const today = localDate(now);
  if ((await getSetting<string | null>(LAST_RUN, null)) === today) return false;
  await setSetting(LAST_RUN, today);
  await runNightly(log);
  return true;
}
