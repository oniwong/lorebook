import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, pagePath, type Space, type TreePage } from '../lib/api';
import { ErrorBox } from '../components/ErrorBox';

export function SpaceHome() {
  const { key } = useParams();
  const tree = useQuery({
    queryKey: ['tree', key],
    queryFn: () => api.get<{ space: Space; pages: TreePage[] }>(`/spaces/${key}/tree`),
  });
  if (tree.error) return <div className="content"><ErrorBox error={tree.error} /></div>;
  if (!tree.data) return null;
  const { space, pages } = tree.data;
  const top = pages.filter((p) => p.parentId === null).sort((a, b) => a.position - b.position);
  return (
    <div className="content">
      <h1>{space.name}</h1>
      {space.description && <p className="lead">{space.description}</p>}
      <p className="muted">{pages.length} pages. Use <strong>+ New page</strong> in the sidebar to add one.</p>
      <ul className="plain-list">
        {top.map((p) => <li key={p.id}><Link to={pagePath({ spaceKey: space.key, id: p.id, slug: p.slug })}>{p.title}</Link></li>)}
      </ul>
    </div>
  );
}
