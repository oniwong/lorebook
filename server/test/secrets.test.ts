import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BUILTIN_SECRET_RULES, DEFAULT_ALLOWLIST, scanSecrets, validateRule } from '../src/lib/secrets.js';
import { splitMarkdown, plainText } from '../src/lib/mdtext.js';
import { fold, makeSnippet, parseQuery } from '../src/lib/search.js';
import { normalizeTag } from '../src/lib/review.js';

const cfg = { rules: BUILTIN_SECRET_RULES, allowlist: DEFAULT_ALLOWLIST };
const rules = (text: string, opts = {}) => scanSecrets(text, cfg, opts).map((f) => f.ruleId);

describe('secret detection', () => {
  it('is the same code in the server and the editor', () => {
    const server = readFileSync(new URL('../src/lib/secrets.ts', import.meta.url), 'utf8');
    const web = readFileSync(new URL('../../web/src/lib/secrets.ts', import.meta.url), 'utf8');
    expect(web).toBe(server);
  });

  it('finds the built-in kinds of secret', () => {
    expect(rules('-----BEGIN OPENSSH PRIVATE KEY-----')).toEqual(['private-key']);
    expect(rules('key id AKIAIOSFODNN7EXAMPLE here')).toEqual(['aws-access-key']);
    expect(rules('DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcdEFGH1234abcdEFGH1234abcd==;')).toEqual(['azure-key']);
    expect(rules('https://x.blob.core.windows.net/c?sv=2022&sig=AbCdEf0123456789AbCdEf0123%3D')).toEqual(['azure-sas']);
    expect(rules('token ghp_0123456789abcdefghijABCDEFGHIJ012345')).toEqual(['git-token']);
    expect(rules('glpat-abcdefghij0123456789')).toEqual(['git-token']);
    expect(rules('xoxb-1234567890-abcdefghij')).toEqual(['slack-token']);
    expect(rules('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36P')).toEqual(['jwt']);
    expect(rules('db_password = "Summer2024!"')).toEqual(['password-assignment']);
    expect(rules('Server=sql01;User Id=app;Password=S3cret-Value;')).toEqual(['password-assignment']);
    expect(rules('net use \\\\fs01\\share /user:svc --password Hunter2xyz')).toEqual(['password-parameter']);
    expect(rules('postgres://app:Tr0ub4dor@db01:5432/app')).toEqual(['url-credentials']);
  });

  it('ignores placeholders, prose and suppressed lines', () => {
    expect(rules('password: <password>')).toEqual([]);
    expect(rules('password=changeme')).toEqual([]);
    expect(rules('password: ********')).toEqual([]);
    expect(rules('DB_PASSWORD=${DB_PASSWORD}')).toEqual([]);
    expect(rules('$cred = Get-Credential; -Password $env:SVC_PWD')).toEqual([]);
    expect(rules('postgres://lorebook:${POSTGRES_PASSWORD}@postgres:5432/lorebook')).toEqual([]);
    expect(rules('Password: stored in the vault')).toEqual([]);
    expect(rules('The bypass: 12345678 setting')).toEqual([]);
    expect(rules('password=Summer2024! <!-- lorebook:ignore-secret -->')).toEqual([]);
    expect(rules('password=Summer2024! # lorebook:ignore-secret')).toEqual([]);
  });

  it('flags random-looking strings only inside code blocks (or files)', () => {
    const token = 'Zx8Kq2Lm9Pw4Rt7Yb3Nc6Vd1Hf5Gj0Sa';
    expect(rules(`see ${token}`)).toEqual([]);
    expect(rules(`\`\`\`\nexport TOKEN_VALUE ${token}\n\`\`\``)).toEqual(['high-entropy']);
    expect(rules(`export TOKEN_VALUE ${token}`, { allCode: true })).toEqual(['high-entropy']);
    // A sha256 (hex) is not flagged
    expect(rules('```\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n```')).toEqual([]);
  });

  it('reports line numbers and masked previews that never contain the secret', () => {
    const [f] = scanSecrets('intro\n\nadmin password: Summer2024!xyz', cfg);
    expect(f).toMatchObject({ line: 3, ruleId: 'password-assignment', column: 16, length: 14 });
    expect(f.preview).not.toContain('Summer2024');
    expect(f.preview).toMatch(/^admin password: Su•+$/);
  });

  it('validates custom rules', () => {
    expect(validateRule({ pattern: '(' })).toMatch(/Invalid|Unterminated/i);
    expect(validateRule({ pattern: 'a*' })).toMatch(/empty/);
    expect(validateRule({ pattern: 'CORP-[0-9]{6}' })).toBeNull();
  });
});

describe('search helpers', () => {
  it('splits Markdown into headings, code and prose', () => {
    const parts = splitMarkdown('# Title\n\nRun `ipconfig /all` on **srv-01**.\n<!-- hint\nmore -->\n## Steps\n\n```ps\nGet-Service\n```\n- [x] [link](/p/2)\n');
    expect(parts.headings).toEqual(['Title', 'Steps']);
    expect(parts.code).toContain('ipconfig /all');
    expect(parts.code).toContain('Get-Service');
    expect(parts.prose).toContain('srv-01');
    expect(parts.prose).not.toContain('hint');
    expect(parts.prose).toContain('link /p/2');
    expect(plainText('## Goal\n\n**Bold** text\n```\ncode\n```')).toBe('Goal\nBold text\ncode');
  });

  it('parses words, phrases, exclusions and OR', () => {
    expect(parseQuery('vpn "reset password" -legacy OR srv-db-01')).toEqual({
      groups: [['vpn', 'reset password'], ['srv-db-01']], exclude: ['legacy'], terms: ['vpn', 'reset password', 'srv-db-01'],
    });
    expect(parseQuery('  ').groups).toEqual([]);
  });

  it('folds accents without changing offsets and highlights snippets', () => {
    expect(fold('Göteborg ÅÄÖ')).toBe('goteborg aao');
    const s = makeSnippet('The office in Göteborg uses vlan 10 for printers.', ['goteborg'])!;
    expect(s.text.slice(s.highlights[0][0], s.highlights[0][1])).toBe('Göteborg');
  });

  it('normalises tags', () => {
    expect(normalizeTag(' Active Directory ')).toBe('active-directory');
    expect(normalizeTag('#DNS')).toBe('dns');
    expect(normalizeTag('***')).toBeNull();
  });
});

describe('network device configs', () => {
  it('finds passwords in Cisco-style lines', () => {
    expect(rules('enable secret Cisc0Rocks!\nusername admin password 0 Adm1nPass!\nsnmp-server community Publ1cRO RO')).toEqual(['device-password', 'device-password', 'device-password']);
    expect(rules('Ask the team for the password reset link.')).toEqual([]);
  });
});
