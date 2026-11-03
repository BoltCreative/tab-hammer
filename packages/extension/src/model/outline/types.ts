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

export interface WindowRec {
  id: string;
  name?: string;
  state: WindowState;
  chromeWindowId?: number; // present iff state === 'live'
  closedAt?: number; // trashed only
  openAtShutdown?: boolean;
  provisional?: boolean; // live, unknown origin, not yet matched
  lastLiveAt: number;
  originInstallId: string; // install that created it (sync-readiness)
  modifiedAt: number;
  tabs: TabRec[];
  groups: GroupRec[];
}

/** Outline order, trashed windows included. */
export interface Outline {
  windows: WindowRec[];
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
