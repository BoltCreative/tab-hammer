import type { OutlineRow } from './keyboardNav';
import type { GroupNode, TabNode, WindowNode } from './types';
import { isGroupCollapsed, type CollapseState } from './visibleRows';

/** A window's active (current) tab, if it's live and Chrome reports one. */
export function activeTabOf(w: WindowNode): TabNode | undefined {
  if (w.hibernated) return undefined;
  for (const c of w.children) {
    const tabs = c.kind === 'group' ? c.tabs : [c];
    const t = tabs.find((x) => x.active && !x.hibernated);
    if (t) return t;
  }
  return undefined;
}

/**
 * The Current tabs view: every window's header, and under a live window only its active tab (out
 * of any group, so it's one row per window). Hibernated windows show just their header. A view
 * filter only; the outline is untouched.
 */
export function currentTabsTree(tree: WindowNode[]): WindowNode[] {
  return tree.map((w) => {
    const t = activeTabOf(w);
    return { ...w, children: t ? [t] : [] };
  });
}

/**
 * The cursor's path in the Current tabs view: each live window's current tab stands for its
 * window, so ↑/↓ step from tab to tab. A window header with no tab under it (hibernated) stays,
 * so Enter can still open it. The tabs have no parent to step out to.
 */
export function currentTabsNavRows(rows: readonly OutlineRow[]): OutlineRow[] {
  const out: OutlineRow[] = [];
  rows.forEach((r, i) => {
    if (r.kind === 'window' && rows[i + 1]?.parent === r.key) return;
    out.push(r.parent !== null && r.kind === 'tab' ? { ...r, parent: null } : r);
  });
  return out;
}

/**
 * Where recentering on window `w` lands: its active tab (the window header when it has none), and
 * what has to expand so that row shows: the window, if collapsed, and the tab's group, if collapsed.
 */
export function recenterTarget(
  w: WindowNode,
  c: CollapseState,
): { key: string; expandWindow: boolean; expandGroup: GroupNode | undefined } {
  const t = activeTabOf(w);
  if (!t) return { key: w.key, expandWindow: false, expandGroup: undefined };
  const group = w.children.find((x): x is GroupNode => x.kind === 'group' && x.tabs.includes(t));
  return {
    key: t.key,
    expandWindow: c.collapsedWindows.has(w.key),
    expandGroup: group && isGroupCollapsed(group, c) ? group : undefined,
  };
}
