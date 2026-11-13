import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, formatTime, pagePath, uploadAttachment, type ChangeRequest, type PageRef } from '../lib/api';
import { checkRequiredSections } from '../lib/sections';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { MarkdownView } from '../components/MarkdownView';
import { DiffView } from '../components/DiffView';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { SecretFindings } from '../components/SecretFindings';
import type { SecretFinding, SecretScanConfig } from '../lib/secrets';
import { refreshAfterCr } from './ChangeRequestView';

const AUTOSAVE_MS = 4_000;
type ViewMode = 'split' | 'editor' | 'preview' | 'compare';

/**
 * The editor for a change request: the same Markdown editor as a check-out, but on the requester's private
 * copy. No check-out is taken, so the owner can keep editing the page meanwhile.
 */
export function ChangeRequestEdit() {
  const { id } = useParams();
  const crId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cr', crId], queryFn: () => api.get<ChangeRequest>(`/change-requests/${crId}`), refetchOnWindowFocus: false });
  const templateQ = useQuery({
    queryKey: ['page', q.data?.page.id],
    queryFn: () => api.get<{ templateInfo: { name: string; requiredSections: string[] } }>(`/pages/${q.data!.page.id}`),
    enabled: !!q.data,
  });
  const rulesQ = useQuery({
    queryKey: ['secret-rules'],
    queryFn: () => api.get<{ config: SecretScanConfig }>('/secret-rules'),
    staleTime: 5 * 60_000,
  });

  const [loaded, setLoaded] = useState<ChangeRequest | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const [mode, setMode] = useState<ViewMode>('split');
  const [compare, setCompare] = useState<'mine' | 'since'>('mine');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secretFindings, setSecretFindings] = useState<SecretFinding[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const current = useRef({ title: '', body: '' });
  const saved = useRef({ title: '', body: '' });
  const saving = useRef<Promise<void> | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const dirty = () => current.current.title !== saved.current.title || current.current.body !== saved.current.body;

  const apply = (cr: ChangeRequest) => {
    setLoaded(cr);
    setTitle(cr.title);
    setBody(cr.body);
    setPreview(cr.body);
    current.current = { title: cr.title, body: cr.body };
    saved.current = { title: cr.title, body: cr.body };
    setEditorKey((k) => k + 1);
  };

  useEffect(() => {
    if (q.data && !loaded) apply(q.data);
  }, [q.data, loaded]);

  const saveNow = useCallback(async () => {
    if (saving.current) await saving.current;
    if (!dirty()) return;
    const snapshot = { ...current.current };
    saving.current = (async () => {
      try {
        const r = await api.put<{ version: number; updatedAt: string }>(`/change-requests/${crId}`, snapshot);
        saved.current = snapshot;
        setSavedAt(new Date(r.updatedAt));
        setSaveError(null);
      } catch (e) {
        setSaveError((e as Error).message);
      } finally {
        saving.current = null;
      }
    })();
    await saving.current;
  }, [crId]);

  useEffect(() => {
    if (!loaded) return;
    const t = setInterval(() => { void saveNow(); }, AUTOSAVE_MS);
    return () => clearInterval(t);
  }, [loaded, saveNow]);

  useEffect(() => {
    const t = setTimeout(() => setPreview(body), 150);
    return () => clearTimeout(t);
  }, [body]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (dirty()) e.preventDefault(); };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveNow(); }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('keydown', onKey);
    };
  }, [saveNow]);

  const onBody = useCallback((v: string) => {
    current.current.body = v;
    setBody(v);
  }, []);

  const onScrollRatio = useCallback((r: number) => {
    const el = previewRef.current?.parentElement;
    if (el) el.scrollTop = r * (el.scrollHeight - el.clientHeight);
  }, []);

  const upload = useCallback(async (file: File, onProgress: (p: number) => void) => {
    const a = await uploadAttachment(loaded!.page.id, file, onProgress);
    void qc.invalidateQueries({ queryKey: ['attachments', loaded!.page.id] });
    return a;
  }, [loaded, qc]);

  const searchPages = useCallback((s: string) => api.get<PageRef[]>(`/pages/quick?q=${encodeURIComponent(s)}`), []);

  const reload = async () => {
    const fresh = await q.refetch();
    if (fresh.data) apply(fresh.data);
    return fresh.data;
  };

  const updateToLatest = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await saveNow();
      const r = await api.post<{ conflicts: number; changed: boolean }>(`/change-requests/${crId}/update-to-latest`);
      await reload();
      await refreshAfterCr(qc, loaded!);
      setNotice(r.conflicts
        ? `Updated onto the latest version, with ${r.conflicts} conflict${r.conflicts > 1 ? 's' : ''}: where you and the page changed the same lines, both versions are kept between <<<<<<< and >>>>>>> lines. Keep the text you want and delete the marker lines.`
        : 'Updated onto the latest version. Your changes were merged in cleanly.');
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (q.error) return <div className="editor-shell"><div className="content"><ErrorBox error={q.error} /></div></div>;
  if (!loaded) return <div className="editor-shell"><p className="pad muted">Loading…</p></div>;
  if (!loaded.can.edit) return <Navigate to={`/cr/${crId}`} replace />;

  const cr = q.data ?? loaded;
  const required = templateQ.data?.templateInfo.requiredSections ?? [];
  const sectionCheck = required.length ? checkRequiredSections(preview, required) : null;
  const conflicted = /^<<<<<<< your change$/m.test(body) && /^>>>>>>> current page$/m.test(body);
  const status = cr.status;

  return (
    <div className="editor-shell">
      <header className="editor-top">
        <button className="link-btn" onClick={async () => { await saveNow(); navigate(status === 'draft' ? pagePath(cr.page) : `/cr/${crId}`); }}>
          ← {status === 'draft' ? 'Back to page' : 'Back to request'}
        </button>
        <span className="badge cr-draft" title="Your private copy of the page">Suggesting a change</span>
        <input className="title-input" value={title} maxLength={200} aria-label="Page title"
          onChange={(e) => { setTitle(e.target.value); current.current.title = e.target.value; }} />
        <div className="seg" role="group" aria-label="View">
          {(['editor', 'split', 'preview', 'compare'] as ViewMode[]).map((m) => (
            <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'compare' ? 'Changes' : m[0].toUpperCase() + m.slice(1)}</button>
          ))}
        </div>
        {secretFindings.length > 0 && (
          <span className="secret-count" title={secretFindings.map((f) => `Line ${f.line}: ${f.ruleName}`).join('\n')}>
            ⚠ {secretFindings.length === 1 ? '1 possible secret' : `${secretFindings.length} possible secrets`}
          </span>
        )}
        <span className="save-state muted small" aria-live="polite">
          {saveError ? <span className="text-danger">Autosave failed: {saveError}</span> : savedAt ? `Saved ${formatTime(savedAt)}` : 'Private until submitted'}
        </span>
        <button onClick={async () => {
          if (!confirm(status === 'draft' ? 'Throw this suggestion away?' : 'Withdraw this change request?')) return;
          current.current = saved.current;
          await api.post(`/change-requests/${crId}/withdraw`);
          await refreshAfterCr(qc, cr);
          navigate(pagePath(cr.page));
        }}>{status === 'draft' ? 'Discard' : 'Withdraw'}</button>
        {status === 'open' ? (
          <button className="primary" onClick={async () => { await saveNow(); await refreshAfterCr(qc, cr); navigate(`/cr/${crId}`); }}>Done</button>
        ) : (
          <button className="primary" disabled={!title.trim()} onClick={async () => { await saveNow(); setSubmitOpen(true); }}>
            {status === 'changes_requested' ? 'Resubmit' : 'Submit for review'}
          </button>
        )}
      </header>

      <div className="banner info small-banner">
        You're suggesting a change to <Link to={pagePath(cr.page)} target="_blank">{cr.page.title}</Link>.{' '}
        {cr.page.owner.active ? cr.page.owner.displayName : 'An admin'} reviews it before it goes live.
        {status === 'open' && ' It is already submitted; the reviewer sees your latest saved version.'}
      </div>
      {cr.outdated && (
        <div className="banner warn">
          The page changed after you started. Update your suggestion onto the latest version before it can be approved.{' '}
          <button className="link-btn" onClick={() => { setMode('compare'); setCompare('since'); }}>See what changed</button>
          <button className="link-btn" disabled={busy} onClick={() => void updateToLatest()}>Update onto latest version</button>
        </div>
      )}
      {conflicted && (
        <div className="banner danger">
          Resolve the conflicts: find the lines between <code>{'<<<<<<< your change'}</code> and <code>{'>>>>>>> current page'}</code>, keep the text you want, and delete the marker lines.
        </div>
      )}
      {notice && <div className="banner info">{notice} <button className="link-btn" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {uploadError && <div className="banner danger">Upload failed: {uploadError} <button className="link-btn" onClick={() => setUploadError(null)}>Dismiss</button></div>}
      {sectionCheck && (sectionCheck.missing.length > 0 || sectionCheck.empty.length > 0) && (
        <div className="section-status todo" aria-live="polite">
          <span className="badge">{templateQ.data?.templateInfo.name}</span>
          {sectionCheck.missing.length > 0 && <span>Missing sections: <strong>{sectionCheck.missing.join(', ')}</strong></span>}
          {sectionCheck.empty.length > 0 && <span>Still empty: <strong>{sectionCheck.empty.join(', ')}</strong></span>}
          <span className="muted small">Required before submitting.</span>
        </div>
      )}

      <div className={`editor-panes mode-${mode === 'compare' ? 'split' : mode}`}>
        <div className="pane pane-editor">
          <MarkdownEditor
            key={editorKey}
            initialValue={loaded.body}
            onChange={onBody}
            onScrollRatio={mode === 'split' ? onScrollRatio : undefined}
            upload={upload}
            onUploadError={setUploadError}
            searchPages={searchPages}
            secretConfig={rulesQ.data?.config ?? null}
            onSecretFindings={setSecretFindings}
          />
        </div>
        <div className="pane pane-preview">
          {mode === 'compare' ? (
            <div className="preview-inner">
              <div className="seg" role="tablist" aria-label="Which changes">
                <button className={compare === 'mine' ? 'on' : ''} onClick={() => setCompare('mine')}>Your changes</button>
                <button className={compare === 'since' ? 'on' : ''} onClick={() => setCompare('since')} disabled={!cr.outdated}
                  title={cr.outdated ? 'What others changed on the page since you started' : 'The page has not changed since you started'}>
                  Page changes since you started
                </button>
              </div>
              {compare === 'mine' || !cr.outdated
                ? <DiffView oldText={cr.base?.body ?? ''} newText={preview} mode="inline" />
                : <DiffView oldText={cr.base?.body ?? ''} newText={cr.page.body} mode="inline" />}
            </div>
          ) : (
            <div className="preview-inner">
              <h1 className="preview-title">{title}</h1>
              <MarkdownView ref={previewRef} source={preview} />
            </div>
          )}
        </div>
      </div>

      {submitOpen && (
        <SubmitDialog
          cr={cr}
          onClose={() => setSubmitOpen(false)}
          onDone={async () => {
            current.current = saved.current;
            await refreshAfterCr(qc, cr);
            navigate(`/cr/${crId}`);
          }}
        />
      )}
    </div>
  );
}

function SubmitDialog({ cr, onClose, onDone }: { cr: ChangeRequest; onClose: () => void; onDone: () => Promise<void> }) {
  const [description, setDescription] = useState(cr.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [secrets, setSecrets] = useState<SecretFinding[] | null>(null);

  const submit = async (secretsAcknowledged = false) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/change-requests/${cr.id}/submit`, { description, secretsAcknowledged });
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'possible_secrets') setSecrets(e.details.findings);
      else setError(e);
      setBusy(false);
    }
  };

  if (secrets) {
    return (
      <Modal title="Possible secrets" onClose={onClose} wide>
        <div className="form">
          <p>This looks like it contains {secrets.length === 1 ? 'a password or key' : `${secrets.length} passwords or keys`}. The reviewer will see it, and if approved it stays in the page history.</p>
          <SecretFindings findings={secrets} />
          {error != null && <ErrorBox error={error} />}
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={() => void submit(true)}>Submit anyway</button>
            <button type="button" className="primary" onClick={onClose}>Go back and fix it</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={cr.status === 'changes_requested' ? 'Resubmit change' : 'Submit for review'} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label>
          What did you change, and why? <span className="muted">(optional)</span>
          <textarea autoFocus rows={4} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. The VPN gateway moved to fw-edge-03; updated the steps and the diagram." />
        </label>
        <p className="muted small">{cr.page.owner.active ? cr.page.owner.displayName : 'The admins'} will get it in their inbox.</p>
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Keep editing</button>
          <button type="submit" className="primary" disabled={busy}>{cr.status === 'changes_requested' ? 'Resubmit' : 'Submit'}</button>
        </div>
      </form>
    </Modal>
  );
}
