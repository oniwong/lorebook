import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { renderMarkdown, type Heading } from '../lib/markdown';
import { markInternalLinks, renderDiagrams } from '../lib/enhance';

type Props = {
  source: string;
  onHeadings?: (h: Heading[]) => void;
  className?: string;
};

/** Renders sanitised Markdown, Mermaid diagrams and broken-link markers. Same-origin links navigate inside the app. */
export const MarkdownView = forwardRef<HTMLDivElement, Props>(function MarkdownView({ source, onHeadings, className }, ref) {
  const [html, setHtml] = useState('');
  const navigate = useNavigate();
  const inner = useRef<HTMLDivElement | null>(null);

  const setRefs = useCallback((el: HTMLDivElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  }, [ref]);

  useEffect(() => {
    let cancelled = false;
    renderMarkdown(source).then(
      (r) => {
        if (cancelled) return;
        setHtml(r.html);
        onHeadings?.(r.headings);
      },
      (e) => { if (!cancelled) setHtml(`<p class="render-error">Could not render: ${String(e).replace(/</g, '&lt;')}</p>`); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || !html) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    void renderDiagrams(el, isCancelled);
    void markInternalLinks(el, isCancelled);
    return () => { cancelled = true; };
  }, [html]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const href = a.getAttribute('href');
    if (!href) return;
    if (href.startsWith('#')) {
      e.preventDefault();
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    // Attachments are files, not app routes: let the browser open or download them.
    if (href.startsWith('/') && !href.startsWith('/api/')) {
      e.preventDefault();
      navigate(href);
    }
  };

  return <div ref={setRefs} className={`markdown ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
