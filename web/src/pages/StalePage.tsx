import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, formatDateTime, formatDay, pagePath, type DirectoryUser, type Space, type StaleRow } from '../lib/api';
import { ReviewBadge } from '../components/ReviewBadge';
import { ErrorBox } from '../components/ErrorBox';

/** Pages past their review date (spec §11), filterable by Space and owner. */
export function StalePage() {
  const [params, setParams] = useSearchParams();
  const qs = new URLSearchParams();
  for (const k of ['space', 'owner', 'includeDue', 'former']) if (params.get(k)) qs.set(k, params.get(k)!);
  const rows = useQuery({ queryKey: ['stale', qs.toString()], queryFn: () => api.get<StaleRow[]>(`/stale?${qs.toString()}`) });
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<Space[]>('/spaces') });
  const people = useQuery({ queryKey: ['directory'], queryFn: () => api.get<DirectoryUser[]>('/users/directory') });

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <div className="content wide">
      <h1>Stale pages</h1>
      <p className="muted">Pages past their review-by date. Open one and choose <em>Review…</em> to confirm it is still correct, or edit it.</p>
      <div className="form inline-form filters-row">
        <label>Space
          <select value={params.get('space') ?? ''} onChange={(e) => set('space', e.target.value || null)}>
            <option value="">All Spaces</option>
            {spaces.data?.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </label>
        <label>Owner
          <select value={params.get('owner') ?? ''} onChange={(e) => set('owner', e.target.value || null)}>
            <option value="">Anyone</option>
            {people.data?.map((u) => <option key={u.id} value={u.id}>{u.displayName}{u.active ? '' : ' (former)'}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={params.get('includeDue') === '1'} onChange={(e) => set('includeDue', e.target.checked ? '1' : null)} /> Also due in the next 2 weeks</label>
        <label className="check"><input type="checkbox" checked={params.get('former') === '1'} onChange={(e) => set('former', e.target.checked ? '1' : null)} /> Owner is a former user</label>
      </div>
      {rows.error && <ErrorBox error={rows.error} />}
      {rows.data && rows.data.length === 0 && <p className="callout">Nothing is waiting for review. 🎉</p>}
      {rows.data && rows.data.length > 0 && (
        <table className="data-table">
          <thead><tr><th>Page</th><th>Space</th><th>Owner</th><th>Review by</th><th>Last reviewed</th></tr></thead>
          <tbody>
            {rows.data.map((r) => (
              <tr key={r.id}>
                <td><Link to={pagePath(r)}>{r.title}</Link></td>
                <td>{r.spaceName}</td>
                <td>{r.owner.displayName}{!r.owner.active && <span className="badge warn" title="Ask an admin to reassign this page">former user</span>}</td>
                <td className="nowrap">{formatDay(r.reviewBy)} <ReviewBadge status={r.status} reviewBy={r.status === 'overdue' ? r.reviewBy : null} /></td>
                <td className="nowrap muted">{formatDateTime(r.lastReviewedAt)}{r.reviewedByName ? ` by ${r.reviewedByName}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
