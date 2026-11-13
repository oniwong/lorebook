// Finds the H2 sections of a Markdown document, for enforcing a template's required sections (spec §5).
// Copy of server/src/lib/sections.ts, used to list missing sections live in the editor. Keep them in sync.

export type SectionCheck = { missing: string[]; empty: string[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_H2 = /^ {0,3}-+[ \t]*$/;
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/;

export function normalizeHeading(s: string): string {
  return s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').replace(/:$/, '').trim().toLowerCase();
}

/** Strips HTML comments (template hints) and whitespace; what remains is real content. */
function hasContent(lines: string[]): boolean {
  return lines.join('\n').replace(/<!--[\s\S]*?(-->|$)/g, '').trim().length > 0;
}

/** Map of normalised H2 heading → whether any section with that heading has content. */
export function h2Sections(md: string): Map<string, boolean> {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = new Map<string, boolean>();
  let current: string | null = null;
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (current !== null) out.set(current, (out.get(current) ?? false) || hasContent(buf));
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      buf.push(line);
      const m = FENCE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      fence = f[1];
      buf.push(line);
      continue;
    }
    const atx = ATX.exec(line);
    let level = 0;
    let text = '';
    if (atx) {
      level = atx[1].length;
      text = atx[2] ?? '';
    } else if (line.trim() && !/^\s*([-*+>]|\d+[.)])\s/.test(line) && i + 1 < lines.length
      && (SETEXT_H2.test(lines[i + 1]) || SETEXT_H1.test(lines[i + 1]))
      && (i === 0 || !lines[i - 1].trim() || current !== null)) {
      level = SETEXT_H2.test(lines[i + 1]) ? 2 : 1;
      text = line;
      i++;
    }
    if (level && level <= 2) {
      flush();
      current = level === 2 ? normalizeHeading(text) : null;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

export function checkRequiredSections(md: string, required: string[]): SectionCheck {
  const found = h2Sections(md);
  const missing: string[] = [];
  const empty: string[] = [];
  for (const r of required) {
    const has = found.get(normalizeHeading(r));
    if (has === undefined) missing.push(r);
    else if (!has) empty.push(r);
  }
  return { missing, empty };
}
