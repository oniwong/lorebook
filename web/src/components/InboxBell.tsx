import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** Bell in the top bar with the number of unread inbox items. Polls once a minute. */
export function InboxBell() {
  const q = useQuery({
    queryKey: ['inbox-count'],
    queryFn: () => api.get<{ unread: number; toReview: number }>('/inbox/count'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const n = q.data?.unread ?? 0;
  const review = q.data?.toReview ?? 0;
  const label = [n ? `${n} unread` : 'No unread items', review ? `${review} change request${review === 1 ? '' : 's'} to review` : '']
    .filter(Boolean).join(', ');
  return (
    <Link to="/inbox" className="bell" aria-label={`Inbox: ${label}`} title={label}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {n > 0 && <span className="bell-count">{n > 99 ? '99+' : n}</span>}
    </Link>
  );
}
