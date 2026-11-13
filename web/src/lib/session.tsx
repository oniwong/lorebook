import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler, type User } from './api';

type SessionState = {
  user: User | null;
  prefs: Record<string, unknown>;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setPref: (key: string, value: unknown) => void;
};

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [prefs, setPrefs] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const refresh = useCallback(async () => {
    try {
      const s = await api.get<{ user: User; csrfToken: string; prefs: Record<string, unknown> }>('/auth/session');
      setCsrfToken(s.csrfToken);
      setUser(s.user);
      setPrefs(s.prefs ?? {});
    } catch {
      setCsrfToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setUser(null);
    });
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setCsrfToken(null);
    setUser(null);
  }, []);

  const setPref = useCallback((key: string, value: unknown) => {
    const next = { ...prefsRef.current, [key]: value };
    prefsRef.current = next;
    setPrefs(next);
    void api.put('/me/prefs', next).catch(() => undefined);
  }, []);

  return <Ctx.Provider value={{ user, prefs, loading, refresh, logout, setPref }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

export function useUser(): User {
  const { user } = useSession();
  if (!user) throw new Error('Not signed in');
  return user;
}
