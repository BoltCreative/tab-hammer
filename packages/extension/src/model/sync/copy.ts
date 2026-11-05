// "Open here": a copy of another outline's window, group, or tab, as a new hibernated window of
// this computer's, ready to be opened like any hibernated window. Pure.
import type { GroupRec, TabRec, WindowRec } from '../outline/types';
import type { SyncWindow } from './export';

export interface CopyOptions {
  now: number;
  newId: () => string;
  installId: string;
}

/**
 * A new window record with fresh IDs holding `rowId`'s tabs: the whole window (its name kept), one
 * group's tabs, or one tab (in its group, if it has one). Null if `rowId` isn't in `w`.
 */
export function copyForOpen(
  w: SyncWindow,
  rowId: string,
  { now, newId, installId }: CopyOptions,
): WindowRec | null {
  const whole = rowId === w.id;
  const picked = whole
    ? w.tabs
    : w.groups.some((g) => g.id === rowId)
      ? w.tabs.filter((t) => t.groupId === rowId)
      : w.tabs.filter((t) => t.id === rowId);
  if (picked.length === 0) return null;
  const used = new Set(picked.map((t) => t.groupId));
  const groupIds = new Map<string, string>();
  const groups: GroupRec[] = w.groups
    .filter((g) => used.has(g.id))
    .map((g) => {
      const id = newId();
      groupIds.set(g.id, id);
      return { ...g, id, modifiedAt: now };
    });
  const tabs: TabRec[] = picked.map((t) => {
    const tab: TabRec = { id: newId(), url: t.url, title: t.title, modifiedAt: now };
    const g = t.groupId === undefined ? undefined : groupIds.get(t.groupId);
    if (g !== undefined) tab.groupId = g;
    return tab;
  });
  const rec: WindowRec = {
    id: newId(),
    state: 'hibernated',
    lastLiveAt: now,
    originInstallId: installId,
    modifiedAt: now,
    tabs,
    groups,
  };
  if (whole && w.name !== undefined) rec.name = w.name;
  return rec;
}
