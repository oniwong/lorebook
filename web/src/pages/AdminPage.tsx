import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDateTime, type Space } from '../lib/api';
import { useUser } from '../lib/session';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';

type AdminUser = {
  id: number; username: string; displayName: string; email: string | null; role: 'user' | 'admin';
  active: boolean; authSource: string; createdAt: string;
};

export function AdminPage() {
  return (
    <div className="content wide">
      <h1>Admin</h1>
      <SpacesAdmin />
      <UsersAdmin />
    </div>
  );
}

function SpacesAdmin() {
  const qc = useQueryClient();
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<Space[]>('/spaces') });
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/spaces', { key, name, description });
      setKey(''); setName(''); setDescription('');
      await qc.invalidateQueries({ queryKey: ['spaces'] });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section className="card">
      <h2>Spaces</h2>
      <table className="data-table">
        <thead><tr><th>Key</th><th>Name</th><th>Description</th><th>Pages</th></tr></thead>
        <tbody>
          {spaces.data?.map((s) => (
            <tr key={s.id}><td><code>{s.key}</code></td><td>{s.name}</td><td className="muted">{s.description}</td><td>{s.pageCount}</td></tr>
          ))}
        </tbody>
      </table>
      <form className="form inline-form" onSubmit={create}>
        <label>Key<input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="network" pattern="[a-z0-9][a-z0-9\-]{1,31}" title="2-32 lowercase letters, digits or dashes" required /></label>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Network" required /></label>
        <label className="grow">Description<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" /></label>
        <button className="primary" type="submit">Create Space</button>
      </form>
      {error != null && <ErrorBox error={error} />}
    </section>
  );
}

function UsersAdmin() {
  const me = useUser();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<AdminUser[]>('/users') });
  const [creating, setCreating] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUser | null>(null);
  const [error, setError] = useState<unknown>(null);

  const patch = async (u: AdminUser, body: Partial<AdminUser>) => {
    setError(null);
    try {
      await api.patch(`/users/${u.id}`, body);
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section className="card">
      <div className="section-head">
        <h2>Users</h2>
        <button className="primary" onClick={() => setCreating(true)}>Add user</button>
      </div>
      {error != null && <ErrorBox error={error} />}
      <table className="data-table">
        <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Created</th><th /></tr></thead>
        <tbody>
          {users.data?.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'inactive'}>
              <td>{u.username}</td>
              <td>{u.displayName}</td>
              <td>
                <select value={u.role} disabled={u.id === me.id} onChange={(e) => void patch(u, { role: e.target.value as AdminUser['role'] })}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </td>
              <td>{u.active ? 'Active' : 'Disabled'}</td>
              <td className="nowrap muted">{formatDateTime(u.createdAt)}</td>
              <td className="nowrap">
                {u.authSource === 'local' && <button className="small" onClick={() => setResetFor(u)}>Set password</button>}
                {u.id !== me.id && (
                  <button className="small" onClick={() => void patch(u, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {creating && <CreateUser onClose={() => setCreating(false)} />}
      {resetFor && <ResetPassword user={resetFor} onClose={() => setResetFor(null)} />}
    </section>
  );
}

function CreateUser({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ username: '', displayName: '', email: '', password: '', role: 'user' });
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/users', f);
      await qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal title="Add local user" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Username<input autoFocus value={f.username} onChange={set('username')} required /></label>
        <label>Display name<input value={f.displayName} onChange={set('displayName')} required /></label>
        <label>Email <span className="muted small">(optional)</span><input type="email" value={f.email} onChange={set('email')} /></label>
        <label>Initial password <span className="muted small">(at least 12 characters)</span><input type="password" autoComplete="new-password" minLength={12} value={f.password} onChange={set('password')} required /></label>
        <label>Role
          <select value={f.role} onChange={set('role')}><option value="user">User</option><option value="admin">Admin</option></select>
        </label>
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Create user</button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(`/users/${user.id}`, { password });
      onClose();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title={`Set password for ${user.username}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>New password<input autoFocus type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <p className="muted small">This signs the user out everywhere.</p>
        {error != null && <ErrorBox error={error} />}
        <div className="form-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Set password</button>
        </div>
      </form>
    </Modal>
  );
}
