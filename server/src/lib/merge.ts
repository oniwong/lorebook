// Three-way line merge, used to update a change request onto the latest version of its page (spec §6).
import { diffArrays } from 'diff';

export const CONFLICT_START = '<<<<<<< your change';
export const CONFLICT_MID = '=======';
export const CONFLICT_END = '>>>>>>> current page';

type Hunk = { start: number; end: number; lines: string[]; side: 'mine' | 'theirs' };

/** The changes that turn `base` into `other`, as replaced ranges of base lines. */
function hunks(base: string[], other: string[], side: Hunk['side']): Hunk[] {
  const out: Hunk[] = [];
  let i = 0;
  let open: Hunk | null = null;
  for (const part of diffArrays(base, other)) {
    if (!part.added && !part.removed) {
      if (open) out.push(open);
      open = null;
      i += part.value.length;
      continue;
    }
    if (!open) open = { start: i, end: i, lines: [], side };
    if (part.removed) {
      i += part.value.length;
      open.end = i;
    } else {
      open.lines.push(...part.value);
    }
  }
  if (open) out.push(open);
  return out;
}

/** One side's text for the base range [from, to), with that side's hunks applied. */
function apply(base: string[], from: number, to: number, hs: Hunk[]): string[] {
  const out: string[] = [];
  let pos = from;
  for (const h of hs) {
    out.push(...base.slice(pos, h.start), ...h.lines);
    pos = h.end;
  }
  out.push(...base.slice(pos, to));
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Merges `mine` and `theirs`, which both started from `base`. Changes that overlap (or touch) and differ
 * are kept side by side between conflict markers for the person to resolve in the editor.
 */
export function merge3(base: string, mine: string, theirs: string): { text: string; conflicts: number } {
  if (mine === base) return { text: theirs, conflicts: 0 };
  if (theirs === base || theirs === mine) return { text: mine, conflicts: 0 };
  const b = base.split('\n');
  const all = [...hunks(b, mine.split('\n'), 'mine'), ...hunks(b, theirs.split('\n'), 'theirs')]
    .sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let conflicts = 0;
  let pos = 0;
  let i = 0;
  while (i < all.length) {
    const group = [all[i]];
    let start = all[i].start;
    let end = all[i].end;
    i++;
    while (i < all.length && all[i].start <= end) {
      group.push(all[i]);
      start = Math.min(start, all[i].start);
      end = Math.max(end, all[i].end);
      i++;
    }
    out.push(...b.slice(pos, start));
    const m = group.filter((h) => h.side === 'mine');
    const t = group.filter((h) => h.side === 'theirs');
    const mineText = apply(b, start, end, m);
    const theirsText = apply(b, start, end, t);
    if (!m.length) out.push(...theirsText);
    else if (!t.length || same(mineText, theirsText)) out.push(...mineText);
    else {
      conflicts++;
      out.push(CONFLICT_START, ...mineText, CONFLICT_MID, ...theirsText, CONFLICT_END);
    }
    pos = end;
  }
  out.push(...b.slice(pos));
  return { text: out.join('\n'), conflicts };
}

/** True while the body still has unresolved conflict markers from merge3. */
export function hasConflictMarkers(body: string): boolean {
  const lines = body.split('\n');
  return lines.includes(CONFLICT_START) && lines.includes(CONFLICT_END);
}
