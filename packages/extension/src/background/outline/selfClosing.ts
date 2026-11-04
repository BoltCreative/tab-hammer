// The Chrome windows and tabs the worker itself is closing (hibernate, trash, a drop into a
// hibernated window). Their records already let go of their Chrome IDs, but chrome.windows.remove
// resolves when the close starts, not when the window is gone: a reconcile in between would see
// a still-listed window or tab nobody holds and record it as new. So they're left out of every
// snapshot until Chrome reports them removed, or until the close fails (a page cancelled it).
import type { ChromeSnapshot, Effects } from '../../model/outline/types';

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

export function createSelfClosing(): SelfClosing {
  const windows = new Set<number>();
  const tabs = new Set<number>();
  return {
    add(e) {
      for (const id of e.closeWindows) windows.add(id);
      for (const id of e.closeTabs) tabs.add(id);
    },
    release(e) {
      for (const id of e.closeWindows ?? []) windows.delete(id);
      for (const id of e.closeTabs ?? []) tabs.delete(id);
    },
    windowRemoved: (id) => void windows.delete(id),
    tabRemoved: (id) => void tabs.delete(id),
    filter(snapshot) {
      if (windows.size === 0 && tabs.size === 0) return snapshot;
      return {
        windowIds: snapshot.windowIds.filter((id) => !windows.has(id)),
        tabs: snapshot.tabs.filter((t) => !tabs.has(t.id) && !windows.has(t.windowId)),
        groups: snapshot.groups.filter((g) => !windows.has(g.windowId)),
      };
    },
  };
}
