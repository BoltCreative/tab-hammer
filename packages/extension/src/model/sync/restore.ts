// Bringing windows from a sync file (another computer's, a checkpoint, or this computer's own after
// its local data was wiped) into this computer's outline. Pure: the caller passes the clock and the
// ID source. It only ever adds, or takes a window out of this computer's trash: records already in
// the outline are otherwise never touched.
import { matchRestored } from '../outline/applyMatch';
import { untrash } from '../outline/lifecycle';
import type { GroupRec, Outline, TabRec, WindowRec } from '../outline/types';
import type { SyncGroup, SyncTab, SyncWindow } from './export';

export interface RestoreOptions {
  now: number;
  newId: () => string;
  // Self-restore keeps the file's trash as trash; Restore all leaves other outlines' trash out.
  keepTrash: boolean;
  // Self-restore: windows that were live in the file come in as re-link candidates (open at
  // shutdown, their tabs live at close), so the windows Chrome has open link back to them.
  relink?: boolean;
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

/** What a restore did: the windows it appended, and the ones it took out of this computer's trash. */
export interface RestoreResult {
  outline: Outline;
  added: string[];
  untrashed: string[];
}

/**
 * Every window of `windows` whose ID isn't in `o` is appended, hibernated (or, with `keepTrash`,
 * trashed ones stay trashed). A window the file has open (live or hibernated) that `o` holds in its
 * trash comes back out of the trash, hibernated, keeping this computer's record. A tab or group
 * whose ID is already taken (it was moved to another window since) gets a fresh ID. Windows without
 * tabs are skipped.
 */
export function restoreWindows(
  o: Outline,
  windows: SyncWindow[],
  { now, newId, keepTrash, relink = false }: RestoreOptions,
): RestoreResult {
  const taken = outlineIds(o);
  const localTrash = new Set(o.windows.filter((w) => w.state === 'trashed').map((w) => w.id));
  const untrashed: string[] = [];
  const fresh = (id: string): string => {
    const next = taken.has(id) ? newId() : id;
    taken.add(next);
    return next;
  };
  const added: WindowRec[] = [];
  for (const w of windows) {
    const trashed = w.state === 'trashed';
    if (localTrash.has(w.id) && !trashed) {
      localTrash.delete(w.id);
      untrashed.push(w.id);
      continue;
    }
    if (taken.has(w.id) || w.tabs.length === 0) continue;
    if (trashed && !keepTrash) continue;
    taken.add(w.id);
    const groupIds = new Map<string, string>();
    const groups: GroupRec[] = w.groups.map((g: SyncGroup) => {
      const id = fresh(g.id);
      groupIds.set(g.id, id);
      return { ...g, id };
    });
    const wasLive = relink && w.state === 'live';
    const tabs: TabRec[] = w.tabs.map((t: SyncTab) => {
      const tab: TabRec = { ...t, id: fresh(t.id) };
      if (wasLive) tab.liveAtClose = true;
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
    if (wasLive) rec.openAtShutdown = true;
    added.push(rec);
  }
  const base = untrashed.length === 0 ? o : untrash(o, untrashed, now);
  if (added.length === 0) return { outline: base, added: [], untrashed };
  return {
    outline: { windows: [...base.windows, ...added] },
    added: added.map((w) => w.id),
    untrashed,
  };
}

/**
 * Self-restore of a computer whose outline database was wiped: brings in its own file's windows
 * (trash kept), then re-links the windows Chrome has open now to the ones that were live in the
 * file, exactly as after a browser restart, so they don't show twice. Windows that were hibernated
 * in the file are never re-linked; restored live windows nothing matches stay hibernated.
 */
export function selfRestoreWindows(
  o: Outline,
  windows: SyncWindow[],
  { now, newId }: Pick<RestoreOptions, 'now' | 'newId'>,
): RestoreResult {
  const r = restoreWindows(o, windows, { now, newId, keepTrash: true, relink: true });
  if (r.added.length === 0) return r;
  const live = r.outline.windows.filter((w) => w.state === 'live').map((w) => w.id);
  return { ...r, outline: matchRestored(r.outline, live, now) };
}
