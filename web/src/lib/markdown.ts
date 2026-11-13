import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import rehypeShikiFromHighlighter from '@shikijs/rehype/core';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { Root, Element, ElementContent } from 'hast';

// Languages bundled for code highlighting. Everything is local; nothing is fetched at runtime.
const LANGS = [
  import('@shikijs/langs/bash'),
  import('@shikijs/langs/powershell'),
  import('@shikijs/langs/bat'),
  import('@shikijs/langs/yaml'),
  import('@shikijs/langs/json'),
  import('@shikijs/langs/ini'),
  import('@shikijs/langs/toml'),
  import('@shikijs/langs/xml'),
  import('@shikijs/langs/html'),
  import('@shikijs/langs/css'),
  import('@shikijs/langs/sql'),
  import('@shikijs/langs/python'),
  import('@shikijs/langs/javascript'),
  import('@shikijs/langs/typescript'),
  import('@shikijs/langs/go'),
  import('@shikijs/langs/csharp'),
  import('@shikijs/langs/nginx'),
  import('@shikijs/langs/apache'),
  import('@shikijs/langs/docker'),
  import('@shikijs/langs/diff'),
  import('@shikijs/langs/markdown'),
  import('@shikijs/langs/hcl'),
  import('@shikijs/langs/terraform'),
  import('@shikijs/langs/log'),
];

let highlighter: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
    langs: LANGS,
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

export type Heading = { depth: number; text: string; id: string };

function textOf(node: ElementContent | Element): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

function slugifyHeading(s: string): string {
  return s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || 'section';
}

/** Gives headings stable ids (after sanitising, so they aren't prefixed) and collects them for the outline. */
const rehypeHeadings: Plugin<[Heading[]], Root> = (out) => (tree) => {
  const seen = new Map<string, number>();
  const walk = (nodes: (Root | Element)['children']) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      const m = /^h([1-6])$/.exec(n.tagName);
      if (m) {
        const text = textOf(n);
        let id = slugifyHeading(text);
        const count = seen.get(id) ?? 0;
        seen.set(id, count + 1);
        if (count) id = `${id}-${count}`;
        n.properties = { ...n.properties, id };
        out.push({ depth: Number(m[1]), text, id });
      }
      walk(n.children);
    }
  };
  walk(tree.children);
};

/** Opens external links in a new tab. */
const rehypeExternalLinks: Plugin<[], Root> = () => (tree) => {
  const walk = (nodes: (Root | Element)['children']) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      if (n.tagName === 'a' && typeof n.properties?.href === 'string' && /^[a-z]+:/i.test(n.properties.href)) {
        n.properties.target = '_blank';
        n.properties.rel = ['noopener', 'noreferrer'];
      }
      walk(n.children);
    }
  };
  walk(tree.children);
};

/**
 * Turns ```mermaid blocks into placeholders that MarkdownView renders into diagrams (Mermaid is large,
 * so it is loaded only when a page has a diagram). Runs before Shiki so the source isn't highlighted.
 */
const rehypeMermaidBlocks: Plugin<[], Root> = () => (tree) => {
  const walk = (parent: Root | Element) => {
    parent.children.forEach((n, i) => {
      if (n.type !== 'element') return;
      const code = n.tagName === 'pre' ? n.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code') : undefined;
      const cls = code?.properties?.className;
      if (code && Array.isArray(cls) && cls.includes('language-mermaid')) {
        parent.children[i] = {
          type: 'element', tagName: 'div', properties: { className: ['mermaid-block'] },
          children: [{ type: 'element', tagName: 'pre', properties: { className: ['mermaid-src'] }, children: [{ type: 'text', value: textOf(code) }] }],
        };
        return;
      }
      walk(n);
    });
  };
  walk(tree);
};

const ATTACHMENT_HREF = /^\/api\/v1\/attachments\/\d+(?:\/([^?#]*))?/;

/** Marks links to attachments so CSS can show a file-type icon (draw.io, Visio, PDF, config files...). */
const rehypeAttachmentLinks: Plugin<[], Root> = () => (tree) => {
  const walk = (nodes: (Root | Element)['children']) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      const href = n.tagName === 'a' ? n.properties?.href : undefined;
      const m = typeof href === 'string' ? ATTACHMENT_HREF.exec(href) : null;
      if (m) {
        const name = decodeURIComponent(m[1] ?? '').toLowerCase();
        const ext = /\.drawio(\.(png|svg|xml))?$/.test(name) ? 'drawio'
          : /\.(vsdx?|vsdm)$/.test(name) ? 'visio'
          : /\.pdf$/.test(name) ? 'pdf'
          : /\.(png|jpe?g|gif|webp|svg|bmp)$/.test(name) ? 'image'
          : /\.(zip|gz|7z|tar|tgz)$/.test(name) ? 'archive'
          : /\.(conf|cfg|ini|ya?ml|json|xml|ps1|sh|txt|log|toml|env|sql|py|bat|cmd)$/.test(name) ? 'text'
          : 'file';
        n.properties = { ...n.properties, className: ['att-link', `att-${ext}`] };
      }
      walk(n.children);
    }
  };
  walk(tree.children);
};

const schema = {
  ...defaultSchema,
  // Keep our own heading ids unprefixed; we add them after sanitising anyway.
  clobberPrefix: 'user-content-',
};

export type Rendered = { html: string; headings: Heading[] };

export async function renderMarkdown(src: string): Promise<Rendered> {
  const hl = await getHighlighter();
  const headings: Heading[] = [];
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    // Sanitise first: everything after this point is generated by us, not by the author.
    .use(rehypeSanitize, schema)
    .use(rehypeMermaidBlocks)
    .use(rehypeAttachmentLinks)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- HighlighterCore is structurally fine; the generic variance trips TS
    .use(rehypeShikiFromHighlighter, hl as any, {
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
      fallbackLanguage: 'text',
    })
    .use(rehypeHeadings, headings)
    .use(rehypeExternalLinks)
    .use(rehypeStringify)
    .process(src);
  return { html: String(file), headings };
}

const PREVIEW_LANG: Record<string, string> = {
  conf: 'nginx', cfg: 'ini', ini: 'ini', cnf: 'ini', properties: 'ini', env: 'ini', reg: 'ini', toml: 'toml',
  yaml: 'yaml', yml: 'yaml', json: 'json', xml: 'xml', drawio: 'xml', html: 'html', htm: 'html', css: 'css',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'bat', cmd: 'bat', sh: 'bash', bash: 'bash',
  zsh: 'bash', py: 'python', js: 'javascript', ts: 'typescript', sql: 'sql', tf: 'terraform', hcl: 'hcl',
  go: 'go', cs: 'csharp', diff: 'diff', patch: 'diff', md: 'markdown', log: 'log', dockerfile: 'docker',
};

/** Renders a text attachment as a highlighted code block, using the same pipeline as pages. */
export async function renderTextFile(filename: string, text: string): Promise<string> {
  const lower = filename.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop()! : lower;
  const lang = PREVIEW_LANG[ext] ?? 'text';
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return (await renderMarkdown(`${fence}${lang}\n${text}\n${fence}`)).html;
}
