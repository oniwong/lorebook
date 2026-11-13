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

  const go = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    navigate(pagePath(h));
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
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, data.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            else if (e.key === 'Enter') go(data[sel]);
          }}
        />
        <ul>
          {data.map((h, i) => (
            <li key={h.id} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
              <span className="title">{h.title}</span>
              <span className="muted">{h.spaceName}</span>
            </li>
          ))}
          {data.length === 0 && <li className="muted empty">No pages found</li>}
        </ul>
      </div>
    </div>
  );
}
