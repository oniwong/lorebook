import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Template } from '../lib/api';
import { Modal } from './Modal';
import { ErrorBox } from './ErrorBox';

export function useTemplates() {
  return useQuery({ queryKey: ['templates'], queryFn: () => api.get<Template[]>('/templates'), staleTime: 60_000 });
}

export function NewPageDialog({ spaceKey, parentId, parentTitle, onClose }: {
  spaceKey: string; parentId: number | null; parentTitle?: string; onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [template, setTemplate] = useState('blank');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useTemplates();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.post<{ id: number }>('/pages', { spaceKey, parentId, title, template });
      await qc.invalidateQueries({ queryKey: ['tree', spaceKey] });
      await qc.invalidateQueries({ queryKey: ['spaces'] });
      onClose();
      navigate(`/p/${p.id}/edit`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={parentId ? 'New subpage' : 'New page'} onClose={onClose} wide>
      <form onSubmit={submit} className="form">
        {parentTitle && <p className="muted">Under “{parentTitle}”</p>}
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
        </label>
        <fieldset className="template-picker">
          <legend>Template</legend>
          {templates.data?.map((t) => (
            <label key={t.key} className={`template-card${template === t.key ? ' on' : ''}`}>
              <input type="radio" name="template" value={t.key} checked={template === t.key} onChange={() => setTemplate(t.key)} />
              <strong>{t.name}</strong>
              <span className="muted small">{t.description}</span>
              {t.requiredSections.length > 0 && (
                <span className="small template-sections">Sections: {t.requiredSections.join(' · ')}</span>
              )}
            </label>
          ))}
        </fieldset>
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !title.trim()}>Create and edit</button>
        </div>
      </form>
    </Modal>
  );
}
