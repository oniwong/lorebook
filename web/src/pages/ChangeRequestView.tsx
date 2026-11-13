import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, formatDateTime, formatTime, pagePath, type ChangeRequest, type ChangeRequestEvent } from '../lib/api';
import { DiffView } from '../components/DiffView';
import { MarkdownView } from '../components/MarkdownView';
import { ErrorBox } from '../components/ErrorBox';
import { SecretFindings } from '../components/SecretFindings';
import { CrStatusBadge } from '../components/ChangeRequestList';

const eventText: Record<ChangeRequestEvent['kind'], string> = {
  submitted: 'submitted the change',
  resubmitted: 'updated and resubmitted the change',
  comment: 'commented',
  changes_requested: 'asked for changes',
  approved: 'approved and applied the change',
  rejected: 'rejected the change',
  withdrawn: 'withdrew the change',
  updated_to_latest: 'updated the change onto the latest version of the page',
};

/** Invalidates everything a decision on a change request can change. */
export async function refreshAfterCr(qc: ReturnType<typeof useQueryClient>, cr: { id: number; page: { id: number } }) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['cr', cr.id] }),
    qc.invalidateQueries({ queryKey: ['crs'] }),
    qc.invalidateQueries({ queryKey: ['page', cr.page.id] }),
    qc.invalidateQueries({ queryKey: ['page-crs', cr.page.id] }),
    qc.invalidateQueries({ queryKey: ['inbox'] }),
    qc.invalidateQueries({ queryKey: ['inbox-count'] }),
    qc.invalidateQueries({ queryKey: ['revisions', cr.page.id] }),
    qc.invalidateQueries({ queryKey: ['recent'] }),
  ]);
}

/** The review screen (spec §6): the diff against the base revision, the conversation, and the decision. */
export function ChangeRequestView() {
  const { id } = useParams();
  const crId = Number(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['cr', crId], queryFn: () => api.get<ChangeRequest>(`/change-requests/${crId}`), refetchInterval: 30_000 });
  const [mode, setMode] = useState<'split' | 'inline' | 'rendered'>('split');
  const [tab, setTab] = useState<'changes' | 'since'>('changes');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (q.error) return <div className="content"><ErrorBox error={q.error} /></div>;
  const cr = q.data;
  if (!cr) return null;

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refreshAfterCr(qc, cr);
      after?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'cr_changed') {
        setNotice('The requester changed the suggestion while you were looking. The diff below is now the latest version; check it and approve again.');
        await q.refetch();
      } else setError(e);
    } finally {
      setBusy(false);
    }
  };

  const baseBody = cr.base?.body ?? '';
  const baseTitle = cr.base?.title ?? cr.page.title;
  const oldText = baseBody;
  const newText = tab === 'changes' ? cr.body : cr.page.body;
  const titleChanged = tab === 'changes' ? cr.title !== baseTitle : cr.page.title !== baseTitle;
  const newTitle = tab === 'changes' ? cr.title : cr.page.title;
  const isAuthorView = cr.can.edit;

  return (
    <div className="content wide">
      <nav className="breadcrumbs">
        <Link to={`/s/${cr.page.spaceKey}`}>{cr.page.spaceName}</Link> / <Link to={pagePath(cr.page)}>{cr.page.title}</Link> / Change request #{cr.id}
      </nav>
      <header className="cr-head">
        <h1>Suggested change to “{cr.page.title}”</h1>
        <div className="muted">
          <CrStatusBadge status={cr.status} outdated={cr.outdated} />{' '}
          by <strong>{cr.author.displayName}</strong>
          {cr.submittedAt ? <>, submitted {formatDateTime(cr.submittedAt)}</> : <>, started {formatDateTime(cr.createdAt)}</>}
          {' '}· Reviewer: {cr.page.owner.displayName}{!cr.page.owner.active && ' (former user, so admins review)'}
          {cr.decidedBy && <> · {cr.status === 'approved' ? 'Approved' : 'Decided'} by {cr.decidedBy.displayName} {cr.decidedAt && formatDateTime(cr.decidedAt)}</>}
        </div>
      </header>

      {cr.page.trashed && <div className="banner warn">The page is in the trash, so this request can't be approved unless it is restored.</div>}
      {cr.status === 'draft' && (
        <div className="banner info">This is your draft. Nobody else can see it until you submit it. <Link to={`/cr/${cr.id}/edit`}>Continue editing</Link></div>
      )}
      {cr.status === 'changes_requested' && isAuthorView && (
        <div className="banner info">The reviewer asked for changes (see the conversation below). <Link to={`/cr/${cr.id}/edit`}>Edit and resubmit</Link></div>
      )}
      {cr.outdated && (
        <div className="banner warn">
          The page changed after this was suggested. {isAuthorView
            ? <>Update your request onto the latest version before it can be approved. <Link to={`/cr/${cr.id}/edit`}>Update it in the editor</Link></>
            : <>{cr.author.displayName} has to update it onto the latest version before it can be approved. They've been told in their inbox.</>}
          {' '}<button className="link-btn" onClick={() => setTab('since')}>See what changed on the page</button>
        </div>
      )}
      {cr.hasConflicts && <div className="banner danger">This request has unresolved conflicts with the latest page version.{isAuthorView && <> <Link to={`/cr/${cr.id}/edit`}>Resolve them</Link></>}</div>}
      {cr.page.checkout && (cr.can.approve) && (
        <div className="banner warn">Checked out by <strong>{cr.page.checkout.displayName}</strong> since {formatTime(cr.page.checkout.since)}. You can approve once they check in.</div>
      )}
      {cr.secretFindings.length > 0 && (
        <div className="banner danger">
          The requester saved this despite a warning that it looks like it contains a password or key.
          <SecretFindings findings={cr.secretFindings} />
        </div>
      )}
      {!cr.base && <div className="banner warn">The revision this was based on has been purged, so the diff compares against nothing.</div>}

      {cr.description && (
        <section className="cr-description">
          <MarkdownView source={cr.description} />
        </section>
      )}

      <div className="diff-head">
        {cr.outdated ? (
          <div className="seg" role="tablist" aria-label="Which changes">
            <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Suggested changes</button>
            <button className={tab === 'since' ? 'on' : ''} onClick={() => setTab('since')}>Page changes since</button>
          </div>
        ) : <h2>Changes</h2>}
        <div className="seg" role="group" aria-label="Diff view">
          <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>Side by side</button>
          <button className={mode === 'inline' ? 'on' : ''} onClick={() => setMode('inline')}>Inline</button>
          <button className={mode === 'rendered' ? 'on' : ''} onClick={() => setMode('rendered')}>Preview</button>
        </div>
      </div>
      {titleChanged && <p className="small">Title: <del>{baseTitle}</del> → <ins>{newTitle}</ins></p>}
      {mode === 'rendered'
        ? <div className="rendered-diff"><MarkdownView source={newText} /></div>
        : <DiffView oldText={oldText} newText={newText} mode={mode} />}

      <section className="cr-timeline" aria-label="Conversation">
        <h2>Conversation</h2>
        {cr.events.length === 0 && <p className="muted">Nothing yet.</p>}
        <ol className="timeline">
          {cr.events.map((e) => (
            <li key={e.id} className={`ev ev-${e.kind}`}>
              <div className="ev-head"><strong>{e.actor.displayName}</strong> {eventText[e.kind]} <span className="muted small">{formatDateTime(e.createdAt)}</span></div>
              {e.body && !(e.kind === 'submitted' && e.body === cr.description) && <div className="ev-body">{e.body}</div>}
            </li>
          ))}
        </ol>
      </section>

      {notice && <div className="banner info">{notice}</div>}
      {error != null && <ErrorBox error={error} />}

      {(cr.can.comment || cr.can.review) && (
        <section className="card cr-actions">
          <label>
            {cr.can.review ? 'Comment, or explain your decision' : 'Comment'}
            <textarea rows={3} value={comment} maxLength={5000} onChange={(e) => setComment(e.target.value)}
              placeholder={cr.can.review ? 'e.g. Please also cover the rollback step' : ''} />
          </label>
          <div className="form-actions left">
            {cr.can.comment && (
              <button disabled={busy || !comment.trim()} onClick={() => void act(() => api.post(`/change-requests/${cr.id}/comments`, { body: comment }), () => setComment(''))}>
                Comment
              </button>
            )}
            {cr.can.approve && (
              <button disabled={busy || !comment.trim()} title={comment.trim() ? 'Send it back to the requester' : 'Write what should change first'}
                onClick={() => void act(() => api.post(`/change-requests/${cr.id}/comments`, { body: comment, requestChanges: true }), () => setComment(''))}>
                Ask for changes
              </button>
            )}
            {cr.can.review && (
              <button className="danger" disabled={busy} onClick={() => {
                if (!confirm('Reject this change request? The requester is told in their inbox.')) return;
                void act(() => api.post(`/change-requests/${cr.id}/reject`, { comment: comment || undefined }), () => setComment(''));
              }}>
                Reject
              </button>
            )}
            {cr.can.approve && (
              <button className="primary" disabled={busy || cr.outdated || cr.hasConflicts || !!cr.page.checkout || cr.page.trashed}
                title={cr.outdated ? 'The requester must update it onto the latest version first' : cr.page.checkout ? 'The page is checked out' : 'Apply it as a new revision'}
                onClick={() => void act(
                  () => api.post(`/change-requests/${cr.id}/approve`, { version: cr.version, message: comment.trim() || undefined }),
                  () => navigate(pagePath(cr.page)),
                )}>
                Approve and apply
              </button>
            )}
          </div>
          {cr.can.approve && <p className="muted small">Approving creates a new revision credited to {cr.author.displayName}, approved by you. A comment here becomes the revision note.</p>}
        </section>
      )}

      {isAuthorView && (
        <div className="form-actions left">
          <Link className="button" to={`/cr/${cr.id}/edit`}>Edit</Link>
          <button className="danger" disabled={busy} onClick={() => {
            if (!confirm(cr.status === 'draft' ? 'Throw this draft away?' : 'Withdraw this change request?')) return;
            void act(() => api.post(`/change-requests/${cr.id}/withdraw`), () => { if (cr.status === 'draft') navigate(pagePath(cr.page)); });
          }}>{cr.status === 'draft' ? 'Discard draft' : 'Withdraw'}</button>
        </div>
      )}
      {cr.status === 'approved' && cr.appliedRevisionId && (
        <p><Link to={`/p/${cr.page.id}/history`}>See it in the page history</Link></p>
      )}
    </div>
  );
}
