import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, formatDay, pagePath, timeAgo, type Space, type StaleRow } from '../lib/api';
import { ReviewBadge } from '../components/ReviewBadge';
import { useUser } from '../lib/session';
import { DraftList } from '../components/DraftList';

type Recent = { id: number; title: string; slug: string; updatedAt: string; spaceKey: string; spaceName: string; updatedBy: string };

export function HomePage() {
  const user = useUser();
  const recent = useQuery({ queryKey: ['recent'], queryFn: () => api.get<Recent[]>('/pages/recent?limit=15') });
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<Space[]>('/spaces') });
  const stale = useQuery({ queryKey: ['stale', `mine-${user.id}`], queryFn: () => api.get<StaleRow[]>(`/stale?owner=${user.id}&includeDue=1`) });

  return (
    <div className="content home">
      <h1>Welcome, {user.displayName}</h1>
      {spaces.data?.length === 0 && (
        <div className="callout">
          {user.role === 'admin'
            ? <>There are no Spaces yet. <Link to="/admin">Create the first Space</Link> to start writing.</>
            : <>There are no Spaces yet. Ask an admin to create one.</>}
        </div>
      )}
      <div className="home-grid">
        <section className="card">
          <h2>Recently updated</h2>
          <ul className="plain-list">
            {recent.data?.map((p) => (
              <li key={p.id}>
                <Link to={pagePath(p)}>{p.title}</Link>
                <span className="muted small"> · {p.spaceName} · {p.updatedBy}, {timeAgo(p.updatedAt)}</span>
              </li>
            ))}
            {recent.data?.length === 0 && <li className="muted">Nothing yet.</li>}
          </ul>
        </section>
        <section className="card">
          <h2>My drafts</h2>
          <DraftList />
        </section>
        <section className="card">
          <h2>My pages to review</h2>
          <ul className="plain-list">
            {stale.data?.slice(0, 10).map((p) => (
              <li key={p.id}>
                <Link to={pagePath(p)}>{p.title}</Link>
                <span className="muted small"> · {p.spaceName} · by {formatDay(p.reviewBy)}</span> <ReviewBadge status={p.status} reviewBy={p.status === 'overdue' ? p.reviewBy : null} />
              </li>
            ))}
            {stale.data?.length === 0 && <li className="muted">Nothing due. Your pages are up to date.</li>}
          </ul>
          {stale.data && stale.data.length > 10 && <Link className="small" to={`/stale?owner=${user.id}&includeDue=1`}>All {stale.data.length} →</Link>}
        </section>
        <section className="card">
          <h2>Spaces</h2>
          <ul className="plain-list">
            {spaces.data?.map((s) => (
              <li key={s.id}>
                <Link to={`/s/${s.key}`}>{s.name}</Link>
                <span className="muted small"> · {s.pageCount} pages</span>
                {s.description && <div className="muted small">{s.description}</div>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
