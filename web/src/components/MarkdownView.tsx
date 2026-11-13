import { forwardRef, useEffect, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { renderMarkdown, type Heading } from '../lib/markdown';

type Props = {
  source: string;
  onHeadings?: (h: Heading[]) => void;
  className?: string;
};

/** Renders sanitised Markdown. Same-origin links navigate inside the app. */
export const MarkdownView = forwardRef<HTMLDivElement, Props>(function MarkdownView({ source, onHeadings, className }, ref) {
  const [html, setHtml] = useState('');
  const navigate = useNavigate();

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
    if (href.startsWith('/')) {
      e.preventDefault();
      navigate(href);
    }
  };

  return <div ref={ref} className={`markdown ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
