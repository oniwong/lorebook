import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useUser } from '../lib/session';
import { ErrorBox } from '../components/ErrorBox';

export function AccountPage() {
  const user = useUser();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== again) return setError(new Error('The new passwords do not match'));
    try {
      await api.post('/me/password', { currentPassword: current, newPassword: next });
      setDone(true);
      setCurrent(''); setNext(''); setAgain('');
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="content">
      <h1>Account</h1>
      <dl className="kv">
        <dt>Username</dt><dd>{user.username}</dd>
        <dt>Name</dt><dd>{user.displayName}</dd>
        <dt>Role</dt><dd>{user.role}</dd>
      </dl>
      {user.authSource === 'local' ? (
        <form className="form card narrow" onSubmit={submit}>
          <h2>Change password</h2>
          <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></label>
          <label>New password <span className="muted small">(at least 12 characters)</span><input type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
          <label>Repeat new password<input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></label>
          {error != null && <ErrorBox error={error} />}
          {done && <div className="banner info">Password changed. Your other sessions were signed out.</div>}
          <div className="form-actions"><button className="primary" type="submit">Change password</button></div>
        </form>
      ) : (
        <p className="muted">Your password is managed by the directory.</p>
      )}
    </div>
  );
}
