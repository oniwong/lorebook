// Post-render enhancements for rendered Markdown: Mermaid diagrams and broken internal links.
import { api, type PageRef } from './api';

let mermaidLoader: Promise<typeof import('mermaid').default> | null = null;
let diagramSeq = 0;
const svgCache = new Map<string, string>();

function isDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function loadMermaid() {
  mermaidLoader ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      // Strict: no click handlers or HTML labels from diagram source.
      securityLevel: 'strict',
      theme: isDark() ? 'dark' : 'default',
      fontFamily: 'inherit',
    });
    return m.default;
  });
  return mermaidLoader;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Renders every .mermaid-block in `root`. A syntax error shows inline; the rest of the page is unaffected. */
export async function renderDiagrams(root: HTMLElement, isCancelled: () => boolean): Promise<void> {
  // Synchronous pass first: diagrams rendered before (e.g. while typing in the editor) appear without flicker.
  const pending: HTMLElement[] = [];
  for (const block of root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-done])')) {
    const svg = svgCache.get(block.querySelector('.mermaid-src')?.textContent ?? '');
    if (svg) {
      block.innerHTML = svg;
      block.dataset.done = 'ok';
    } else {
      pending.push(block);
    }
  }
  if (!pending.length) return;
  const mermaid = await loadMermaid();
  for (const block of pending) {
    if (isCancelled()) return;
    const src = block.querySelector('.mermaid-src')?.textContent ?? '';
    const id = `mmd-${++diagramSeq}`;
    try {
      const { svg } = await mermaid.render(id, src);
      if (svgCache.size > 100) svgCache.delete(svgCache.keys().next().value!);
      svgCache.set(src, svg);
      if (isCancelled()) return;
      block.innerHTML = svg;
      block.dataset.done = 'ok';
    } catch (e) {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      if (isCancelled()) return;
      const msg = e instanceof Error ? e.message : String(e);
      block.innerHTML = `<div class="mermaid-error"><strong>Diagram error:</strong> ${escapeHtml(msg)}</div><pre>${escapeHtml(src)}</pre>`;
      block.dataset.done = 'error';
    }
  }
}

const INTERNAL = /^(?:https?:\/\/[^/]+)?\/(?:s\/[a-z0-9-]+\/)?p\/(\d{1,9})(?![\w-])/i;
const cache = new Map<number, { at: number; page: PageRef | null }>();
const CACHE_MS = 30_000;

/** Pages that link to deleted or non-existent pages get a "broken" marker; live ones get their title as a tooltip. */
export async function markInternalLinks(root: HTMLElement, isCancelled: () => boolean): Promise<void> {
  const anchors: { a: HTMLAnchorElement; id: number }[] = [];
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href')!;
    if (/^https?:/i.test(href) && !href.startsWith(window.location.origin)) continue;
    const m = INTERNAL.exec(href);
    if (m) anchors.push({ a, id: Number(m[1]) });
  }
  if (!anchors.length) return;
  const now = Date.now();
  const missing = [...new Set(anchors.map((x) => x.id))].filter((id) => {
    const c = cache.get(id);
    return !c || now - c.at > CACHE_MS;
  });
  if (missing.length) {
    try {
      const live = await api.get<PageRef[]>(`/pages/lookup?ids=${missing.slice(0, 200).join(',')}`);
      const byId = new Map(live.map((p) => [p.id, p]));
      for (const id of missing) cache.set(id, { at: now, page: byId.get(id) ?? null });
    } catch {
      return;
    }
  }
  if (isCancelled()) return;
  for (const { a, id } of anchors) {
    const page = cache.get(id)?.page;
    if (page === undefined) continue;
    if (page) {
      a.classList.remove('broken-link');
      a.title = `${page.spaceName} / ${page.title}`;
    } else {
      a.classList.add('broken-link');
      a.title = 'Broken link: this page is deleted or does not exist';
    }
  }
}

export function forgetPageLookups(): void {
  cache.clear();
}
