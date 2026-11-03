import type { TabNode, WindowNode } from './types';

/**
 * The URL two tabs must share to count as duplicates: the #fragment and utm_* tracking parameters
 * are dropped, and URL parsing already lowercases the scheme and host and drops default ports.
 * Returns null for tabs with nothing to compare (blank, or not a parseable URL).
 */
export function normalizeUrl(url: string): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (k.toLowerCase().startsWith('utm_')) u.searchParams.delete(k);
  }
  // A trailing slash on a deeper path is the same page ("/a/" vs "/a").
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export interface Duplicates {
  /** Keys of every tab that has a duplicate somewhere (keepers included), for highlighting. */
  keys: Set<string>;
  /** The tabs to close: every duplicate but the one kept per URL. */
  toClose: TabNode[];
}

// Which copy survives: the active tab of the window the user was last in, then any active tab,
// then the most recently viewed, then the first in outline order.
function rank(t: TabNode, focusedWindowId: number | null): [number, number, number] {
  return [
    t.active && t.windowId === focusedWindowId ? 1 : 0,
    t.active ? 1 : 0,
    t.lastAccessed ?? 0,
  ];
}

function better(a: TabNode, b: TabNode, focused: number | null): boolean {
  const ra = rank(a, focused);
  const rb = rank(b, focused);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]!;
  return false; // ties keep the earlier tab
}

/** Tabs that share a normalized URL with another tab, in any window. */
export function findDuplicates(tree: WindowNode[]): Duplicates {
  const focused = tree.find((w) => w.focused)?.windowId ?? null;
  const byUrl = new Map<string, TabNode[]>();
  for (const w of tree) {
    for (const c of w.children) {
      for (const t of c.kind === 'group' ? c.tabs : [c]) {
        const n = normalizeUrl(t.url);
        if (n === null) continue;
        const list = byUrl.get(n) ?? [];
        list.push(t);
        byUrl.set(n, list);
      }
    }
  }
  const keys = new Set<string>();
  const toClose: TabNode[] = [];
  for (const tabs of byUrl.values()) {
    if (tabs.length < 2) continue;
    let keep = tabs[0]!;
    for (const t of tabs) if (better(t, keep, focused)) keep = t;
    for (const t of tabs) {
      keys.add(t.key);
      if (t !== keep) toClose.push(t);
    }
  }
  return { keys, toClose };
}
