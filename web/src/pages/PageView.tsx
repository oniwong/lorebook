import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, formatDateTime, formatDay, formatTime, pagePath, timeAgo, type ChangeRequestSummary, type Page, type PageRef } from '../lib/api';
import { useUser } from '../lib/session';
import type { Heading } from '../lib/markdown';
import { MarkdownView } from '../components/MarkdownView';
import { ErrorBox } from '../components/ErrorBox';
import { NewPageDialog } from '../components/NewPageDialog';
import { AttachmentsPanel } from '../components/AttachmentsPanel';
import { MoveDialog } from '../components/MoveDialog';
import { DeleteDialog } from '../components/DeleteDialog';
import { TagEditor } from '../components/TagEditor';
import { ReviewBadge } from '../components/ReviewBadge';
import { ReviewDialog } from '../components/ReviewDialog';
import { SecretFindings } from '../components/SecretFindings';
import { OwnerDialog } from '../components/OwnerDialog';
import { ChangeRequestList } from '../components/ChangeRequestList';

export function PageView() {
  const { key, id, slug } = useParams();
  const pageId = Number(id);
  const user = useUser();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [newChild, setNewChild] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dialog, setDialog] = useState<'move' | 'delete' | 'review' | 'owner' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [showFindings, setShowFindings] = useState(false);
  const q = useQuery({ queryKey: ['page', pageId], queryFn: () => api.get<Page>(`/pages/${pageId}`), refetchInterval: 30_000 });
  const backlinks = useQuery({
    queryKey: ['backlinks', pageId],
    queryFn: () => api.get<PageRef[]>(`/pages/${pageId}/backlinks`),
    enabled: !!q.data,
  });
  const openCrs = useQuery({
    queryKey: ['page-crs', pageId],
    queryFn: () => api.get<ChangeRequestSummary[]>(`/pages/${pageId}/change-requests?status=open,changes_requested`),
    enabled: !!q.data && q.data.changeRequests.open > 0,
  });

  useEffect(() => setHeadings([]), [pageId]);

  if (q.error) return <div className="content"><ErrorBox error={q.error} /></div>;
  const page = q.data;
  if (!page) return null;
  // Old slugs and moved pages redirect to the current URL; lookups only use the id.
  if (page.slug !== slug || page.spaceKey !== key) return <Navigate to={pagePath(page) + window.location.hash} replace />;

  const co = page.checkout;
  const lockedByOther = co && !co.mine;
  const canReview = page.owner.id === user.id || user.role === 'admin';
  const isOwner = page.owner.id === user.id;
  const canLock = isOwner || user.role === 'admin';
  const blockedReason = lockedByOther ? `Checked out by ${co!.displayName}` : !page.canEdit ? `Locked by ${page.owner.displayName}` : undefined;

  const toggleLock = async () => {
    setActionError(null);
    try {
      if (page.locked && !isOwner && !confirm(`Unlock ${page.owner.displayName}'s page? They are told in their inbox.`)) return;
      await api.post(`/pages/${page.id}/lock`, { locked: !page.locked });
      await qc.invalidateQueries({ queryKey: ['page', pageId] });
      await qc.invalidateQueries({ queryKey: ['tree', page.spaceKey] });
    } catch (e) {
      setActionError(e instanceof ApiError && e.code === 'checked_out'
        ? new Error(`${e.message}. Lock it after they check in.`) : e);
    }
  };

  const suggestChange = async () => {
    setActionError(null);
    try {
      const r = await api.post<{ id: number }>(`/pages/${page.id}/change-requests`, {});
      navigate(`/cr/${r.id}/edit`);
    } catch (e) {
      setActionError(e);
    }
  };
  const review = page.review;

  const breakCheckout = async () => {
    if (!confirm(`Break ${co!.displayName}'s check-out? Their draft is kept for them.`)) return;
    await api.post(`/pages/${page.id}/break-checkout`);
    await qc.invalidateQueries({ queryKey: ['page', pageId] });
    await qc.invalidateQueries({ queryKey: ['tree', page.spaceKey] });
  };

  const copyLink = async () => {
    const url = `${window.location.origin}/p/${page.id}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      prompt('Copy this link', url);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const exportMd = () => {
    const blob = new Blob([`# ${page.title}\n\n${page.body}`], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${page.slug}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="page-layout">
      <article className="content page">
        <nav className="breadcrumbs" aria-label="Breadcrumbs">
          <Link to={`/s/${page.spaceKey}`}>{page.spaceName}</Link>
          {page.breadcrumbs.map((b) => (
            <span key={b.id}> / <Link to={pagePath({ spaceKey: page.spaceKey, id: b.id, slug: b.slug })}>{b.title}</Link></span>
          ))}
        </nav>

        {co && (
          <div className={`banner ${co.mine ? 'info' : 'warn'}`}>
            {co.mine ? (
              <>You have this page checked out since {formatTime(co.since)}. <Link to={`/p/${page.id}/edit`}>Continue editing</Link></>
            ) : (
              <>
                Checked out by <strong>{co.displayName}</strong> since {formatTime(co.since)}. The page is read-only until they check in.
                {user.role === 'admin' && <button className="link-btn" onClick={() => void breakCheckout()}>Break check-out</button>}
              </>
            )}
          </div>
        )}
        {!co && page.myDraft && (
          <div className="banner info">
            You have an unsaved draft of this page from {timeAgo(page.myDraft.updatedAt)}. <Link to={`/p/${page.id}/edit`}>Resume editing</Link>
          </div>
        )}

        {review.status === 'overdue' && (
          <div className="banner warn">
            <strong>Needs review</strong> — last reviewed {formatDay(review.lastReviewedAt.slice(0, 10))}
            {review.reviewBy && <>, review was due {formatDay(review.reviewBy)}</>}.
            {canReview
              ? <button className="link-btn" onClick={() => setDialog('review')}>Review it now</button>
              : <> Ask {page.owner.displayName}{!page.owner.active && ' (former user)'} or suggest changes.</>}
          </div>
        )}
        {page.secretFindings.length > 0 && (
          <div className="banner danger">
            This page looks like it contains {page.secretFindings.length === 1 ? 'a password or key' : `${page.secretFindings.length} passwords or keys`}.
            Store secrets in the password vault and link to the entry instead.{' '}
            <button className="link-btn" onClick={() => setShowFindings((v) => !v)}>{showFindings ? 'Hide' : 'Show where'}</button>
            {showFindings && <SecretFindings findings={page.secretFindings} />}
          </div>
        )}

        {page.changeRequests.mineId && (
          <div className="banner info">
            You have a change request on this page. <Link to={`/cr/${page.changeRequests.mineId}`}>Open it</Link>
          </div>
        )}
        {page.locked && !page.canEdit && !page.changeRequests.mineId && (
          <div className="banner info lock-banner">
            🔒 {page.owner.displayName} has locked this page{!page.owner.active && ' (former user, so admins review changes)'}. To change it, suggest a change and they'll review it.
          </div>
        )}
        {actionError != null && <ErrorBox error={actionError} />}

        <header className="page-head">
          <h1>{page.locked && <span className="lock-icon" title={`Locked${page.lock?.by ? ` by ${page.lock.by.displayName}` : ''}: only the owner and admins edit directly`} aria-label="Locked">🔒</span>}{page.title}</h1>
          <div className="page-actions">
            {page.canEdit ? (
              <button className="primary" disabled={!!lockedByOther} onClick={() => navigate(`/p/${page.id}/edit`)}
                title={lockedByOther ? `Checked out by ${co!.displayName}` : 'Check out and edit'}>
                Edit
              </button>
            ) : (
              <button className="primary" onClick={() => void suggestChange()} title="Edit a private copy and send it to the owner for review">
                {page.changeRequests.mineId ? 'Continue suggestion' : 'Suggest change'}
              </button>
            )}
            {page.canEdit && !isOwner && (
              <button onClick={() => void suggestChange()} title="Not sure? Edit a private copy and ask the owner to review it">
                {page.changeRequests.mineId ? 'My suggestion' : 'Suggest change'}
              </button>
            )}
            {canLock && (
              <button onClick={() => void toggleLock()} title={page.locked ? 'Let everyone edit again' : 'Only you and admins can edit directly; others suggest changes'}>
                {page.locked ? 'Unlock' : 'Lock'}
              </button>
            )}
            <Link className="button" to={`/p/${page.id}/history`}>History</Link>
            <button onClick={() => setNewChild(true)}>Add subpage</button>
            <button onClick={() => void copyLink()}>{copied ? 'Copied' : 'Copy link'}</button>
            <button onClick={exportMd}>Export .md</button>
            <button disabled={!!lockedByOther} title={lockedByOther ? `Checked out by ${co!.displayName}` : 'Move this page and its subpages'} onClick={() => setDialog('move')}>Move</button>
            <button disabled={!!blockedReason} title={blockedReason ?? 'Move to the trash'} onClick={() => setDialog('delete')}>Delete</button>
            {user.role === 'admin' && <button onClick={() => setDialog('owner')}>Change owner</button>}
          </div>
        </header>
        <div className="page-meta muted small">
          {page.template !== 'blank' && <span className="badge template-badge" title={page.templateInfo.requiredSections.length ? `Required sections: ${page.templateInfo.requiredSections.join(', ')}` : undefined}>{page.templateInfo.name}</span>}{' '}
          Owner {page.owner.displayName}{!page.owner.active && ' (former user)'} · Updated {formatDateTime(page.updatedAt)} by {page.updatedBy.displayName}
          {' '}<ReviewBadge status={review.status} reviewBy={review.reviewBy} />
          {canReview && <button className="link-btn small" onClick={() => setDialog('review')}>{review.reviewBy ? 'Review…' : 'Set review date'}</button>}
        </div>
        <TagEditor key={page.tags.join(',')} pageId={page.id} tags={page.tags} readOnlyReason={lockedByOther ? `Checked out by ${co!.displayName}` : undefined} />

        {page.body.trim()
          ? <MarkdownView source={page.body} onHeadings={setHeadings} />
          : <p className="muted empty-page">This page is empty. Click Edit to write it.</p>}

        {page.changeRequests.open > 0 && (
          <section className="page-crs" aria-label="Change requests">
            <h2>Change requests <span className="badge">{page.changeRequests.open} open</span></h2>
            {openCrs.data && <ChangeRequestList items={openCrs.data} showPage={false} empty="" />}
          </section>
        )}

        <AttachmentsPanel pageId={page.id} readOnlyReason={lockedByOther ? `Checked out by ${co!.displayName}` : undefined}
          removeBlockedReason={!page.canEdit ? `Only ${page.owner.displayName} or an admin can remove files from a locked page` : undefined} />

        {backlinks.data && backlinks.data.length > 0 && (
          <section className="backlinks" aria-label="Linked from">
            <h2>Linked from</h2>
            <ul className="plain-list">
              {backlinks.data.map((b) => (
                <li key={b.id}><Link to={pagePath(b)}>{b.title}</Link> <span className="muted small">in {b.spaceName}</span></li>
              ))}
            </ul>
          </section>
        )}
      </article>
      {headings.length > 1 && (
        <aside className="outline">
          <div className="side-heading">On this page</div>
          <ul>
            {headings.map((h) => (
              <li key={h.id} style={{ paddingLeft: (h.depth - 1) * 10 }}>
                <a href={`#${h.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth' }); history.replaceState(null, '', `#${h.id}`); }}>{h.text}</a>
              </li>
            ))}
          </ul>
        </aside>
      )}
      {dialog === 'move' && <MoveDialog page={page} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteDialog page={page} onClose={() => setDialog(null)} />}
      {dialog === 'review' && <ReviewDialog page={page} onClose={() => setDialog(null)} />}
      {dialog === 'owner' && <OwnerDialog page={page} onClose={() => setDialog(null)} />}
      {newChild && <NewPageDialog spaceKey={page.spaceKey} parentId={page.id} parentTitle={page.title} onClose={() => setNewChild(false)} />}
    </div>
  );
}
