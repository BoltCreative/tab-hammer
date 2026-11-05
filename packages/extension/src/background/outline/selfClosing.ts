// The Chrome windows and tabs the worker itself is closing (hibernate, trash, a drop into a
// hibernated window). Their records already let go of their Chrome IDs, but chrome.windows.remove
// resolves when the close starts, not when the window is gone: a reconcile in between would see
// a still-listed window or tab nobody holds and record it as new. So they're left out of every
// snapshot until Chrome reports them removed, the close fails, or the close has hung for
// CLOSE_GIVE_UP_MS (a page's beforeunload Cancel stops it without any error), after which a window
// or tab still open reconciles normally again.
import type { ChromeSnapshot, Effects } from '../../model/outline/types';

export const CLOSE_GIVE_UP_MS = 10_000;

export interface SelfClosing {
  /** Before running `effects`: these are about to close. */
  add(effects: Effects): void;
  /** A close that failed: these stay open, so reconcile sees them again. */
  release(effects: Partial<Effects>): void;
  windowRemoved(chromeWindowId: number): void;
  tabRemoved(chromeTabId: number): void;
  /** `snapshot` without what's closing. */
  filter(snapshot: ChromeSnapshot): ChromeSnapshot;
}

export function createSelfClosing(opts: { now?: () => number } = {}): SelfClosing {
  const now = opts.now ?? Date.now;
  const windows = new Map<number, number>(); // Chrome ID -> when its close started
  const tabs = new Map<number, number>();
  const expire = (m: Map<number, number>) => {
    const cutoff = now() - CLOSE_GIVE_UP_MS;
    for (const [id, at] of m) if (at <= cutoff) m.delete(id);
  };
  return {
    add(e) {
      const at = now();
      for (const id of e.closeWindows) windows.set(id, at);
      for (const id of e.closeTabs) tabs.set(id, at);
    },
    release(e) {
      for (const id of e.closeWindows ?? []) windows.delete(id);
      for (const id of e.closeTabs ?? []) tabs.delete(id);
    },
    windowRemoved: (id) => void windows.delete(id),
    tabRemoved: (id) => void tabs.delete(id),
    filter(snapshot) {
      expire(windows);
      expire(tabs);
      if (windows.size === 0 && tabs.size === 0) return snapshot;
      return {
        ...snapshot,
        windowIds: snapshot.windowIds.filter((id) => !windows.has(id)),
        tabs: snapshot.tabs.filter((t) => !tabs.has(t.id) && !windows.has(t.windowId)),
        groups: snapshot.groups.filter((g) => !windows.has(g.windowId)),
      };
    },
  };
}
