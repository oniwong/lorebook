import { eq } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { pageLinks } from '../db/schema.js';
import { config } from '../config.js';

const baseHost = (() => {
  try {
    return new URL(config.baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
})();

// /p/12, /p/12/edit, /s/net/p/12/slug, or the same with this server's own origin in front.
const LINK = /(?:^|[\s(<"'[])(?:https?:\/\/([^/\s)>"']+))?\/(?:s\/[a-z0-9-]+\/)?p\/(\d{1,9})(?![\w-])/gim;

function stripCode(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    out.push(line.replace(/`[^`]*`/g, ''));
  }
  return out.join('\n');
}

/** Ids of the Lorebook pages a Markdown body links to (outside code). */
export function extractPageLinks(md: string): number[] {
  const ids = new Set<number>();
  for (const m of stripCode(md).matchAll(LINK)) {
    if (m[1] && m[1].toLowerCase() !== baseHost) continue;
    ids.add(Number(m[2]));
  }
  return [...ids];
}

export async function syncLinks(tx: Tx, pageId: number, body: string): Promise<void> {
  await tx.delete(pageLinks).where(eq(pageLinks.fromPageId, pageId));
  const targets = extractPageLinks(body).filter((id) => id !== pageId);
  if (targets.length) {
    await tx.insert(pageLinks).values(targets.map((toPageId) => ({ fromPageId: pageId, toPageId }))).onConflictDoNothing();
  }
}
