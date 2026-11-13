#!/usr/bin/env node
// Fails if the built frontend references external hosts. Lorebook runs air-gapped, so every
// script, stylesheet, font and image must be served from its own origin.
//
// HTML and CSS may not contain any absolute URL (except XML namespaces). JS bundles may only
// mention allowlisted hosts, which appear in library error messages and XML namespaces and are
// never fetched.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.argv[2] ?? 'web/dist';
const NAMESPACE_HOSTS = new Set(['www.w3.org']);
// Hosts that only appear inside library error messages, doc links and XML namespace strings. They are
// never fetched (and the Content-Security-Policy's connect-src 'self' would block it if they were).
// Mermaid's parsers (chevrotain, langium), its ELK layout engine (eclipse.org namespaces) and the bundler
// account for most of them.
const JS_ALLOWED_HOSTS = new Set([
  ...NAMESPACE_HOSTS, 'react.dev', 'reactrouter.com', 'localhost',
  'github.com', 'chevrotain.io', 'langium.org', 'www.eclipse.org', 'en.wikipedia.org', 'rolldown.rs',
]);
const urlRe = /\b(?:https?:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+|localhost)(?=[/:"'`)\s])/gi;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const problems = [];
let files = 0;
for (const file of walk(root)) {
  const ext = extname(file);
  if (!['.html', '.css', '.js', '.mjs', '.svg', '.json', '.webmanifest'].includes(ext)) continue;
  files++;
  const text = readFileSync(file, 'utf8');
  const allowed = ext === '.js' || ext === '.mjs' ? JS_ALLOWED_HOSTS : NAMESPACE_HOSTS;
  for (const m of text.matchAll(urlRe)) {
    const host = m[1].toLowerCase();
    if (!m[0].includes('//')) continue;
    if (!allowed.has(host)) {
      const at = text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ');
      problems.push(`${file}: external host "${host}" … ${at} …`);
    }
  }
}

if (files === 0) {
  console.error(`check-offline: no files found under ${root}. Build the frontend first.`);
  process.exit(2);
}
if (problems.length) {
  console.error(`check-offline: ${problems.length} external reference(s) found:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`check-offline: OK (${files} files, no external hosts)`);
