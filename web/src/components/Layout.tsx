import { useEffect, useState } from 'react';
import { Link, Outlet, useMatch, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Page } from '../lib/api';
import { useSession, useUser } from '../lib/session';
import { Sidebar } from './Sidebar';
import { QuickSwitcher } from './QuickSwitcher';
import { InboxBell } from './InboxBell';

export function Layout() {
  const user = useUser();
  const { logout } = useSession();
  const [switcher, setSwitcher] = useState(false);
  const [menu, setMenu] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const onSearchPage = useMatch('/search');
  const spaceMatch = useMatch('/s/:key/*');
  const pageMatch = useMatch('/s/:key/p/:id/*');
  // Pages outside /s/... (e.g. History) still show their Space's tree.
  const shortMatch = useMatch('/p/:id/*');
  const shortId = shortMatch ? Number(shortMatch.params.id) : undefined;
  const shortPage = useQuery({
    queryKey: ['page', shortId],
    queryFn: () => api.get<Page>(`/pages/${shortId}`),
    enabled: shortId !== undefined && Number.isFinite(shortId),
  });
  const spaceKey = spaceMatch?.params.key ?? (shortId !== undefined ? shortPage.data?.spaceKey : undefined);
  const currentPageId = pageMatch ? Number(pageMatch.params.id) : shortId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcher(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn nav-toggle" aria-label="Toggle navigation" onClick={() => setNavOpen((v) => !v)}>☰</button>
        <Link to="/" className="brand">Lorebook</Link>
        {!onSearchPage && (
          <form className="top-search" role="search" onSubmit={(e) => {
            e.preventDefault();
            navigate(query.trim() ? `/search?q=${encodeURIComponent(query.trim())}` : '/search');
            setQuery('');
          }}>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" aria-label="Search all pages" />
          </form>
        )}
        <button className="switcher-btn" onClick={() => setSwitcher(true)} title="Jump to a page by title">
          <span>Jump to page…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="topbar-right">
          <InboxBell />
          <div className="menu">
            <button className="menu-btn" onClick={() => setMenu((v) => !v)} aria-expanded={menu}>
              {user.displayName} ▾
            </button>
            {menu && (
              <div className="menu-pop" onClick={() => setMenu(false)}>
                <Link to="/account">Account</Link>
                {user.role === 'admin' && <Link to="/admin">Admin</Link>}
                <button onClick={() => void logout()}>Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="body">
        <aside className={`sidebar${navOpen ? ' open' : ''}`} onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setNavOpen(false); }}>
          <Sidebar spaceKey={spaceKey} currentPageId={currentPageId} />
        </aside>
        <main className="main">
          <Outlet />
        </main>
      </div>
      {switcher && <QuickSwitcher onClose={() => setSwitcher(false)} />}
    </div>
  );
}
