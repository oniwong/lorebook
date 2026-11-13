import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, timeAgo } from '../lib/api';

type MyDraft = {
  pageId: number; title: string; status: 'active' | 'expired' | 'broken'; updatedAt: string; stale: boolean;
  slug: string; spaceKey: string; spaceName: string;
};

const statusText: Record<MyDraft['status'], string> = {
  active: 'checked out',
  expired: 'check-out expired',
  broken: 'check-out broken by an admin',
};

export function DraftList() {
  const qc = useQueryClient();
  const drafts = useQuery({ queryKey: ['drafts'], queryFn: () => api.get<MyDraft[]>('/me/drafts') });

  const remove = async (d: MyDraft) => {
    if (!confirm(`Throw away your draft of “${d.title}”?`)) return;
    await api.post(`/pages/${d.pageId}/discard`);
    await qc.invalidateQueries({ queryKey: ['drafts'] });
  };

  if (!drafts.data) return null;
  if (drafts.data.length === 0) return <p className="muted">No drafts.</p>;
  return (
    <ul className="plain-list">
      {drafts.data.map((d) => (
        <li key={d.pageId}>
          <Link to={`/p/${d.pageId}/edit`}>{d.title}</Link>
          <span className="muted small"> · {d.spaceName} · {statusText[d.status]}, saved {timeAgo(d.updatedAt)}</span>
          {d.stale && <span className="badge warn small">page changed since</span>}
          <button className="link-btn small" onClick={() => void remove(d)}>discard</button>
        </li>
      ))}
    </ul>
  );
}
