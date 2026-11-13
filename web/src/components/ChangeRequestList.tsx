import { Link } from 'react-router-dom';
import { crStatusLabel, timeAgo, type ChangeRequestSummary } from '../lib/api';

export function CrStatusBadge({ status, outdated }: { status: ChangeRequestSummary['status']; outdated?: boolean }) {
  return (
    <>
      <span className={`badge cr-${status}`}>{crStatusLabel[status]}</span>
      {outdated && <span className="badge warn" title="The page changed after this was suggested">outdated</span>}
    </>
  );
}

/** A compact list of change requests. `showPage` adds the page title (for lists across pages). */
export function ChangeRequestList({ items, showPage = true, empty }: { items: ChangeRequestSummary[]; showPage?: boolean; empty: string }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="plain-list">
      {items.map((c) => (
        <li key={c.id}>
          <Link to={c.status === 'draft' ? `/cr/${c.id}/edit` : `/cr/${c.id}`}>
            {showPage ? c.page.title : `#${c.id}`}
          </Link>
          <span className="muted small">
            {' '}· {c.author.displayName}
            {c.description ? ` · “${c.description.split('\n')[0].slice(0, 80)}”` : ''}
            {' '}· {timeAgo(c.updatedAt)}
          </span>
          <CrStatusBadge status={c.status} outdated={c.outdated} />
        </li>
      ))}
    </ul>
  );
}
