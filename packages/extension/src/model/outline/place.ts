// Moves tab records to a new position in the outline (drag and drop). Pure: Chrome
// moves the live tabs itself; this places the records and says what Chrome must close
// or group. The caller passes the clock and the ID source.

import { clearShutdown, detach, findRow, syncGroups } from './lifecycle';
import type { Effects, GroupRec, Outline, TabRec, WindowRec } from './types';
import { NO_EFFECTS } from './types';

export interface Placement {
  windowId: string; // target window record
  beforeTabId: string | null; // insert before this (non-moved) tab record; null = window end
  tabs: { id: string; groupId: string | null }[]; // moved tab records in final order
}

export interface PlaceResult {
  outline: Outline;
  effects: Effects; // live tabs dropped into a hibernated window are closed
  regroup: { groupId: string; chromeWindowId: number; chromeTabIds: number[] }[];
}

const isLive = (t: TabRec): boolean => t.chromeTabId !== undefined;

function withoutChromeGroup(g: GroupRec): GroupRec {
  const next = { ...g };
  delete next.chromeGroupId;
  return next;
}

export function placeTabs(o: Outline, p: Placement, now: number, newId: () => string): PlaceResult {
  const unchanged: PlaceResult = { outline: o, effects: NO_EFFECTS, regroup: [] };
  const target = o.windows.find((w) => w.id === p.windowId);
  if (!target || target.state === 'trashed') return unchanged;
  const targetLive = target.state === 'live';

  const home = new Map<string, WindowRec>(); // moved tab id -> its source window
  const moved: { rec: TabRec; groupId: string | null }[] = [];
  for (const m of p.tabs) {
    const row = findRow(o, m.id);
    if (!row?.tab || row.window.state === 'trashed' || home.has(m.id)) continue;
    home.set(m.id, row.window);
    moved.push({ rec: row.tab, groupId: m.groupId });
  }
  if (moved.length === 0) return unchanged;
  const touched = new Set<WindowRec>([target, ...home.values()]);

  // Each requested group resolves to a record in the target window. One from another
  // window moves if no tab left there uses it, else it's copied under a new ID. Either
  // way it loses its Chrome ID: that belongs to a group in the other Chrome window.
  const groupMap = new Map<string, string>(); // requested id -> id in the target
  const arriving: GroupRec[] = [];
  const leaving = new Set<string>();
  for (const gid of new Set(moved.map((m) => m.groupId))) {
    if (gid === null) continue;
    if (target.groups.some((g) => g.id === gid)) {
      groupMap.set(gid, gid);
      continue;
    }
    const row = findRow(o, gid);
    if (!row?.group || row.window.state === 'trashed') continue; // unknown: ungrouped
    const inUse = row.window.tabs.some((t) => !home.has(t.id) && t.groupId === gid);
    if (inUse) {
      const copy: GroupRec = { ...withoutChromeGroup(row.group), id: newId(), modifiedAt: now };
      arriving.push(copy);
      groupMap.set(gid, copy.id);
    } else {
      arriving.push(withoutChromeGroup(row.group));
      leaving.add(gid);
      groupMap.set(gid, gid);
      touched.add(row.window);
    }
  }

  // Chrome owns live tabs' groups: a live tab keeps its group only within its own window.
  const effects: Effects = { closeWindows: [], closeTabs: [] };
  const placed = moved.map(({ rec, groupId }): TabRec => {
    let t = rec;
    if (!targetLive && isLive(t)) {
      effects.closeTabs.push(t.chromeTabId!);
      t = { ...t };
      delete t.chromeTabId;
    }
    const want = isLive(t)
      ? home.get(rec.id) === target
        ? t.groupId
        : undefined
      : groupId === null
        ? undefined
        : groupMap.get(groupId);
    if (want === t.groupId) return t;
    const next: TabRec = { ...t, modifiedAt: now };
    if (want === undefined) delete next.groupId;
    else next.groupId = want;
    return next;
  });

  const regroup: PlaceResult['regroup'] = [];
  if (targetLive) {
    for (const [requested, gid] of groupMap) {
      const rec = [...target.groups, ...arriving].find((g) => g.id === gid)!;
      if (rec.chromeGroupId !== undefined) continue;
      const chromeTabIds = placed
        .filter((t, i) => isLive(t) && moved[i]!.groupId === requested)
        .map((t) => t.chromeTabId!);
      if (chromeTabIds.length > 0) {
        regroup.push({ groupId: gid, chromeWindowId: target.chromeWindowId!, chromeTabIds });
      }
    }
  }

  const windows: WindowRec[] = [];
  for (const w of o.windows) {
    if (!touched.has(w)) {
      windows.push(w);
      continue;
    }
    let tabs = w.tabs.filter((t) => !home.has(t.id));
    let groups = w.groups.filter((g) => !leaving.has(g.id));
    const used = new Set<string | undefined>();
    if (w === target) {
      const at = p.beforeTabId === null ? -1 : tabs.findIndex((t) => t.id === p.beforeTabId);
      tabs =
        at === -1 ? [...tabs, ...placed] : [...tabs.slice(0, at), ...placed, ...tabs.slice(at)];
      groups = [...groups, ...arriving];
      for (const r of regroup) used.add(r.groupId);
    }
    for (const t of tabs) used.add(t.groupId);
    let next: WindowRec = {
      ...w,
      tabs,
      groups: groups.filter((g) => used.has(g.id)),
      modifiedAt: now,
    };
    if (w !== target && w.state === 'live') {
      if (!tabs.some(isLive)) {
        // Chrome closes the window with its last tab.
        if (tabs.length === 0) continue;
        next = { ...clearShutdown(detach(next, now)), state: 'hibernated' };
      } else next = syncGroups(next);
    } else if (w.state === 'hibernated' && tabs.length === 0) continue;
    windows.push(next);
  }

  return { outline: { windows }, effects, regroup };
}

export function attachGroup(o: Outline, groupId: string, chromeGroupId: number): Outline {
  const row = findRow(o, groupId);
  if (!row?.group || row.group.chromeGroupId === chromeGroupId) return o;
  const w = row.window;
  const next: WindowRec = {
    ...w,
    groups: w.groups.map((g) => (g.id === groupId ? { ...g, chromeGroupId } : g)),
  };
  return { windows: o.windows.map((x) => (x === w ? next : x)) };
}
