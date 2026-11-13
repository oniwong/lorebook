import { useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, pagePath, type Space, type TreePage } from '../lib/api';
import { useSession } from '../lib/session';
import { NewPageDialog } from './NewPageDialog';

type Node = TreePage & { children: Node[] };

function buildTree(pages: TreePage[]): Node[] {
  const byId = new Map<number, Node>();
  for (const p of pages) byId.set(p.id, { ...p, children: [] });
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const parent = n.parentId !== null ? byId.get(n.parentId) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const sort = (ns: Node[]) => {
    ns.sort((a, b) => a.position - b.position || a.id - b.id);
    ns.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

function ancestorsOf(pages: TreePage[], id: number | undefined): Set<number> {
  const parent = new Map(pages.map((p) => [p.id, p.parentId]));
  const out = new Set<number>();
  let cur = id !== undefined ? parent.get(id) : null;
  while (cur != null && !out.has(cur)) {
    out.add(cur);
    cur = parent.get(cur) ?? null;
  }
  return out;
}

export function Sidebar({ spaceKey, currentPageId }: { spaceKey?: string; currentPageId?: number }) {
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<Space[]>('/spaces') });
  const tree = useQuery({
    queryKey: ['tree', spaceKey],
    queryFn: () => api.get<{ space: Space; pages: TreePage[] }>(`/spaces/${spaceKey}/tree`),
    enabled: !!spaceKey,
  });
  const { prefs, setPref } = useSession();
  const [newPage, setNewPage] = useState<{ parentId: number | null } | null>(null);

  const open = useMemo(() => new Set((prefs.treeOpen as number[] | undefined) ?? []), [prefs.treeOpen]);
  const ancestors = useMemo(() => ancestorsOf(tree.data?.pages ?? [], currentPageId), [tree.data, currentPageId]);
  const roots = useMemo(() => buildTree(tree.data?.pages ?? []), [tree.data]);

  const toggle = (id: number, isOpen: boolean) => {
    const next = new Set(open);
    if (isOpen) next.delete(id);
    else next.add(id);
    setPref('treeOpen', [...next]);
  };

  const renderNode = (n: Node, depth: number) => {
    const isOpen = open.has(n.id) || ancestors.has(n.id);
    return (
      <li key={n.id}>
        <div className={`tree-row${n.id === currentPageId ? ' current' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
          {n.children.length > 0 ? (
            <button className="twisty" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={() => toggle(n.id, isOpen)}>
              {isOpen ? '▾' : '▸'}
            </button>
          ) : (
            <span className="twisty" />
          )}
          <Link to={pagePath({ spaceKey: spaceKey!, id: n.id, slug: n.slug })} className="tree-link" title={n.title}>
            {n.title}
          </Link>
          {n.checkedOut && <span className="tree-badge" title="Checked out">✎</span>}
          <button className="tree-add" title="Add subpage" onClick={() => setNewPage({ parentId: n.id })}>+</button>
        </div>
        {isOpen && n.children.length > 0 && <ul>{n.children.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <nav className="side-nav">
      <div className="side-section">
        <div className="side-heading">Spaces</div>
        <ul className="space-list">
          {spaces.data?.map((s) => (
            <li key={s.id}>
              <NavLink to={`/s/${s.key}`} className={() => (s.key === spaceKey ? 'active' : '')}>{s.name}</NavLink>
            </li>
          ))}
          {spaces.data?.length === 0 && <li className="muted small">No Spaces yet</li>}
        </ul>
      </div>
      {spaceKey && tree.data && (
        <div className="side-section">
          <div className="side-heading">
            <span>{tree.data.space.name}</span>
            <button className="link-btn" onClick={() => setNewPage({ parentId: null })}>+ New page</button>
          </div>
          <ul className="tree">{roots.map((n) => renderNode(n, 0))}</ul>
          {roots.length === 0 && <p className="muted small pad">This Space is empty.</p>}
        </div>
      )}
      {newPage && spaceKey && (
        <NewPageDialog spaceKey={spaceKey} parentId={newPage.parentId} onClose={() => setNewPage(null)} />
      )}
    </nav>
  );
}
