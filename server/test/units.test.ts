import { describe, expect, it } from 'vitest';
import { checkRequiredSections } from '../src/lib/sections.js';
import { extractPageLinks } from '../src/lib/links.js';
import { parseCookieSecure } from '../src/config.js';
import { cleanFilename, contentDisposition, contentTypeFor, isTextFile } from '../src/lib/attachments.js';

describe('required sections', () => {
  const req = ['Purpose', 'Steps', 'Contacts/Escalation'];

  it('finds missing and empty sections, ignoring template hints', () => {
    const md = '## Purpose\n\n<!-- what is this for -->\n\n## Steps\n\n1. Do it\n';
    expect(checkRequiredSections(md, req)).toEqual({ missing: ['Contacts/Escalation'], empty: ['Purpose'] });
  });

  it('accepts filled sections with case, emphasis and subsections', () => {
    const md = '# Title\n\n## purpose:\nRestart DNS\n\n## **Steps**\n### Sub\n```sh\n## not a heading\n```\n\nContacts/Escalation\n---\nOn-call\n';
    expect(checkRequiredSections(md, req)).toEqual({ missing: [], empty: [] });
  });

  it('does not treat headings inside code blocks as sections', () => {
    const md = '```\n## Purpose\ntext\n```\n';
    expect(checkRequiredSections(md, ['Purpose']).missing).toEqual(['Purpose']);
  });

  it('ends a section at the next H1 or H2', () => {
    const md = '## Purpose\n# Other\ntext\n';
    expect(checkRequiredSections(md, ['Purpose']).empty).toEqual(['Purpose']);
  });
});

describe('internal links', () => {
  it('extracts /p/<id> and /s/<key>/p/<id> links but not code or other hosts', () => {
    const md = [
      'See [DNS](/p/12) and [Core](/s/net/p/7/core-switch#steps).',
      'Absolute: https://localhost/p/9/edit and https://elsewhere.example/p/99',
      '`/p/55` and', '```', '[x](/p/66)', '```', '<https://localhost/s/net/p/8>',
      'Not a link: /p/123abc or /api/p/5x',
    ].join('\n');
    expect(extractPageLinks(md).sort((a, b) => a - b)).toEqual([7, 8, 9, 12]);
  });
});

describe('attachment helpers', () => {
  it('cleans filenames and guesses types', () => {
    expect(cleanFilename('C:\\Users\\me\\..\\evil<>.ps1')).toBe('evil__.ps1');
    expect(cleanFilename('../../.htaccess')).toBe('htaccess');
    expect(contentTypeFor('net.vsdx')).toBe('application/vnd.ms-visio.drawing');
    expect(contentTypeFor('nginx.conf')).toBe('text/plain');
    expect(contentTypeFor('blob.bin')).toBe('application/octet-stream');
    expect(isTextFile('Dockerfile')).toBe(true);
    expect(isTextFile('diagram.drawio.png')).toBe(false);
    expect(contentDisposition('attachment', 'Nätverk "plan".pdf')).toBe(
      'attachment; filename="N_tverk _plan_.pdf"; filename*=UTF-8\'\'N%C3%A4tverk%20%22plan%22.pdf',
    );
  });
});

describe('cookie Secure flag', () => {
  it('stays on unless explicitly turned off', () => {
    for (const v of [undefined, '', 'true', '1', 'yes', 'TRUE']) expect(parseCookieSecure(v)).toBe(true);
    for (const v of ['false', 'FALSE', '0', 'no', 'off', ' false ']) expect(parseCookieSecure(v)).toBe(false);
  });
});
