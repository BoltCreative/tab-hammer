// Plans reopening hibernated or trashed rows in Chrome, and folds back what Chrome
// created. Pure: the caller runs the plan and passes the clock.

import { findRow } from './lifecycle';
import type { GroupRec, Outline, TabRec, WindowRec } from './types';

export interface OpenTab {
  tabId: string;
  url: string;
  index: number;
  groupId?: string;
}

export interface OpenPlan {
  windowId: string;
  chromeWindowId: number | null; // null = create a new Chrome window
  tabs: OpenTab[]; // ascending index; each index is valid at the moment it is created
  groups: GroupRec[]; // the groups the opened tabs belong to (live ones carry chromeGroupId)
}

export interface Opened {
  chromeWindowId: number;
  tabs: { tabId: string; chromeTabId: number }[]; // only the ones Chrome actually created
  groups: { groupId: string; chromeGroupId: number }[];
}

const isLive = (t: TabRec): boolean => t.chromeTabId !== undefined;

/** `rowId` is a window, group, or tab record (hibernated or trashed). Null if nothing to open. */
export function planOpen(o: Outline, rowId: string): OpenPlan | null {
  const row = findRow(o, rowId);
  if (!row) return null;
  const w = row.window;
  const opening = new Set(
    w.tabs
      .filter((t) => {
        if (isLive(t)) return false;
        if (row.tab) return t.id === row.tab.id;
        if (row.group) return t.groupId === row.group.id;
        return true;
      })
      .map((t) => t.id),
  );
  if (opening.size === 0) return null;

  // In a live window a tab opens after the live and already-opened tabs before it;
  // a new window holds only the opened tabs, so the same count gives 0..n-1.
  const tabs: OpenTab[] = [];
  let index = 0;
  for (const t of w.tabs) {
    if (opening.has(t.id)) {
      const ot: OpenTab = { tabId: t.id, url: t.url, index };
      if (t.groupId !== undefined) ot.groupId = t.groupId;
      tabs.push(ot);
      index++;
    } else if (w.state === 'live' && isLive(t)) index++;
  }
  const used = new Set(tabs.map((t) => t.groupId));
  return {
    windowId: w.id,
    chromeWindowId: w.state === 'live' ? w.chromeWindowId! : null,
    tabs,
    groups: w.groups.filter((g) => used.has(g.id)),
  };
}

/**
 * The window goes live with the Chrome IDs Chrome created; tabs and groups it didn't
 * create stay hibernated. A window that was trashed moves to the bottom of the outline.
 */
export function attachOpened(o: Outline, windowId: string, opened: Opened, now: number): Outline {
  const w = o.windows.find((x) => x.id === windowId);
  if (!w) return o;
  const tabIds = new Map(opened.tabs.map((t) => [t.tabId, t.chromeTabId]));
  const groupIds = new Map(opened.groups.map((g) => [g.groupId, g.chromeGroupId]));

  const next: WindowRec = {
    ...w,
    tabs: w.tabs.map((t) => {
      const chromeTabId = tabIds.get(t.id);
      return chromeTabId === undefined ? t : { ...t, chromeTabId };
    }),
    groups: w.groups.map((g) => {
      const chromeGroupId = groupIds.get(g.id);
      return chromeGroupId === undefined ? g : { ...g, chromeGroupId };
    }),
  };
  if (w.state !== 'live') {
    next.state = 'live';
    next.chromeWindowId = opened.chromeWindowId;
    next.lastLiveAt = now;
    next.modifiedAt = now;
    delete next.closedAt;
    delete next.openAtShutdown;
  }

  const rest = o.windows.filter((x) => x !== w);
  if (w.state === 'trashed') return { windows: [...rest, next] };
  return { windows: o.windows.map((x) => (x === w ? next : x)) };
}
