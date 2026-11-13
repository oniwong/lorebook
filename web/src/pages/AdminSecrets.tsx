import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDateTime, pagePath, type StoredFinding } from '../lib/api';
import type { SecretRule } from '../lib/secrets';
import { ErrorBox } from '../components/ErrorBox';
import { SecretFindings } from '../components/SecretFindings';

type CustomRule = { id: string; name: string; pattern: string; flags?: string };
type SecretSettings = { disabledRules: string[]; customRules: CustomRule[]; allowlist: string[] };
type RulesResponse = { builtin: SecretRule[]; settings: SecretSettings; defaults: SecretSettings };

type Report = {
  revisions: {
    revisionId: number; pageId: number; title: string; slug: string; spaceKey: string; spaceName: string;
    createdAt: string; author: string; findings: StoredFinding[]; acknowledged: boolean; isCurrent: boolean; pageDeleted: boolean;
  }[];
  attachments: {
    id: number; filename: string; pageId: number; title: string; slug: string; spaceKey: string;
    createdAt: string; uploader: string; findings: StoredFinding[]; removed: boolean; pageDeleted: boolean;
  }[];
};

/** "Possible secrets" report (spec §8): where flagged content lives, so an admin can fix pages and purge history. */
export function SecretsReport() {
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ['admin-secrets'], queryFn: () => api.get<Report>('/admin/secrets') });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const rescan = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ revisions: number; flagged: number; attachments: number }>('/admin/secrets/rescan');
      setNote(`Scanned ${r.revisions} revisions and ${r.attachments} files; ${r.flagged} revisions flagged.`);
      await qc.invalidateQueries({ queryKey: ['admin-secrets'] });
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };

  const purgeRevision = async (pageId: number, revisionId: number) => {
    if (!confirm('Permanently delete this revision? This cannot be undone.')) return;
    setError(null);
    try {
      await api.del(`/pages/${pageId}/revisions/${revisionId}`);
      await qc.invalidateQueries({ queryKey: ['admin-secrets'] });
    } catch (e) {
      setError(e);
    }
  };

  const purgeAttachment = async (id: number) => {
    if (!confirm('Permanently delete this file? Older page versions that link to it will show a broken link.')) return;
    setError(null);
    try {
      await api.del(`/attachments/${id}/purge`);
      await qc.invalidateQueries({ queryKey: ['admin-secrets'] });
    } catch (e) {
      setError(e);
    }
  };

  const current = report.data?.revisions.filter((r) => r.isCurrent) ?? [];
  const old = report.data?.revisions.filter((r) => !r.isCurrent) ?? [];
  const files = report.data?.attachments ?? [];

  return (
    <section className="card">
      <div className="section-head">
        <h2>Possible secrets</h2>
        <button onClick={() => void rescan()} disabled={busy} title="Scan every revision and text file again with the current rules">
          {busy ? 'Scanning…' : 'Rescan everything'}
        </button>
      </div>
      <p className="muted small">
        To remove a leaked secret: edit the page to take it out (or ask the owner to), then purge the older revisions that still contain it.
        Rotate the credential too, since people may have seen it.
      </p>
      {note && <p className="small">{note}</p>}
      {error != null && <ErrorBox error={error} />}
      {report.data && !current.length && !old.length && !files.length && <p className="muted">Nothing flagged.</p>}

      {current.length > 0 && (
        <>
          <h3>Pages with a possible secret in the current version</h3>
          <table className="data-table">
            <thead><tr><th>Page</th><th>Saved by</th><th>When</th><th>Findings</th></tr></thead>
            <tbody>
              {current.map((r) => (
                <FindingRow key={r.revisionId} id={`r${r.revisionId}`} open={open} setOpen={setOpen} findings={r.findings}
                  cells={<>
                    <td>{r.pageDeleted ? <>{r.title} <span className="badge">in trash</span></> : <Link to={pagePath({ spaceKey: r.spaceKey, id: r.pageId, slug: r.slug })}>{r.title}</Link>} <span className="muted small">{r.spaceName}</span></td>
                    <td>{r.author}{r.acknowledged && <span className="badge warn" title="Chose Save anyway">saved anyway</span>}</td>
                    <td className="nowrap muted">{formatDateTime(r.createdAt)}</td>
                  </>} />
              ))}
            </tbody>
          </table>
        </>
      )}

      {old.length > 0 && (
        <>
          <h3>Older revisions</h3>
          <table className="data-table">
            <thead><tr><th>Page</th><th>Saved by</th><th>When</th><th>Findings</th><th /></tr></thead>
            <tbody>
              {old.map((r) => (
                <FindingRow key={r.revisionId} id={`r${r.revisionId}`} open={open} setOpen={setOpen} findings={r.findings}
                  cells={<>
                    <td><Link to={`/p/${r.pageId}/history`}>{r.title}</Link> <span className="muted small">{r.spaceName}</span></td>
                    <td>{r.author}</td>
                    <td className="nowrap muted">{formatDateTime(r.createdAt)}</td>
                  </>}
                  action={<button className="small danger" onClick={() => void purgeRevision(r.pageId, r.revisionId)}>Purge revision</button>} />
              ))}
            </tbody>
          </table>
        </>
      )}

      {files.length > 0 && (
        <>
          <h3>Attached files</h3>
          <table className="data-table">
            <thead><tr><th>File</th><th>Uploaded by</th><th>When</th><th>Findings</th><th /></tr></thead>
            <tbody>
              {files.map((a) => (
                <FindingRow key={a.id} id={`a${a.id}`} open={open} setOpen={setOpen} findings={a.findings}
                  cells={<>
                    <td>{a.filename} <span className="muted small">on {a.pageDeleted ? a.title : <Link to={pagePath({ spaceKey: a.spaceKey, id: a.pageId, slug: a.slug })}>{a.title}</Link>}</span>{a.removed && <span className="badge">removed from page</span>}</td>
                    <td>{a.uploader}</td>
                    <td className="nowrap muted">{formatDateTime(a.createdAt)}</td>
                  </>}
                  action={<button className="small danger" onClick={() => void purgeAttachment(a.id)}>Purge file</button>} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function FindingRow({ id, open, setOpen, findings, cells, action }: {
  id: string; open: string | null; setOpen: (v: string | null) => void; findings: StoredFinding[];
  cells: ReactNode; action?: ReactNode;
}) {
  return (
    <>
      <tr>
        {cells}
        <td><button className="link-btn small" onClick={() => setOpen(open === id ? null : id)}>{findings.length} × {findings[0]?.ruleName}{findings.length > 1 ? '…' : ''}</button></td>
        {action !== undefined && <td className="nowrap">{action}</td>}
      </tr>
      {open === id && <tr><td colSpan={action !== undefined ? 5 : 4}><SecretFindings findings={findings} /></td></tr>}
    </>
  );
}

/** Secret detection rules: switch built-ins off, add custom regex rules and placeholder values. */
export function SecretRulesAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['secret-rules-admin'], queryFn: () => api.get<RulesResponse>('/secret-rules') });
  const [draft, setDraft] = useState<SecretSettings | null>(null);
  const [newRule, setNewRule] = useState({ name: '', pattern: '', flags: '' });
  const [allow, setAllow] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  if (!q.data) return null;
  const s = draft ?? q.data.settings;
  const change = (next: SecretSettings) => { setDraft(next); setSaved(false); };
  const toggle = (id: string) => change({
    ...s, disabledRules: s.disabledRules.includes(id) ? s.disabledRules.filter((x) => x !== id) : [...s.disabledRules, id],
  });

  const addRule = (e: FormEvent) => {
    e.preventDefault();
    const base = newRule.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'rule';
    let id = `custom-${base}`;
    for (let i = 2; s.customRules.some((r) => r.id === id); i++) id = `custom-${base}-${i}`;
    change({ ...s, customRules: [...s.customRules, { id, name: newRule.name.trim(), pattern: newRule.pattern, ...(newRule.flags ? { flags: newRule.flags } : {}) }] });
    setNewRule({ name: '', pattern: '', flags: '' });
  };

  const save = async () => {
    setError(null);
    try {
      await api.put('/secret-rules', s);
      setDraft(null);
      setSaved(true);
      await qc.invalidateQueries({ queryKey: ['secret-rules-admin'] });
      await qc.invalidateQueries({ queryKey: ['secret-rules'] });
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section className="card">
      <div className="section-head">
        <h2>Secret detection rules</h2>
        <div>
          {draft && <button onClick={() => setDraft(null)}>Undo changes</button>}{' '}
          <button className="primary" disabled={!draft} onClick={() => void save()}>{saved && !draft ? 'Saved' : 'Save rules'}</button>
        </div>
      </div>
      <p className="muted small">Lorebook warns (never blocks) when content matches these. Changes apply to new saves; use “Rescan everything” to re-check existing content.</p>
      {error != null && <ErrorBox error={error} />}
      <table className="data-table">
        <thead><tr><th>On</th><th>Rule</th><th>Pattern</th><th /></tr></thead>
        <tbody>
          {q.data.builtin.map((r) => (
            <tr key={r.id} className={s.disabledRules.includes(r.id) ? 'inactive' : ''}>
              <td><input type="checkbox" aria-label={`Enable ${r.name}`} checked={!s.disabledRules.includes(r.id)} onChange={() => toggle(r.id)} /></td>
              <td>{r.name} <span className="badge">built-in</span></td>
              <td><code className="pattern">{r.kind === 'entropy' ? 'random-looking tokens of 32+ characters inside code blocks' : r.pattern}</code></td>
              <td />
            </tr>
          ))}
          {s.customRules.map((r) => (
            <tr key={r.id} className={s.disabledRules.includes(r.id) ? 'inactive' : ''}>
              <td><input type="checkbox" aria-label={`Enable ${r.name}`} checked={!s.disabledRules.includes(r.id)} onChange={() => toggle(r.id)} /></td>
              <td>{r.name}</td>
              <td><code className="pattern">/{r.pattern}/{r.flags ?? ''}</code></td>
              <td><button className="small" onClick={() => change({ ...s, customRules: s.customRules.filter((x) => x.id !== r.id), disabledRules: s.disabledRules.filter((x) => x !== r.id) })}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="form inline-form" onSubmit={addRule}>
        <label>Name<input value={newRule.name} onChange={(e) => setNewRule({ ...newRule, name: e.target.value })} placeholder="Badge number" required /></label>
        <label className="grow">Regular expression<input value={newRule.pattern} onChange={(e) => setNewRule({ ...newRule, pattern: e.target.value })} placeholder="CORP-[0-9]{6}" required /></label>
        <label style={{ flexBasis: 80 }}>Flags<input value={newRule.flags} onChange={(e) => setNewRule({ ...newRule, flags: e.target.value.replace(/[^imsu]/g, '') })} placeholder="i" /></label>
        <button type="submit">Add rule</button>
      </form>

      <h3>Placeholder values</h3>
      <p className="muted small">Values that are never reported, e.g. <code>password=changeme</code>. Shapes like <code>{'<password>'}</code>, <code>{'${VAR}'}</code> and <code>****</code> are always ignored.</p>
      <div className="tag-row">
        {s.allowlist.map((v) => (
          <span key={v} className="tag">{v} <button className="tag-x" aria-label={`Remove ${v}`} onClick={() => change({ ...s, allowlist: s.allowlist.filter((x) => x !== v) })}>×</button></span>
        ))}
      </div>
      <form className="form inline-form" onSubmit={(e) => { e.preventDefault(); const v = allow.trim(); if (v && !s.allowlist.includes(v)) change({ ...s, allowlist: [...s.allowlist, v] }); setAllow(''); }}>
        <label className="grow">Add a placeholder value<input value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="LabPassword" /></label>
        <button type="submit">Add</button>
      </form>
    </section>
  );
}
