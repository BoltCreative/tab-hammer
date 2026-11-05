import type { GroupColor } from '../types';

export type WindowState = 'live' | 'hibernated' | 'trashed';

export interface TabRec {
  id: string;
  chromeTabId?: number; // present = live
  url: string;
  title: string;
  launchUrl?: string; // address Chrome created/restored the tab with (live/provisional tabs)
  groupId?: string; // GroupRec.id in the same window
  liveAtClose?: boolean; // was live when its window last stopped being live (match scoring uses these)
  modifiedAt: number;
}

export interface GroupRec {
  id: string;
  chromeGroupId?: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  modifiedAt: number;
}

/** Where a Chrome window sat on screen, and whether it was maximized, fullscreen or minimized. */
export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  state: 'normal' | 'maximized' | 'fullscreen' | 'minimized';
}

export interface WindowRec {
  id: string;
  name?: string;
  state: WindowState;
  chromeWindowId?: number; // present iff state === 'live'
  closedAt?: number; // trashed only
  openAtShutdown?: boolean;
  provisional?: boolean; // live, unknown origin, not yet matched
  lastLiveAt: number;
  // Last known screen position (machine-local: never stamps modifiedAt, never exported). Kept
  // after the window closes, so reopening puts it back where it was.
  bounds?: WindowBounds;
  originInstallId: string; // install that created it (sync-readiness)
  modifiedAt: number;
  tabs: TabRec[];
  groups: GroupRec[];
}

/** Outline order, trashed windows included. */
export interface Outline {
  windows: WindowRec[];
}

export interface LiveTab {
  id: number;
  windowId: number;
  index: number;
  groupId: number; // -1 = ungrouped
  url: string;
  title: string;
  launchUrl?: string;
  active: boolean;
  discarded: boolean;
  lastAccessed?: number;
}

export interface LiveGroup {
  id: number;
  windowId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

/** Chrome's normal windows (Tab Hammer's popup excluded), their tabs (capture swap tab excluded), groups. */
export interface ChromeSnapshot {
  windowIds: number[];
  tabs: LiveTab[];
  groups: LiveGroup[];
  windowBounds?: Record<number, WindowBounds>; // by Chrome window ID
}

/** Chrome IDs the caller must close. */
export interface Effects {
  closeWindows: number[];
  closeTabs: number[];
}

export interface OpResult {
  outline: Outline;
  effects: Effects;
}

export const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const NO_EFFECTS: Effects = Object.freeze({
  closeWindows: Object.freeze([]) as unknown as number[],
  closeTabs: Object.freeze([]) as unknown as number[],
});
