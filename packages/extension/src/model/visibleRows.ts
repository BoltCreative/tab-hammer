import type { GroupNode, WindowNode } from './types';

/**
 * A collapse choice the view makes for a group without touching Chrome's, remembered with the
 * Chrome value it was made against.
 */
export interface GroupOverride {
  collapsed: boolean;
  chromeCollapsed: boolean;
}

export interface CollapseState {
  collapsedWindows: ReadonlySet<string>;
  groupOverrides: ReadonlyMap<string, GroupOverride>;
  /** Show everything expanded, whatever else says (while a search filters the outline). */
  expandAll?: boolean;
}

export const EXPAND_ALL: CollapseState = {
  collapsedWindows: new Set(),
  groupOverrides: new Map(),
  expandAll: true,
};

// An override only holds while Chrome's own collapsed flag is unchanged; once Chrome's flag
// changes, the view mirrors Chrome again.
function liveOverride(g: GroupNode, c: CollapseState): GroupOverride | undefined {
  const o = c.groupOverrides.get(g.key);
  return o && o.chromeCollapsed === g.chromeCollapsed ? o : undefined;
}

export function isGroupCollapsed(g: GroupNode, c: CollapseState): boolean {
  if (c.expandAll) return false;
  return liveOverride(g, c)?.collapsed ?? g.chromeCollapsed;
}

/** Flips a group's displayed collapse state without touching Chrome's. */
export function toggleGroup(g: GroupNode, c: CollapseState): CollapseState {
  const next = new Map(c.groupOverrides);
  next.set(g.key, { collapsed: !isGroupCollapsed(g, c), chromeCollapsed: g.chromeCollapsed });
  return { ...c, groupOverrides: next };
}

/** Collapses or expands a window; `c` itself when it already is. */
export function setWindowCollapsed(
  c: CollapseState,
  key: string,
  collapsed: boolean,
): CollapseState {
  if (c.collapsedWindows.has(key) === collapsed) return c;
  const windows = new Set(c.collapsedWindows);
  if (collapsed) windows.add(key);
  else windows.delete(key);
  return { ...c, collapsedWindows: windows };
}

/** Collapses or expands a group without touching Chrome's; `c` itself when it already is. */
export function setGroupCollapsed(
  c: CollapseState,
  g: GroupNode,
  collapsed: boolean,
): CollapseState {
  const o = c.groupOverrides.get(g.key);
  if (o?.collapsed === collapsed && o.chromeCollapsed === g.chromeCollapsed) return c;
  const groups = new Map(c.groupOverrides);
  groups.set(g.key, { collapsed, chromeCollapsed: g.chromeCollapsed });
  return { ...c, groupOverrides: groups };
}

/**
 * Drops what no longer applies: windows and groups the outline no longer holds anywhere (pass its
 * windows and its trash), and overrides Chrome has since superseded, so they cannot revive if
 * Chrome's flag later flips back. Returns `c` itself when nothing changed.
 */
export function pruneCollapse(windows: WindowNode[], c: CollapseState): CollapseState {
  const windowKeys = new Set(windows.map((w) => w.key));
  const groups = new Map<string, GroupNode>();
  for (const w of windows) for (const x of w.children) if (x.kind === 'group') groups.set(x.key, x);
  let nextWindows: Set<string> | null = null;
  for (const key of c.collapsedWindows) {
    if (windowKeys.has(key)) continue;
    nextWindows ??= new Set(c.collapsedWindows);
    nextWindows.delete(key);
  }
  let nextGroups: Map<string, GroupOverride> | null = null;
  for (const [key, o] of c.groupOverrides) {
    const g = groups.get(key);
    if (g && o.chromeCollapsed === g.chromeCollapsed) continue;
    nextGroups ??= new Map(c.groupOverrides);
    nextGroups.delete(key);
  }
  if (!nextWindows && !nextGroups) return c;
  return {
    ...c,
    collapsedWindows: nextWindows ?? c.collapsedWindows,
    groupOverrides: nextGroups ?? c.groupOverrides,
  };
}

/**
 * Expansions shown in one view only, over the shared collapse state: a docked panel opening
 * recentered on its own window expands that window or group there, without changing it for every
 * other view.
 */
export interface LocalExpansion {
  windows: ReadonlySet<string>;
  groups: ReadonlyMap<string, GroupOverride>;
}

export const NO_LOCAL_EXPANSION: LocalExpansion = { windows: new Set(), groups: new Map() };

/** What the view shows: the shared state with this view's own expansions laid over it. */
export function withLocalExpansion(c: CollapseState, local: LocalExpansion): CollapseState {
  if (local.windows.size === 0 && local.groups.size === 0) return c;
  const windows = new Set(c.collapsedWindows);
  for (const key of local.windows) windows.delete(key);
  return {
    ...c,
    collapsedWindows: windows,
    groupOverrides: new Map([...c.groupOverrides, ...local.groups]),
  };
}

/** The shared collapse state as stored in chrome.storage.local (JSON). */
export interface StoredCollapse {
  windows: string[];
  groups: Record<string, GroupOverride>;
}

export function toStoredCollapse(c: CollapseState): StoredCollapse {
  return { windows: [...c.collapsedWindows], groups: Object.fromEntries(c.groupOverrides) };
}

/** Reads what toStoredCollapse wrote, leaving out anything malformed. */
export function fromStoredCollapse(v: unknown): CollapseState {
  const s = (typeof v === 'object' && v !== null ? v : {}) as Partial<Record<string, unknown>>;
  const windows = Array.isArray(s.windows)
    ? s.windows.filter((k): k is string => typeof k === 'string')
    : [];
  const groups = new Map<string, GroupOverride>();
  if (typeof s.groups === 'object' && s.groups !== null) {
    for (const [key, o] of Object.entries(s.groups)) {
      const { collapsed, chromeCollapsed } = (o ?? {}) as Partial<GroupOverride>;
      if (typeof collapsed === 'boolean' && typeof chromeCollapsed === 'boolean') {
        groups.set(key, { collapsed, chromeCollapsed });
      }
    }
  }
  return { collapsedWindows: new Set(windows), groupOverrides: groups };
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
