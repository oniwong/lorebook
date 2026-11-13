import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

/** Tags on the page view: links to search, plus an inline editor with autocomplete from existing tags. */
export function TagEditor({ pageId, tags, readOnlyReason }: { pageId: number; tags: string[]; readOnlyReason?: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [list, setList] = useState<string[]>(tags);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const suggestions = useQuery({
    queryKey: ['tags', input],
    queryFn: () => api.get<{ tag: string; count: number }[]>(`/tags?q=${encodeURIComponent(input)}`),
    enabled: editing,
  });

  const add = (raw: string) => {
    const t = raw.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
    if (t && !list.includes(t)) setList([...list, t]);
    setInput('');
  };

  const save = async () => {
    const final = input.trim() ? [...list, input] : list;
    setError(null);
    try {
      const r = await api.put<{ tags: string[] }>(`/pages/${pageId}/tags`, { tags: final });
      setList(r.tags);
      setInput('');
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ['page', pageId] });
      await qc.invalidateQueries({ queryKey: ['tags'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!editing) {
    return (
      <div className="tag-row">
        {tags.map((t) => <Link key={t} className="tag" to={`/search?tag=${encodeURIComponent(t)}`}>#{t}</Link>)}
        <button className="link-btn small" disabled={!!readOnlyReason} title={readOnlyReason}
          onClick={() => { setList(tags); setEditing(true); }}>
          {tags.length ? 'Edit tags' : '+ Add tags'}
        </button>
      </div>
    );
  }

  const options = (suggestions.data ?? []).filter((s) => !list.includes(s.tag)).slice(0, 8);
  return (
    <div className="tag-row editing">
      {list.map((t) => (
        <span key={t} className="tag">#{t} <button className="tag-x" aria-label={`Remove ${t}`} onClick={() => setList(list.filter((x) => x !== t))}>×</button></span>
      ))}
      <span className="tag-input-wrap">
        <input
          autoFocus
          className="tag-input"
          list={`tag-options-${pageId}`}
          value={input}
          placeholder="Add a tag"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && input.trim()) { e.preventDefault(); add(input); }
            else if (e.key === 'Enter') { e.preventDefault(); void save(); }
            else if (e.key === 'Backspace' && !input && list.length) setList(list.slice(0, -1));
            else if (e.key === 'Escape') setEditing(false);
          }}
        />
        <datalist id={`tag-options-${pageId}`}>
          {options.map((o) => <option key={o.tag} value={o.tag}>{o.count} pages</option>)}
        </datalist>
      </span>
      <button className="small primary" onClick={() => void save()}>Save</button>
      <button className="small" onClick={() => setEditing(false)}>Cancel</button>
      {error && <span className="text-danger small">{error}</span>}
    </div>
  );
}
