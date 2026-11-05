// The picker's list of other devices: Tab Hammer computers (from their Drive files) and Chrome Sync
// devices (from chrome.sessions). Pure.
import type { SyncWindow } from './export';

/** What chrome.sessions.getDevices() reports, as far as the picker needs it. */
export interface SessionTabLike {
  sessionId?: string;
  url?: string;
  title?: string;
}
export interface SessionLike {
  lastModified: number; // seconds since epoch
  window?: { sessionId?: string; tabs?: SessionTabLike[] };
  tab?: SessionTabLike;
}
export interface SessionDeviceLike {
  deviceName: string;
  sessions: SessionLike[];
}

export interface ComputerEntry {
  installId: string;
  name: string;
  updatedAt: number; // when that computer last wrote its file (0 if unreadable)
  windowCount: number;
  tabCount: number;
  problem?: 'newer' | 'malformed'; // its file can't be shown
}

export interface DeviceEntry {
  name: string;
  updatedAt: number; // ms, its newest session
  windowCount: number;
  tabCount: number;
}

/** Row IDs of a Chrome Sync device's windows and tabs carry the session ID chrome.sessions restores. */
export const SESSION_ROW_PREFIX = 'session:';

export const sessionIdOfRow = (rowId: string): string | undefined =>
  rowId.startsWith(SESSION_ROW_PREFIX) ? rowId.slice(SESSION_ROW_PREFIX.length) : undefined;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Other Tab Hammer computers, newest first, and Chrome Sync devices, newest first, minus any named
 * like this computer or a Tab Hammer computer (the same machine: its Tab Hammer outline is fuller).
 */
export function assembleDevices(
  selfName: string,
  computers: ComputerEntry[],
  devices: SessionDeviceLike[],
): { computers: ComputerEntry[]; devices: DeviceEntry[] } {
  const names = [selfName, ...computers.map((c) => c.name)];
  return {
    computers: [...computers].sort((a, b) => b.updatedAt - a.updatedAt),
    devices: devices
      .filter((d) => !names.some((n) => sameName(n, d.deviceName)))
      .map((d) => {
        const windows = sessionWindows(d);
        return {
          name: d.deviceName,
          updatedAt: Math.max(0, ...d.sessions.map((s) => s.lastModified * 1000)),
          windowCount: windows.length,
          tabCount: windows.reduce((n, w) => n + w.tabs.length, 0),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

/**
 * A Chrome Sync device's sessions as read-only live windows (no groups: chrome.sessions doesn't
 * report them). A session that is a lone tab becomes a window of its own.
 */
export function sessionWindows(d: SessionDeviceLike): SyncWindow[] {
  const out: SyncWindow[] = [];
  d.sessions.forEach((s, i) => {
    const at = s.lastModified * 1000;
    const tabs = (s.window?.tabs ?? (s.tab ? [s.tab] : [])).filter((t) => t.url);
    if (tabs.length === 0) return;
    const sid = s.window?.sessionId ?? s.tab?.sessionId;
    out.push({
      id: sid !== undefined ? SESSION_ROW_PREFIX + sid : `device-window-${i}`,
      state: 'live',
      lastLiveAt: at,
      originInstallId: '',
      modifiedAt: at,
      tabs: tabs.map((t, j) => ({
        id: t.sessionId !== undefined ? SESSION_ROW_PREFIX + t.sessionId : `device-tab-${i}-${j}`,
        url: t.url!,
        title: t.title || t.url!,
        modifiedAt: at,
      })),
      groups: [],
    });
  });
  return out;
}
