// Splits a Markdown body into the parts search weights differently (spec §9): headings, code blocks and the
// rest of the text. This is a light line-based pass, not a full Markdown parser; it only has to be good
// enough for indexing and snippets.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

export type MarkdownParts = {
  headings: string[];
  /** Fenced code blocks and inline code, one block per line group. */
  code: string;
  /** Everything else, with Markdown punctuation stripped (link URLs are kept: hostnames are worth finding). */
  prose: string;
};

function plain(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 $2')
    .replace(/^\s{0,3}(?:>\s?)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](?=\s|$|[.,;:!?)])/g, '$1')
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/, '')
    .replace(/\s*\|\s*/g, ' | ')
    .trim();
}

export function splitMarkdown(md: string): MarkdownParts {
  const headings: string[] = [];
  const code: string[] = [];
  const prose: string[] = [];
  let fence: string | null = null;
  let inComment = false;
  for (const raw of md.split(/\r\n|\r|\n/)) {
    const f = FENCE.exec(raw);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && raw.trim() === f[1]) {
        fence = null;
        code.push('');
      } else {
        code.push(raw);
      }
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    // Template hints are multi-line HTML comments; they are not content.
    let line = raw;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, ' ');
    const open = line.indexOf('<!--');
    if (open >= 0) {
      line = line.slice(0, open);
      inComment = true;
    }
    for (const m of line.matchAll(/`([^`]+)`/g)) code.push(m[1]);
    const h = ATX.exec(line);
    if (h) {
      const text = plain((h[1] ?? '').replace(/`/g, ''));
      if (text) headings.push(text);
      continue;
    }
    const p = plain(line.replace(/`/g, ''));
    if (p) prose.push(p);
  }
  return { headings, code: code.join('\n').replace(/\n{3,}/g, '\n\n').trim(), prose: prose.join('\n') };
}

/** Readable plain text of a whole body (prose, headings and code), for search snippets. */
export function plainText(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, ' ').split(/\r\n|\r|\n/)) {
    const f = FENCE.exec(raw);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && raw.trim() === f[1]) fence = null;
      else out.push(raw);
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const h = ATX.exec(raw);
    const p = plain((h ? (h[1] ?? '') : raw));
    if (p) out.push(p);
  }
  return out.join('\n');
}
