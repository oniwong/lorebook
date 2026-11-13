import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pagePath, timeAgo, type ChangeRequestSummary, type InboxItem } from '../lib/api';
import { ChangeRequestList } from '../components/ChangeRequestList';
import { useState } from 'react';

/** One line describing an inbox item. */
export function describe(i: InboxItem): string {
  const who = i.actor?.displayName ?? 'Someone';
  const page = i.page ? `“${i.page.title}”` : 'a deleted page';
  switch (i.kind) {
    case 'cr_submitted': return `${who} suggested a change to ${page}`;
    case 'cr_resubmitted': return `${who} updated their suggested change to ${page}`;
    case 'cr_comment': return `${who} commented on a change request for ${page}`;
    case 'cr_changes_requested': return `${who} asked for changes to your suggestion for ${page}`;
    case 'cr_approved': return `${who} approved your change to ${page}`;
    case 'cr_rejected': return `${who} rejected your change to ${page}`;
    case 'cr_withdrawn': return `${who} withdrew their suggested change to ${page}`;
    case 'cr_outdated': return `${page} changed after you suggested a change. Update your request onto the latest version`;
    case 'checkout_broken': return `${who} broke your check-out of ${page}. Your draft is kept in My drafts`;
    case 'checkout_expired': return `Your check-out of ${page} expired. Your draft is kept in My drafts`;
    case 'page_locked': return `${who} locked your page ${page}`;
    case 'page_unlocked': return `${who} unlocked your page ${page}`;
    case 'owner_assigned': return `${who} made you the owner of ${page}`;
    case 'owner_removed': return `${who} gave ${page} to a new owner`;
    case 'review_due': return `${page} is due for review soon`;
    case 'review_overdue': return `${page} is overdue for review`;
    case 'former_owner': return `${page} belongs to a former user and needs a new owner`;
    default: return `${i.kind} on ${page}`;
  }
}

/** Where clicking an item takes you. */
function target(i: InboxItem): string | null {
  if (i.changeRequestId) return i.kind === 'cr_outdated' || i.kind === 'cr_changes_requested' ? `/cr/${i.changeRequestId}/edit` : `/cr/${i.changeRequestId}`;
  if (!i.page || i.page.trashed) return null;
  if (i.kind === 'checkout_broken' || i.kind === 'checkout_expired') return `/p/${i.page.id}/edit`;
  return pagePath(i.page);
}

export function InboxPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const items = useQuery({
    queryKey: ['inbox', unreadOnly],
    queryFn: () => api.get<InboxItem[]>(`/inbox?limit=100${unreadOnly ? '&unread=1' : ''}`),
    refetchInterval: 60_000,
  });
  const toReview = useQuery({ queryKey: ['crs', 'toReview'], queryFn: () => api.get<ChangeRequestSummary[]>('/change-requests?toReview=1') });
  const mine = useQuery({
    queryKey: ['crs', 'mine'],
    queryFn: () => api.get<ChangeRequestSummary[]>('/change-requests?mine=1&status=draft,open,changes_requested'),
  });

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['inbox'] });
    await qc.invalidateQueries({ queryKey: ['inbox-count'] });
  };
  const open = async (i: InboxItem) => {
    if (!i.readAt) {
      await api.post('/inbox/read', { ids: [i.id] });
      void refresh();
    }
    const to = target(i);
    if (to) navigate(to);
  };
  const markAll = async () => {
    await api.post('/inbox/read', { all: true });
    await refresh();
  };

  const unread = items.data?.filter((i) => !i.readAt).length ?? 0;

  return (
    <div className="content">
      <h1>Inbox</h1>
      {!!toReview.data?.length && (
        <section className="card">
          <h2>Waiting for your review</h2>
          <ChangeRequestList items={toReview.data} empty="" />
        </section>
      )}
      {!!mine.data?.length && (
        <section className="card">
          <h2>Your open change requests</h2>
          <ChangeRequestList items={mine.data} empty="" />
        </section>
      )}
      <div className="inbox-head">
        <h2>Notifications</h2>
        <label className="check small"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only</label>
        <button className="small" disabled={!unread} onClick={() => void markAll()}>Mark all read</button>
      </div>
      {items.data?.length === 0 && <p className="muted">{unreadOnly ? 'Nothing unread.' : 'Nothing here yet. Change requests, lost check-outs and review reminders show up here.'}</p>}
      <ul className="inbox-list">
        {items.data?.map((i) => {
          const to = target(i);
          return (
            <li key={i.id} className={i.readAt ? 'read' : 'unread'}>
              <button className="inbox-item" onClick={() => void open(i)} disabled={!to && !!i.readAt}>
                <span className="inbox-text">{describe(i)}</span>
                {i.text && <span className="inbox-quote">“{i.text}”</span>}
                <span className="muted small">{timeAgo(i.createdAt)}{i.page?.trashed ? ' · page is in the trash' : ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Pages you own that are due for review are also listed under <Link to="/stale">Stale pages</Link>.</p>
    </div>
  );
}
