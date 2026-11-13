import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, formatDateTime, pagePath, type Page, type Revision, type RevisionSummary } from '../lib/api';
import { DiffView } from '../components/DiffView';
import { MarkdownView } from '../components/MarkdownView';
import { ErrorBox } from '../components/ErrorBox';
import { SecretFindings } from '../components/SecretFindings';
import { useUser } from '../lib/session';

const kindLabel: Record<RevisionSummary['kind'], string> = { create: 'Created', checkin: 'Edited', restore: 'Restored' };

function useRevision(pageId: number, revId: number | null) {
  return useQuery({
    queryKey: ['revision', pageId, revId],
    queryFn: () => api.get<Revision>(`/pages/${pageId}/revisions/${revId}`),
    enabled: revId !== null,
    staleTime: Infinity,
  });
}

export function HistoryPage() {
  const { id } = useParams();
  const pageId = Number(id);
  const qc = useQueryClient();
  const pageQ = useQuery({ queryKey: ['page', pageId], queryFn: () => api.get<Page>(`/pages/${pageId}`) });
  const revsQ = useQuery({ queryKey: ['revisions', pageId], queryFn: () => api.get<RevisionSummary[]>(`/pages/${pageId}/revisions`) });
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [mode, setMode] = useState<'split' | 'inline' | 'rendered'>('split');
  const [error, setError] = useState<unknown>(null);
  const [openFlags, setOpenFlags] = useState<number | null>(null);
  const user = useUser();

  const revs = revsQ.data ?? [];
  useEffect(() => {
    // Default: compare the latest revision with the one before it.
    if (revs.length && to === null) {
      setTo(revs[0].id);
      setFrom(revs[1]?.id ?? revs[0].id);
    }
  }, [revs, to]);

  const fromQ = useRevision(pageId, from);
  const toQ = useRevision(pageId, to);
  const page = pageQ.data;

  const restore = async (r: RevisionSummary) => {
    if (!confirm(`Restore revision ${r.id} from ${formatDateTime(r.createdAt)}? This creates a new revision; nothing is lost.`)) return;
    setError(null);
    try {
      await api.post(`/pages/${pageId}/revisions/${r.id}/restore`);
      const fresh = await revsQ.refetch();
      if (fresh.data?.length) {
        setTo(fresh.data[0].id);
        setFrom(fresh.data[1]?.id ?? fresh.data[0].id);
      }
      await qc.invalidateQueries({ queryKey: ['page', pageId] });
      await qc.invalidateQueries({ queryKey: ['tree'] });
    } catch (e) {
      setError(e instanceof ApiError && e.details?.code === 'checked_out'
        ? new Error(`${e.message}. Restore is possible once the page is checked in.`) : e);
    }
  };

  const purge = async (r: RevisionSummary, n: number) => {
    if (!confirm(`Permanently delete revision #${n} from ${formatDateTime(r.createdAt)}? This can't be undone. Use it to remove a leaked secret from history.`)) return;
    setError(null);
    try {
      await api.del(`/pages/${pageId}/revisions/${r.id}`);
      const fresh = await revsQ.refetch();
      if (fresh.data?.length) {
        setTo(fresh.data[0].id);
        setFrom(fresh.data[1]?.id ?? fresh.data[0].id);
      }
      await qc.invalidateQueries({ queryKey: ['admin-secrets'] });
    } catch (e) {
      setError(e);
    }
  };

  if (pageQ.error) return <div className="content"><ErrorBox error={pageQ.error} /></div>;
  if (!page) return null;

  return (
    <div className="content wide">
      <nav className="breadcrumbs"><Link to={pagePath(page)}>← {page.title}</Link></nav>
      <h1>History</h1>
      {error != null && <ErrorBox error={error} />}
      <table className="rev-table">
        <thead>
          <tr><th title="Compare from">From</th><th title="Compare to">To</th><th>Revision</th><th>Who</th><th>When</th><th>Note</th><th /></tr>
        </thead>
        <tbody>
          {revs.map((r, i) => (
            <tr key={r.id} className={r.id === page.currentRevisionId ? 'current' : ''}>
              <td><input type="radio" name="from" aria-label={`Compare from revision ${r.id}`} checked={from === r.id} onChange={() => setFrom(r.id)} /></td>
              <td><input type="radio" name="to" aria-label={`Compare to revision ${r.id}`} checked={to === r.id} onChange={() => setTo(r.id)} /></td>
              <td>#{revs.length - i} <span className="muted small">{kindLabel[r.kind]}{r.restoredFrom ? ` from #${revs.length - revs.findIndex((x) => x.id === r.restoredFrom)}` : ''}</span></td>
              <td>{r.author.displayName}</td>
              <td className="nowrap">{formatDateTime(r.createdAt)}</td>
              <td>
                {r.message}{r.title !== revs[i + 1]?.title && i < revs.length - 1 && <span className="muted small"> (renamed “{r.title}”)</span>}
                {!!r.secretFindings?.length && (
                  <>
                    {' '}<button className={`badge secret-flag${r.secretsAcknowledged ? ' acked' : ''}`} onClick={() => setOpenFlags(openFlags === r.id ? null : r.id)}
                      title={r.secretsAcknowledged ? 'Saved anyway despite a secret warning' : 'Possible secret found by a rescan'}>
                      ⚠ possible secret{r.secretFindings.length > 1 ? `s (${r.secretFindings.length})` : ''}
                    </button>
                    {openFlags === r.id && <SecretFindings findings={r.secretFindings} />}
                  </>
                )}
              </td>
              <td className="nowrap">
                {r.id === page.currentRevisionId
                  ? <span className="badge">current</span>
                  : <button className="small" onClick={() => void restore(r)}>Restore</button>}
                {user.role === 'admin' && r.id !== page.currentRevisionId && (
                  <button className="small danger" title="Permanently delete this revision" onClick={() => void purge(r, revs.length - i)}>Purge</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="diff-head">
        <h2>Compare</h2>
        <div className="seg" role="group" aria-label="Diff view">
          <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>Side by side</button>
          <button className={mode === 'inline' ? 'on' : ''} onClick={() => setMode('inline')}>Inline</button>
          <button className={mode === 'rendered' ? 'on' : ''} onClick={() => setMode('rendered')}>View “To”</button>
        </div>
      </div>
      {fromQ.data && toQ.data && (
        <>
          {fromQ.data.title !== toQ.data.title && (
            <p>Title: <del>{fromQ.data.title}</del> → <ins>{toQ.data.title}</ins></p>
          )}
          {mode === 'rendered'
            ? <div className="card"><h1>{toQ.data.title}</h1><MarkdownView source={toQ.data.body} /></div>
            : <DiffView oldText={fromQ.data.body} newText={toQ.data.body} mode={mode} />}
        </>
      )}
    </div>
  );
}
