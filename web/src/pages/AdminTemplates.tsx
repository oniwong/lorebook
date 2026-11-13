import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Template } from '../lib/api';
import { useTemplates } from '../components/NewPageDialog';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';

export function TemplatesAdmin() {
  const templates = useTemplates();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const remove = async (t: Template) => {
    if (!confirm(`Delete the ${t.name} template? ${t.pageCount ? `${t.pageCount} page(s) using it switch to Blank.` : ''}`)) return;
    setError(null);
    try {
      await api.del(`/templates/${t.key}`);
      await qc.invalidateQueries({ queryKey: ['templates'] });
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section className="card">
      <div className="section-head">
        <h2>Templates</h2>
        <button className="primary" onClick={() => setEditing('new')}>Add template</button>
      </div>
      <p className="muted small">Required sections are <code>## Headings</code> that must exist and have content before a page using the template can be checked in.</p>
      {error != null && <ErrorBox error={error} />}
      <table className="data-table">
        <thead><tr><th>Name</th><th>Required sections</th><th>Review every</th><th>Pages</th><th /></tr></thead>
        <tbody>
          {templates.data?.map((t) => (
            <tr key={t.key}>
              <td>{t.name} {t.builtin && <span className="badge">built-in</span>}<div className="muted small">{t.description}</div></td>
              <td className="small">{t.requiredSections.join(', ') || <span className="muted">none</span>}</td>
              <td className="nowrap">{t.reviewIntervalMonths ? `${t.reviewIntervalMonths} months` : <span className="muted">—</span>}</td>
              <td>{t.pageCount}</td>
              <td className="nowrap">
                <button className="small" onClick={() => setEditing(t)}>Edit</button>
                {!t.builtin && <button className="small" onClick={() => void remove(t)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <TemplateEditor template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function TemplateEditor({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    key: template?.key ?? '',
    name: template?.name ?? '',
    description: template?.description ?? '',
    body: template?.body ?? '## Overview\n\n<!-- Hint text in HTML comments is shown in the editor but does not count as content. -->\n',
    required: template?.requiredSections.join('\n') ?? '',
    review: template?.reviewIntervalMonths?.toString() ?? '',
  });
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = {
      name: f.name,
      description: f.description,
      body: f.body,
      requiredSections: f.required.split('\n').map((s) => s.trim()).filter(Boolean),
      reviewIntervalMonths: f.review ? Number(f.review) : null,
    };
    try {
      if (template) await api.patch(`/templates/${template.key}`, body);
      else await api.post('/templates', { key: f.key, ...body });
      await qc.invalidateQueries({ queryKey: ['templates'] });
      onClose();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal title={template ? `Edit ${template.name}` : 'Add template'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          {!template && <label>Key<input autoFocus value={f.key} onChange={set('key')} placeholder="postmortem" pattern="[a-z0-9][a-z0-9\-]{1,31}" required /></label>}
          <label className="grow">Name<input value={f.name} onChange={set('name')} required /></label>
          <label>Review every (months)<input type="number" min={1} max={120} value={f.review} onChange={set('review')} placeholder="none" /></label>
        </div>
        <label>Description<input value={f.description} onChange={set('description')} /></label>
        <label>
          Required sections <span className="muted small">(one H2 heading per line)</span>
          <textarea rows={4} value={f.required} onChange={set('required')} disabled={template?.key === 'blank'} />
        </label>
        <label>
          Starting content <span className="muted small">(Markdown; put hints in &lt;!-- comments --&gt;)</span>
          <textarea rows={14} className="mono" value={f.body} onChange={set('body')} />
        </label>
        <p className="muted small">The review interval is stored now and used when review dates arrive in a later version.</p>
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Save template</button>
        </div>
      </form>
    </Modal>
  );
}
