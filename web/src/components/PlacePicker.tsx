import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Space, type TreePage } from '../lib/api';
import { buildTree, flatten, subtreeIds } from '../lib/tree';

export type Place = { spaceKey: string; parentId: number | null };

/** Choose a Space and a parent page in it. Pages in `excludeSubtreeOf` (a page and its subpages) can't be picked. */
export function PlacePicker({ value, onChange, excludeSubtreeOf }: {
  value: Place; onChange: (p: Place) => void; excludeSubtreeOf?: number;
}) {
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: () => api.get<Space[]>('/spaces') });
  const tree = useQuery({
    queryKey: ['tree', value.spaceKey],
    queryFn: () => api.get<{ space: Space; pages: TreePage[] }>(`/spaces/${value.spaceKey}/tree`),
    enabled: !!value.spaceKey,
  });
  const options = useMemo(() => {
    const pages = tree.data?.pages ?? [];
    const excluded = excludeSubtreeOf !== undefined ? subtreeIds(pages, excludeSubtreeOf) : new Set<number>();
    return flatten(buildTree(pages)).map(({ node, depth }) => ({ node, depth, disabled: excluded.has(node.id) }));
  }, [tree.data, excludeSubtreeOf]);

  return (
    <>
      <label>
        Space
        <select value={value.spaceKey} onChange={(e) => onChange({ spaceKey: e.target.value, parentId: null })}>
          {spaces.data?.map((s) => <option key={s.id} value={s.key}>{s.name}</option>)}
        </select>
      </label>
      <label>
        Parent page
        <select value={value.parentId ?? ''} onChange={(e) => onChange({ ...value, parentId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">(top level of the Space)</option>
          {options.map(({ node, depth, disabled }) => (
            <option key={node.id} value={node.id} disabled={disabled}>
              {'  '.repeat(depth * 2)}{node.title}{disabled ? ' (this page)' : ''}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
