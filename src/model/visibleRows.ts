import type { GroupNode, WindowNode } from './types';

/** A display-only collapse choice, remembered with the Chrome value it was made against. */
export interface GroupOverride {
  collapsed: boolean;
  chromeCollapsed: boolean;
}

export interface CollapseState {
  collapsedWindows: ReadonlySet<string>;
  groupOverrides: ReadonlyMap<string, GroupOverride>;
}

// An override only holds while Chrome's own collapsed flag is unchanged; once Chrome's flag
// changes, the view mirrors Chrome again.
function liveOverride(g: GroupNode, c: CollapseState): GroupOverride | undefined {
  const o = c.groupOverrides.get(g.key);
  return o && o.chromeCollapsed === g.chromeCollapsed ? o : undefined;
}

export function isGroupCollapsed(g: GroupNode, c: CollapseState): boolean {
  return liveOverride(g, c)?.collapsed ?? g.chromeCollapsed;
}

/** Flips a group's displayed collapse state without touching Chrome's. */
export function toggleGroup(g: GroupNode, c: CollapseState): CollapseState {
  const next = new Map(c.groupOverrides);
  next.set(g.key, { collapsed: !isGroupCollapsed(g, c), chromeCollapsed: g.chromeCollapsed });
  return { ...c, groupOverrides: next };
}

/**
 * Drops overrides that Chrome has since superseded, so they cannot revive if Chrome's flag
 * later flips back. Returns `c` itself when nothing changed.
 */
export function discardStaleOverrides(tree: WindowNode[], c: CollapseState): CollapseState {
  const groups = new Map<string, GroupNode>();
  for (const w of tree) for (const x of w.children) if (x.kind === 'group') groups.set(x.key, x);
  let next: Map<string, GroupOverride> | null = null;
  for (const [key, o] of c.groupOverrides) {
    const g = groups.get(key);
    if (g && o.chromeCollapsed !== g.chromeCollapsed) {
      next ??= new Map(c.groupOverrides);
      next.delete(key);
    }
  }
  return next ? { ...c, groupOverrides: next } : c;
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
