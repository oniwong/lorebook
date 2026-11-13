import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  api, formatDay, pagePath, timeAgo, type DirectoryUser, type SearchResult, type Space, type Template,
} from '../lib/api';
import { Highlighted } from '../components/Highlighted';
import { ErrorBox } from '../components/ErrorBox';

const PAGE_SIZE = 20;
const FILTER_KEYS = ['space', 'tag', 'owner', 'author', 'template', 'updatedFrom', 'updatedTo', 'review', 'hasAttachments', 'codeOnly'] as const;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const offset = Number(params.get('offset') ?? 0) || 0;
  const [input, setInput] = useState(q);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => setInput(q), [q]);

  const apiQuery = new URLSearchParams(params);
  apiQuery.set('limit', String(PAGE_SIZE));
  const hasFilter = FILTER_KEYS.some((k) => params.get(k));
  const enabled = !!q.trim() || hasFilter;
  const results = useQuery({
    queryKey: ['search', apiQuery.toString()],
    queryFn: () => api.get<SearchResult>(`/search?${apiQuery.toString()}`),
    enabled,
    placeholderData: keepPreviousData,
  });

  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<Space[]>('/spaces') });
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<Template[]>('/templates') });
  const people = useQuery({ queryKey: ['directory'], queryFn: () => api.get<DirectoryUser[]>('/users/directory') });
  const tags = useQuery({ queryKey: ['tags', ''], queryFn: () => api.get<{ tag: string; count: number }[]>('/tags') });

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('offset');
    setParams(next, { replace: key !== 'q' });
  };

  const goOffset = (n: number) => {
    const next = new URLSearchParams(params);
    if (n > 0) next.set('offset', String(n));
    else next.delete('offset');
    setParams(next);
    window.scrollTo(0, 0);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    set('q', input.trim() || null);
  };

  const clearFilters = () => {
    const next = new URLSearchParams();
    if (q) next.set('q', q);
    setParams(next);
  };

  const data = results.data;
  const selectedTags = (params.get('tag') ?? '').split(',').filter(Boolean);

  return (
    <div className="content wide search-page">
      <form className="search-bar" onSubmit={submit} role="search">
        <input
          autoFocus
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Search pages, code and attachments…  e.g. srv-db-01, "reset password", vpn -legacy'
          aria-label="Search"
        />
        <button className="primary" type="submit">Search</button>
      </form>

      <div className="search-layout">
        <button className="filters-toggle" onClick={() => setFiltersOpen((v) => !v)} aria-expanded={filtersOpen}>
          Filters{hasFilter ? ` (${FILTER_KEYS.filter((k) => params.get(k)).length})` : ''} {filtersOpen ? '▴' : '▾'}
        </button>
        <aside className={`search-filters${filtersOpen ? ' open' : ''}`} aria-label="Filters">
          <label>Space
            <select value={params.get('space') ?? ''} onChange={(e) => set('space', e.target.value || null)}>
              <option value="">All Spaces</option>
              {spaces.data?.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
            </select>
          </label>
          <label>Tag
            <select value="" onChange={(e) => e.target.value && set('tag', [...selectedTags, e.target.value].join(','))}>
              <option value="">{selectedTags.length ? 'Add another tag…' : 'Any tag'}</option>
              {tags.data?.filter((t) => !selectedTags.includes(t.tag)).map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}
            </select>
          </label>
          {selectedTags.length > 0 && (
            <div className="tag-row">
              {selectedTags.map((t) => (
                <span key={t} className="tag">#{t} <button className="tag-x" aria-label={`Remove ${t}`} onClick={() => set('tag', selectedTags.filter((x) => x !== t).join(',') || null)}>×</button></span>
              ))}
            </div>
          )}
          <label>Owner
            <select value={params.get('owner') ?? ''} onChange={(e) => set('owner', e.target.value || null)}>
              <option value="">Anyone</option>
              {people.data?.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.active ? '' : ' (former)'}</option>)}
            </select>
          </label>
          <label>Edited by
            <select value={params.get('author') ?? ''} onChange={(e) => set('author', e.target.value || null)}>
              <option value="">Anyone</option>
              {people.data?.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.active ? '' : ' (former)'}</option>)}
            </select>
          </label>
          <label>Template
            <select value={params.get('template') ?? ''} onChange={(e) => set('template', e.target.value || null)}>
              <option value="">Any</option>
              {templates.data?.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          </label>
          <fieldset>
            <legend>Last updated</legend>
            <label className="row-label">From<input type="date" value={params.get('updatedFrom') ?? ''} onChange={(e) => set('updatedFrom', e.target.value || null)} /></label>
            <label className="row-label">To<input type="date" value={params.get('updatedTo') ?? ''} onChange={(e) => set('updatedTo', e.target.value || null)} /></label>
          </fieldset>
          <label>Review status
            <select value={params.get('review') ?? ''} onChange={(e) => set('review', e.target.value || null)}>
              <option value="">Any</option>
              <option value="overdue">Needs review (overdue)</option>
              <option value="due">Due in the next 2 weeks</option>
              <option value="current">Not overdue</option>
              <option value="none">No review date</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={params.get('hasAttachments') === '1'} onChange={(e) => set('hasAttachments', e.target.checked ? '1' : null)} />
            Has attachments
          </label>
          <label className="check">
            <input type="checkbox" checked={params.get('codeOnly') === '1'} onChange={(e) => set('codeOnly', e.target.checked ? '1' : null)} />
            Only inside code blocks
          </label>
          {hasFilter && <button className="link-btn small" onClick={clearFilters}>Clear filters</button>}
        </aside>

        <section className="search-results" aria-live="polite">
          {!enabled && (
            <div className="muted search-help">
              <p>Search titles, text, code blocks, tags and the text of attached files.</p>
              <ul className="small">
                <li>Exact technical strings work: <code>srv-db-01</code>, <code>10.20.30.41</code>, <code>0x80070005</code>, <code>/etc/krb5.conf</code></li>
                <li><code>"exact phrase"</code>, <code>-exclude</code>, <code>vpn OR wireguard</code></li>
                <li>Leave the box empty and pick filters to browse, e.g. everything that needs review in one Space.</li>
              </ul>
            </div>
          )}
          {results.error && <ErrorBox error={results.error} />}
          {enabled && data && (
            <>
              <div className="search-summary">
                <span className="muted small">{data.total === 1 ? '1 page' : `${data.total} pages`}{data.total > 0 && ` · ${data.tookMs} ms`}</span>
                {q.trim() && (
                  <select className="small-select" aria-label="Sort" value={params.get('sort') ?? 'relevance'} onChange={(e) => set('sort', e.target.value === 'relevance' ? null : e.target.value)}>
                    <option value="relevance">Best match</option>
                    <option value="updated">Recently updated</option>
                  </select>
                )}
              </div>
              {data.total === 0 && <p className="muted">Nothing found. Try fewer words, or remove a filter.</p>}
              <ol className="hits">
                {data.hits.map((h) => (
                  <li key={h.id} className="hit">
                    <Link className="hit-title" to={pagePath(h)}><Highlighted text={h.title} ranges={h.titleHighlights} /></Link>
                    <div className="hit-path muted small">{[h.spaceName, ...h.path].join(' / ')}</div>
                    {h.snippet && <p className="hit-snippet"><Highlighted text={h.snippet.text} ranges={h.snippet.highlights} /></p>}
                    {h.attachments.length > 0 && (
                      <div className="hit-attachments small">
                        <span className="muted">Matched in </span>{h.attachments.map((a) => a.filename).join(', ')}
                        {h.attachments[0].snippet && <p className="hit-snippet"><Highlighted text={h.attachments[0].snippet.text} ranges={h.attachments[0].snippet.highlights} /></p>}
                      </div>
                    )}
                    <div className="hit-meta muted small">
                      {h.owner.displayName}{!h.owner.active && ' (former user)'} · updated {timeAgo(h.updatedAt)}
                      {h.reviewBy && h.reviewBy < new Date().toISOString().slice(0, 10) && <span className="badge review-overdue">Needs review since {formatDay(h.reviewBy)}</span>}
                      {h.tags.map((t) => <button key={t} className="tag tag-btn" onClick={() => !selectedTags.includes(t) && set('tag', [...selectedTags, t].join(','))}>#{t}</button>)}
                    </div>
                  </li>
                ))}
              </ol>
              {data.total > PAGE_SIZE && (
                <nav className="pager">
                  <button disabled={offset === 0} onClick={() => goOffset(Math.max(0, offset - PAGE_SIZE))}>← Previous</button>
                  <span className="muted small">{offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}</span>
                  <button disabled={offset + PAGE_SIZE >= data.total} onClick={() => goOffset(offset + PAGE_SIZE)}>Next →</button>
                </nav>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
