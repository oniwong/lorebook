// Secret detection (spec §8). Lorebook warns about content that looks like a credential; it never blocks.
//
// This file is shared: web/src/lib/secrets.ts must be an identical copy (a unit test checks), so the editor
// underlines exactly what the server flags on check-in. It has no imports and runs in Node and browsers.

export type SecretRule = {
  id: string;
  name: string;
  /** JavaScript regular expression source, matched against one line at a time. */
  pattern: string;
  /** Extra regex flags; `g` is always added. */
  flags?: string;
  /**
   * Capture group holding the secret value. That part is masked in previews and checked against the
   * placeholder allowlist. 0 (default) means the whole match.
   */
  group?: number;
  /** Only report a value when it looks like a real password (mixed character classes or long). */
  strength?: boolean;
  /** `entropy`: report long random-looking tokens inside code blocks; `pattern` is the token shape. */
  kind?: 'regex' | 'entropy';
};

export type SecretScanConfig = {
  rules: SecretRule[];
  /** Values that are obviously placeholders, compared case-insensitively after trimming quotes. */
  allowlist: string[];
};

export type SecretFinding = {
  ruleId: string;
  ruleName: string;
  /** 1-based line number. */
  line: number;
  /** 0-based column of the match within the line. */
  column: number;
  length: number;
  /** The line around the match with the secret value masked. Safe to show and store. */
  preview: string;
};

export const IGNORE_MARKER = 'lorebook:ignore-secret';

export const BUILTIN_SECRET_RULES: SecretRule[] = [
  {
    id: 'private-key', name: 'Private key',
    pattern: '-----BEGIN (?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----',
  },
  { id: 'aws-access-key', name: 'AWS access key', pattern: '\\b((?:AKIA|ASIA)[0-9A-Z]{16})\\b', group: 1 },
  {
    id: 'azure-key', name: 'Azure connection string key',
    pattern: '(?:AccountKey|SharedAccessKey|SharedAccessSignature)=([A-Za-z0-9+/=%]{20,})', flags: 'i', group: 1,
  },
  { id: 'azure-sas', name: 'Azure SAS token', pattern: '[?&]sig=([A-Za-z0-9%+/=]{20,})', group: 1 },
  {
    id: 'git-token', name: 'GitHub/GitLab token',
    pattern: '\\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,})\\b', group: 1,
  },
  { id: 'slack-token', name: 'Slack-style token', pattern: '\\b(xox[abposr]-[A-Za-z0-9-]{10,})\\b', group: 1 },
  { id: 'jwt', name: 'JSON Web Token', pattern: '\\b(eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,})', group: 1 },
  {
    id: 'password-assignment', name: 'Password or key assignment',
    pattern: '(?<![a-z])(?:pass(?:word|wd)?|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)["\']?\\s*[:=]\\s*("[^"\\n]*"|\'[^\'\\n]*\'|[^\\s"\'`,;]+)',
    flags: 'i', group: 1, strength: true,
  },
  {
    id: 'password-parameter', name: 'Password on a command line',
    pattern: '(?:^|\\s)--?(?:password|passwd|pwd|secret|token)\\s+("[^"\\n]*"|\'[^\'\\n]*\'|[^\\s"\'`]+)',
    flags: 'i', group: 1, strength: true,
  },
  {
    // Cisco-style config lines: "enable secret X", "username admin password 0 X", "snmp-server community X"
    id: 'device-password', name: 'Network device password',
    pattern: '(?:^|\\s)(?:password|secret|community)\\s+(?:[0-9]\\s+)?("[^"\\n]*"|[^\\s"]+)',
    flags: 'i', group: 1, strength: true,
  },
  {
    id: 'url-credentials', name: 'Connection string with credentials',
    pattern: '\\b[a-z][a-z0-9+.-]{1,20}://[^\\s:/@]+:([^\\s@/]+)@[^\\s/]+', flags: 'i', group: 1,
  },
  {
    id: 'high-entropy', name: 'Long random-looking string in code', kind: 'entropy',
    pattern: '[A-Za-z0-9+/=_-]{32,}',
  },
];

export const DEFAULT_ALLOWLIST = [
  'changeme', 'change-me', 'change_me', 'password', 'secret', 'example', 'redacted', 'placeholder', 'xxx', 'xxxx',
  'none', 'null', 'true', 'false', 'required', 'optional', 'empty', 'todo', 'tbd', 'n/a',
];

const PLACEHOLDER_SHAPES = [
  /^<[^<>]*>$/, // <password>
  /^\$\{[^}]*\}$/, // ${VAR}
  /^\$\([^)]*\)$/, // $(command)
  /^\$[A-Za-z_][A-Za-z0-9_:]*$/, // $VAR, $env:VAR
  /^%[A-Za-z_][A-Za-z0-9_]*%$/, // %VAR%
  /^\{\{.*\}\}$/, // {{ template }}
  /^\[[^\]]*\]$/, // [password]
  /^[*•x.#-]+$/i, // ****, xxxx, ...
  /^your[_-]/i, // your-password-here
  /^(?:get-secret|read-host|lookup)\b/i,
];

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1).trim();
  return t;
}

export function isPlaceholder(value: string, allowlist: readonly string[]): boolean {
  const v = unquote(value);
  if (v.length < 4) return true;
  const lower = v.toLowerCase();
  if (allowlist.some((a) => a.trim().toLowerCase() === lower)) return true;
  return PLACEHOLDER_SHAPES.some((re) => re.test(v));
}

/** A value that looks like a chosen password rather than a word in a sentence. */
export function looksStrong(value: string): boolean {
  const v = unquote(value);
  if (v.length >= 16) return true;
  if (v.length < 6) return false;
  let classes = 0;
  if (/[a-z]/.test(v)) classes++;
  if (/[A-Z]/.test(v)) classes++;
  if (/[0-9]/.test(v)) classes++;
  if (/[^A-Za-z0-9]/.test(v)) classes++;
  return classes >= 2;
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksRandom(token: string): boolean {
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) return false;
  return entropy(token) >= 4.2;
}

/** Masks all but the first two characters of a secret value. */
export function maskValue(v: string): string {
  const keep = v.length > 8 ? 2 : 1;
  return v.slice(0, keep) + '•'.repeat(Math.min(Math.max(v.length - keep, 3), 12));
}

const PREVIEW_RADIUS = 40;

function previewFor(line: string, valueStart: number, value: string): string {
  const masked = line.slice(0, valueStart) + maskValue(value) + line.slice(valueStart + value.length);
  const maskedEnd = valueStart + maskValue(value).length;
  const from = Math.max(0, valueStart - PREVIEW_RADIUS);
  const to = Math.min(masked.length, maskedEnd + PREVIEW_RADIUS);
  return (from > 0 ? '…' : '') + masked.slice(from, to).trim() + (to < masked.length ? '…' : '');
}

const MAX_LINE = 4000;
const MAX_FINDINGS = 200;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

type Compiled = { rule: SecretRule; re: RegExp };

function regexFlags(extra: string | undefined): string {
  return [...new Set(`${extra ?? ''}g`.replace(/[^imsuyg]/g, ''))].join('');
}

const compileCache = new Map<string, RegExp | null>();

function compile(rule: SecretRule): RegExp | null {
  const flags = regexFlags(rule.flags);
  const key = `${flags}/${rule.pattern}`;
  if (!compileCache.has(key)) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(rule.pattern, flags);
    } catch {
      re = null;
    }
    compileCache.set(key, re);
  }
  const re = compileCache.get(key)!;
  return re ? new RegExp(re.source, re.flags) : null;
}

/** Returns an error message if the rule's pattern is not a valid regular expression. */
export function validateRule(rule: Pick<SecretRule, 'pattern' | 'flags'>): string | null {
  try {
    const re = new RegExp(rule.pattern, regexFlags(rule.flags));
    if (re.test('')) return 'The pattern matches empty text';
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Scans text for possible secrets. Markdown fenced code blocks are tracked so the entropy rule only looks
 * inside code; pass `allCode` for plain files (attachments) where every line is "code". A line containing
 * `lorebook:ignore-secret` (e.g. in an HTML or shell comment) is skipped.
 */
export function scanSecrets(text: string, config: SecretScanConfig, opts: { allCode?: boolean } = {}): SecretFinding[] {
  const compiled: Compiled[] = [];
  for (const rule of config.rules) {
    const re = compile(rule);
    if (re) compiled.push({ rule, re });
  }
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let fence: string | null = null;
  for (let i = 0; i < lines.length && findings.length < MAX_FINDINGS; i++) {
    const raw = lines[i];
    let inCode = !!opts.allCode;
    if (!opts.allCode) {
      const f = FENCE.exec(raw);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length && raw.trim() === f[1]) {
          fence = null;
          continue;
        }
        inCode = true;
      } else if (f) {
        fence = f[1];
        continue;
      }
    }
    if (raw.includes(IGNORE_MARKER)) continue;
    const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    const taken: [number, number][] = [];
    const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && b > x);
    for (const { rule, re } of compiled) {
      if (rule.kind === 'entropy' && !inCode) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        const g = rule.kind === 'entropy' ? 0 : (rule.group ?? 0);
        const value = m[g] ?? m[0];
        const offset = g === 0 ? 0 : m[0].indexOf(value);
        const start = m.index + Math.max(0, offset);
        if (rule.kind === 'entropy') {
          if (!looksRandom(value)) continue;
        } else if (g !== 0 || rule.strength) {
          if (isPlaceholder(value, config.allowlist)) continue;
          if (rule.strength && !looksStrong(value)) continue;
        }
        if (overlaps(start, start + value.length)) continue;
        taken.push([start, start + value.length]);
        findings.push({
          ruleId: rule.id, ruleName: rule.name, line: i + 1, column: start, length: value.length,
          preview: previewFor(line, start, value),
        });
        if (findings.length >= MAX_FINDINGS) break;
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}
