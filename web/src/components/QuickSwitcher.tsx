import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, pagePath } from '../lib/api';

type Hit = { id: number; title: string; slug: string; spaceKey: string; spaceName: string };

export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 120);
    return () => clearTimeout(t);
  }, [q]);

  const { data = [] } = useQuery({
    queryKey: ['quick', debounced],
    queryFn: () => api.get<Hit[]>(`/pages/quick?q=${encodeURIComponent(debounced)}`),
    placeholderData: keepPreviousData,
  });

  useEffect(() => setSel(0), [data]);

  // The last row searches all content for the typed text.
  const rows = q.trim() ? data.length + 1 : data.length;
  const go = (i: number) => {
    onClose();
    if (i === data.length && q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
    else if (data[i]) navigate(pagePath(data[i]));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="switcher" role="dialog" aria-label="Jump to page">
        <input
          autoFocus
          placeholder="Type a page title…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, rows - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === 'Enter') go(sel);
          }}
        />
        <ul>
          {data.map((h, i) => (
            <li key={h.id} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
              <span className="title">{h.title}</span>
              <span className="muted">{h.spaceName}</span>
            </li>
          ))}
          {data.length === 0 && !q.trim() && <li className="muted empty">No pages found</li>}
          {q.trim() && (
            <li className={`search-all${sel === data.length ? ' sel' : ''}`} onMouseEnter={() => setSel(data.length)} onClick={() => go(data.length)}>
              <span>Search all pages for “{q.trim()}”</span>
              <span className="muted">Enter</span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
