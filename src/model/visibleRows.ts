import type { GroupNode, WindowNode } from './types';

export interface CollapseState {
  collapsedWindows: ReadonlySet<string>;
  groupOverrides: ReadonlyMap<string, boolean>;
}

export function isGroupCollapsed(g: GroupNode, c: CollapseState): boolean {
  return c.groupOverrides.get(g.key) ?? g.chromeCollapsed;
}

export function visibleRowKeys(tree: WindowNode[], c: CollapseState): string[] {
  const out: string[] = [];
  for (const w of tree) {
    out.push(w.key);
    if (c.collapsedWindows.has(w.key)) continue;
    for (const child of w.children) {
      out.push(child.key);
      if (child.kind === 'group' && !isGroupCollapsed(child, c)) {
        for (const t of child.tabs) out.push(t.key);
      }
    }
  }
  return out;
}

export function allRowKeys(tree: WindowNode[]): Set<string> {
  const out = new Set<string>();
  for (const w of tree) {
    out.add(w.key);
    for (const child of w.children) {
      out.add(child.key);
      if (child.kind === 'group') for (const t of child.tabs) out.add(t.key);
    }
  }
  return out;
}
