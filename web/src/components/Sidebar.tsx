import { useMemo, useState, type DragEvent } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, pagePath, type Space, type TreePage } from '../lib/api';
import { useSession } from '../lib/session';
import { buildTree, subtreeIds, type TreeNode as Node } from '../lib/tree';
import { NewPageDialog } from './NewPageDialog';

const DRAG_TYPE = 'application/x-lorebook-page';
type DropZone = 'before' | 'inside' | 'after';

function zoneFor(e: DragEvent<HTMLElement>): DropZone {
  const r = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
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
  const qc = useQueryClient();
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ id: number | string; zone: DropZone } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const open = useMemo(() => new Set((prefs.treeOpen as number[] | undefined) ?? []), [prefs.treeOpen]);
  const ancestors = useMemo(() => ancestorsOf(tree.data?.pages ?? [], currentPageId), [tree.data, currentPageId]);
  const roots = useMemo(() => buildTree(tree.data?.pages ?? []), [tree.data]);

  const blocked = useMemo(
    () => (dragId !== null && tree.data ? subtreeIds(tree.data.pages, dragId) : new Set<number>()),
    [dragId, tree.data],
  );

  const move = async (id: number, target: { spaceKey: string; parentId: number | null; index: number | null }) => {
    setMoveError(null);
    try {
      await api.post(`/pages/${id}/move`, target);
      if (target.parentId !== null && !open.has(target.parentId)) setPref('treeOpen', [...open, target.parentId]);
    } catch (e) {
      setMoveError((e as Error).message);
    }
    await qc.invalidateQueries({ queryKey: ['tree'] });
    await qc.invalidateQueries({ queryKey: ['page', id] });
    await qc.invalidateQueries({ queryKey: ['spaces'] });
  };

  const onRowDrop = (e: DragEvent<HTMLDivElement>, n: Node) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData(DRAG_TYPE));
    const zone = zoneFor(e);
    setDropAt(null);
    setDragId(null);
    if (!id || blocked.has(n.id) || id === n.id) return;
    if (zone === 'inside') {
      void move(id, { spaceKey: spaceKey!, parentId: n.id, index: null });
      return;
    }
    const siblings = (tree.data?.pages ?? [])
      .filter((p) => p.parentId === n.parentId && p.id !== id)
      .sort((a, b) => a.position - b.position || a.id - b.id);
    const at = siblings.findIndex((p) => p.id === n.id);
    void move(id, { spaceKey: spaceKey!, parentId: n.parentId, index: zone === 'before' ? at : at + 1 });
  };

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
        <div
          className={`tree-row${n.id === currentPageId ? ' current' : ''}${dragId === n.id ? ' dragging' : ''}${dropAt?.id === n.id ? ` drop-${dropAt.zone}` : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, String(n.id));
            e.dataTransfer.effectAllowed = 'move';
            setDragId(n.id);
          }}
          onDragEnd={() => { setDragId(null); setDropAt(null); }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE) || blocked.has(n.id)) return;
            e.preventDefault();
            const zone = zoneFor(e);
            if (dropAt?.id !== n.id || dropAt.zone !== zone) setDropAt({ id: n.id, zone });
          }}
          onDragLeave={() => setDropAt((d) => (d?.id === n.id ? null : d))}
          onDrop={(e) => onRowDrop(e, n)}
        >
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
        <ul className="space-list">
          <li><NavLink to="/search" end>Search</NavLink></li>
          <li><NavLink to="/stale">Stale pages</NavLink></li>
        </ul>
      </div>
      <div className="side-section">
        <div className="side-heading">Spaces</div>
        <ul className="space-list">
          {spaces.data?.map((s) => (
            <li key={s.id}
              className={dropAt?.id === `space:${s.key}` ? 'drop-inside' : ''}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                setDropAt({ id: `space:${s.key}`, zone: 'inside' });
              }}
              onDragLeave={() => setDropAt((d) => (d?.id === `space:${s.key}` ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                const id = Number(e.dataTransfer.getData(DRAG_TYPE));
                setDropAt(null);
                setDragId(null);
                if (id) void move(id, { spaceKey: s.key, parentId: null, index: null });
              }}
              title="Drop a page here to move it to the top level of this Space"
            >
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
          {moveError && <p className="side-error small" role="alert">{moveError} <button className="link-btn" onClick={() => setMoveError(null)}>×</button></p>}
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
