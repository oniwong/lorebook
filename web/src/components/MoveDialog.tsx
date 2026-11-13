import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, pagePath, type Page } from '../lib/api';
import { Modal } from './Modal';
import { ErrorBox } from './ErrorBox';
import { PlacePicker, type Place } from './PlacePicker';

export function MoveDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const [place, setPlace] = useState<Place>({ spaceKey: page.spaceKey, parentId: page.parentId });
  const [where, setWhere] = useState<'last' | 'first'>('last');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/pages/${page.id}/move`, { spaceKey: place.spaceKey, parentId: place.parentId, index: where === 'first' ? 0 : null });
      await qc.invalidateQueries({ queryKey: ['tree'] });
      await qc.invalidateQueries({ queryKey: ['spaces'] });
      const fresh = await qc.fetchQuery({ queryKey: ['page', page.id], queryFn: () => api.get<Page>(`/pages/${page.id}`) });
      onClose();
      navigate(pagePath(fresh));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Move “${page.title}”`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted small">Subpages move with it. Links keep working, because pages are linked by id.</p>
        <PlacePicker value={place} onChange={setPlace} excludeSubtreeOf={page.id} />
        <label>
          Position
          <select value={where} onChange={(e) => setWhere(e.target.value as 'last' | 'first')}>
            <option value="last">Last among its siblings</option>
            <option value="first">First among its siblings</option>
          </select>
        </label>
        <p className="muted small">Tip: you can also drag pages in the sidebar tree.</p>
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>Move</button>
        </div>
      </form>
    </Modal>
  );
}
