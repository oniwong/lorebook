import type { TreePage } from './api';

export type TreeNode = TreePage & { children: TreeNode[] };

export function buildTree(pages: TreePage[]): TreeNode[] {
  const byId = new Map<number, TreeNode>();
  for (const p of pages) byId.set(p.id, { ...p, children: [] });
  const roots: TreeNode[] = [];
  for (const n of byId.values()) {
    const parent = n.parentId !== null ? byId.get(n.parentId) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const sort = (ns: TreeNode[]) => {
    ns.sort((a, b) => a.position - b.position || a.id - b.id);
    ns.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** Depth-first list with depth, for indented pickers. */
export function flatten(nodes: TreeNode[], depth = 0, out: { node: TreeNode; depth: number }[] = []) {
  for (const n of nodes) {
    out.push({ node: n, depth });
    flatten(n.children, depth + 1, out);
  }
  return out;
}

/** Ids of a page and everything below it. */
export function subtreeIds(pages: TreePage[], rootId: number): Set<number> {
  const kids = new Map<number, number[]>();
  for (const p of pages) if (p.parentId !== null) kids.set(p.parentId, [...(kids.get(p.parentId) ?? []), p.id]);
  const out = new Set<number>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(kids.get(id) ?? []));
  }
  return out;
}
