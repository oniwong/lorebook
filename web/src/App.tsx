import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from './lib/session';
import { api, pagePath, type Page } from './lib/api';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { SpaceHome } from './pages/SpaceHome';
import { PageView } from './pages/PageView';
import { PageEdit } from './pages/PageEdit';
import { HistoryPage } from './pages/HistoryPage';
import { AdminPage } from './pages/AdminPage';
import { AccountPage } from './pages/AccountPage';
import { ErrorBox } from './components/ErrorBox';

/** Short internal links (/p/123) redirect to the page's canonical URL. */
function ShortLink() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['page', Number(id)], queryFn: () => api.get<Page>(`/pages/${id}`) });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return null;
  return <Navigate to={pagePath(q.data)} replace />;
}

export function App() {
  const { user, loading } = useSession();
  if (loading) return null;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/p/:id/edit" element={<PageEdit />} />
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/p/:id" element={<ShortLink />} />
        <Route path="/p/:id/history" element={<HistoryPage />} />
        <Route path="/s/:key" element={<SpaceHome />} />
        <Route path="/s/:key/p/:id/:slug?" element={<PageView />} />
        <Route path="/admin" element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/" replace />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<ErrorBox error={new Error('Page not found')} />} />
      </Route>
    </Routes>
  );
}
