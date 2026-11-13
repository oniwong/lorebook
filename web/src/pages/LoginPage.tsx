import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorBox } from '../components/ErrorBox';

export function LoginPage() {
  const { refresh } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { username, password });
      await refresh();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login card form" onSubmit={submit}>
        <h1>Lorebook</h1>
        <p className="muted">Sign in to the IT knowledge base</p>
        <label>
          Username
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error != null && <ErrorBox error={error} />}
        <button className="primary" type="submit" disabled={busy}>Sign in</button>
      </form>
    </div>
  );
}
