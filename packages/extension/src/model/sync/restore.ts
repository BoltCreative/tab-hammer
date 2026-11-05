// Bringing windows from a sync file (another computer's, a checkpoint, or this computer's own after
// its local data was wiped) into this computer's outline. Pure: the caller passes the clock and the
// ID source. It only ever adds: records already in the outline are never touched.
import type { GroupRec, Outline, TabRec, WindowRec } from '../outline/types';
import type { SyncGroup, SyncTab, SyncWindow } from './export';

export interface RestoreOptions {
  now: number;
  newId: () => string;
  // Self-restore keeps the file's trash as trash; Restore all leaves other outlines' trash out.
  keepTrash: boolean;
}

function outlineIds(o: Outline): Set<string> {
  const ids = new Set<string>();
  for (const w of o.windows) {
    ids.add(w.id);
    for (const t of w.tabs) ids.add(t.id);
    for (const g of w.groups) ids.add(g.id);
  }
  return ids;
}

/**
 * Every window of `windows` whose ID isn't in `o` is appended, hibernated (or, with `keepTrash`,
 * trashed ones stay trashed). A tab or group whose ID is already taken (it was moved to another
 * window since) gets a fresh ID. Windows without tabs are skipped. Returns the added window IDs.
 */
export function restoreWindows(
  o: Outline,
  windows: SyncWindow[],
  { now, newId, keepTrash }: RestoreOptions,
): { outline: Outline; added: string[] } {
  const taken = outlineIds(o);
  const fresh = (id: string): string => {
    const next = taken.has(id) ? newId() : id;
    taken.add(next);
    return next;
  };
  const added: WindowRec[] = [];
  for (const w of windows) {
    if (taken.has(w.id) || w.tabs.length === 0) continue;
    const trashed = w.state === 'trashed';
    if (trashed && !keepTrash) continue;
    taken.add(w.id);
    const groupIds = new Map<string, string>();
    const groups: GroupRec[] = w.groups.map((g: SyncGroup) => {
      const id = fresh(g.id);
      groupIds.set(g.id, id);
      return { ...g, id };
    });
    const tabs: TabRec[] = w.tabs.map((t: SyncTab) => {
      const tab: TabRec = { ...t, id: fresh(t.id) };
      if (t.groupId !== undefined) {
        const g = groupIds.get(t.groupId);
        if (g === undefined) delete tab.groupId;
        else tab.groupId = g;
      }
      return tab;
    });
    const rec: WindowRec = {
      ...w,
      state: trashed ? 'trashed' : 'hibernated',
      modifiedAt: now,
      tabs,
      groups,
    };
    if (trashed) rec.closedAt = w.closedAt ?? now;
    else delete rec.closedAt;
    added.push(rec);
  }
  if (added.length === 0) return { outline: o, added: [] };
  return { outline: { windows: [...o.windows, ...added] }, added: added.map((w) => w.id) };
}
