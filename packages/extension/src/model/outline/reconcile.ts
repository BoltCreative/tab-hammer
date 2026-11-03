// Keeps the outline in step with what Chrome has open. Pure: the caller passes
// a Chrome snapshot, the clock, the ID source, and this install's ID.

import { closeWindow } from './lifecycle';
import type { ChromeSnapshot, GroupRec, LiveTab, Outline, TabRec, WindowRec } from './types';

export interface ReconcileInput {
  snapshot: ChromeSnapshot;
  closingWindowIds: ReadonlySet<number>; // windows Chrome is closing (tabs.onRemoved isWindowClosing)
  now: number;
  newId: () => string;
  installId: string; // stamped as originInstallId on every new WindowRec
}

export interface ReconcileResult {
  outline: Outline;
  newProvisional: number[]; // Chrome window IDs
}

const isLive = (t: TabRec): boolean => t.chromeTabId !== undefined;

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameIds(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]!.id);
}

/**
 * `live` (records in their new order) plus the hibernated tabs of `old` (no chromeTabId, not in
 * `live`), each re-inserted right after its nearest preceding `old` neighbour that is in `live`
 * (start of the list if none); runs of hibernated tabs keep their order.
 */
export function mergeHibernated(old: TabRec[], live: TabRec[]): TabRec[] {
  const liveIds = new Set(live.map((t) => t.id));
  const after = new Map<string | null, TabRec[]>();
  let anchor: string | null = null;
  for (const t of old) {
    if (liveIds.has(t.id)) anchor = t.id;
    else if (!isLive(t)) {
      const run = after.get(anchor);
      if (run) run.push(t);
      else after.set(anchor, [t]);
    }
  }
  if (after.size === 0) return live;
  const out = [...(after.get(null) ?? [])];
  for (const t of live) out.push(t, ...(after.get(t.id) ?? []));
  return out;
}

export function reconcile(o: Outline, input: ReconcileInput): ReconcileResult {
  const { snapshot, closingWindowIds, now, newId, installId } = input;
  const present = new Set(snapshot.windowIds);
  const isClosing = (w: WindowRec): boolean =>
    closingWindowIds.has(w.chromeWindowId!) && present.has(w.chromeWindowId!);
  const liveWindows = o.windows.filter((w) => w.state === 'live');

  // Rule 1: index live records by Chrome ID across windows (a closing window keeps its own).
  const tabIndex = new Map<number, TabRec>();
  const tabHome = new Map<number, number>(); // chromeTabId -> Chrome window ID it was recorded in
  const groupIndex = new Map<number, GroupRec>();
  for (const w of liveWindows) {
    if (isClosing(w)) continue;
    for (const t of w.tabs) {
      if (t.chromeTabId === undefined) continue;
      tabIndex.set(t.chromeTabId, t);
      tabHome.set(t.chromeTabId, w.chromeWindowId!);
    }
    for (const g of w.groups) if (g.chromeGroupId !== undefined) groupIndex.set(g.chromeGroupId, g);
  }

  const tabsByWindow = new Map<number, LiveTab[]>();
  for (const t of snapshot.tabs) {
    const list = tabsByWindow.get(t.windowId);
    if (list) list.push(t);
    else tabsByWindow.set(t.windowId, [t]);
  }
  for (const list of tabsByWindow.values()) list.sort((a, b) => a.index - b.index);
  const snapshotTabIds = new Set(snapshot.tabs.map((t) => t.id));
  const liveGroups = new Map(snapshot.groups.map((g) => [g.id, g]));
  // Groups a tab reports but the group query missed (a race): leave them as they are this round.
  const racedGroups = new Set(
    snapshot.tabs.map((t) => t.groupId).filter((id) => id !== -1 && !liveGroups.has(id)),
  );

  // Records whose persisted fields changed this round; their window is stamped too.
  const stamped = new WeakSet<object>();

  const resolvedGroups = new Map<number, GroupRec>();
  function resolveGroup(chromeGroupId: number): GroupRec | undefined {
    const lg = liveGroups.get(chromeGroupId);
    if (!lg) return undefined;
    let rec = resolvedGroups.get(chromeGroupId);
    if (rec) return rec;
    const existing = groupIndex.get(chromeGroupId);
    if (!existing) {
      rec = {
        id: newId(),
        chromeGroupId,
        title: lg.title,
        color: lg.color,
        collapsed: lg.collapsed,
        modifiedAt: now,
      };
      stamped.add(rec);
    } else if (
      existing.title !== lg.title ||
      existing.color !== lg.color ||
      existing.collapsed !== lg.collapsed
    ) {
      rec = {
        ...existing,
        title: lg.title,
        color: lg.color,
        collapsed: lg.collapsed,
        modifiedAt: now,
      };
      stamped.add(rec);
    } else rec = existing;
    resolvedGroups.set(chromeGroupId, rec);
    return rec;
  }

  function resolveTab(lt: LiveTab): TabRec {
    const existing = tabIndex.get(lt.id);
    let groupId: string | undefined;
    if (racedGroups.has(lt.groupId)) {
      if (tabHome.get(lt.id) === lt.windowId) groupId = existing?.groupId;
    } else if (lt.groupId !== -1) groupId = resolveGroup(lt.groupId)?.id;
    if (!existing) {
      const rec: TabRec = {
        id: newId(),
        chromeTabId: lt.id,
        url: lt.url,
        title: lt.title,
        modifiedAt: now,
      };
      if (lt.launchUrl !== undefined) rec.launchUrl = lt.launchUrl;
      if (groupId !== undefined) rec.groupId = groupId;
      stamped.add(rec);
      return rec;
    }
    // A tab that hasn't loaded its saved address yet (a lazily reopened, discarded one) reports
    // an empty title or its url as the title, and maybe no url: the saved ones stay until it loads.
    const url = lt.url || existing.url;
    const unloaded = url === existing.url && (!lt.title || lt.title === lt.url);
    const title = unloaded ? existing.title : lt.title;
    const persisted =
      existing.url !== url || existing.title !== title || existing.groupId !== groupId;
    const fillLaunch = existing.launchUrl === undefined && lt.launchUrl !== undefined;
    if (!persisted && !fillLaunch) return existing;
    const rec: TabRec = { ...existing, url, title };
    if (groupId === undefined) delete rec.groupId;
    else rec.groupId = groupId;
    if (fillLaunch) rec.launchUrl = lt.launchUrl;
    if (persisted) {
      rec.modifiedAt = now;
      stamped.add(rec);
    }
    return rec;
  }

  /**
   * A window's existing groups, given where Chrome now has each one (`home` = this window's
   * Chrome ID, undefined once it's gone). A group Chrome moved elsewhere leaves this window;
   * if tabs in `remaining` still point at it, they move to a copy of it (without Chrome ID).
   * A group Chrome no longer has loses its Chrome ID.
   */
  function keepGroups(
    groups: GroupRec[],
    remaining: TabRec[],
    home: number | undefined,
  ): { groups: GroupRec[]; remap: Map<string, string> } {
    const kept: GroupRec[] = [];
    const remap = new Map<string, string>();
    for (const g of groups) {
      if (g.chromeGroupId === undefined) {
        kept.push(g);
        continue;
      }
      const lg = liveGroups.get(g.chromeGroupId);
      if (!lg && racedGroups.has(g.chromeGroupId)) {
        kept.push(g);
      } else if (!lg) {
        const next = { ...g };
        delete next.chromeGroupId;
        kept.push(next);
      } else if (lg.windowId === home) {
        kept.push(resolveGroup(lg.id) ?? g);
      } else if (remaining.some((t) => t.groupId === g.id)) {
        const copy: GroupRec = { ...g, id: newId(), modifiedAt: now };
        delete copy.chromeGroupId;
        stamped.add(copy);
        remap.set(g.id, copy.id);
        kept.push(copy);
      }
    }
    return { groups: kept, remap };
  }

  function remapTabs(tabs: TabRec[], remap: Map<string, string>): TabRec[] {
    if (remap.size === 0) return tabs;
    return tabs.map((t) => {
      const to = t.groupId === undefined ? undefined : remap.get(t.groupId);
      if (to === undefined) return t;
      const rec = { ...t, groupId: to, modifiedAt: now };
      stamped.add(rec);
      return rec;
    });
  }

  function referenced(groups: GroupRec[], tabs: TabRec[]): GroupRec[] {
    const used = new Set(tabs.map((t) => t.groupId));
    return groups.filter((g) => used.has(g.id));
  }

  /** Tabs and groups of the window Chrome has as `chromeWindowId`, merged with `old`'s. */
  function content(
    chromeWindowId: number,
    old: Pick<WindowRec, 'tabs' | 'groups'>,
  ): { tabs: TabRec[]; groups: GroupRec[] } {
    const live = tabsByWindow.get(chromeWindowId)!.map(resolveTab);
    const hibernated = old.tabs.filter((t) => !isLive(t));
    const { groups: kept, remap } = keepGroups(old.groups, hibernated, chromeWindowId);
    const tabs = mergeHibernated(remapTabs(old.tabs, remap), live);
    const keptIds = new Set(kept.map((g) => g.id));
    const added = [...resolvedGroups.values()].filter(
      (g) => !keptIds.has(g.id) && live.some((t) => t.groupId === g.id),
    );
    return { tabs, groups: referenced([...kept, ...added], tabs) };
  }

  function stampIfChanged(w: WindowRec, tabs: TabRec[], groups: GroupRec[]): WindowRec {
    if (sameList(tabs, w.tabs) && sameList(groups, w.groups)) return w;
    const persisted =
      !sameIds(tabs, w.tabs) ||
      !sameIds(groups, w.groups) ||
      tabs.some((t) => stamped.has(t)) ||
      groups.some((g) => stamped.has(g));
    return { ...w, tabs, groups, ...(persisted ? { modifiedAt: now } : {}) };
  }

  /** Rule 2: Chrome closed the window without us seeing it. Tabs and groups it no longer owns go. */
  /** `w` without the tabs and groups Chrome now has in other windows (`home` = w's Chrome ID if it's still open). */
  function withoutMoved(w: WindowRec, home: number | undefined): WindowRec {
    const tabs = w.tabs.filter(
      (t) => t.chromeTabId === undefined || !snapshotTabIds.has(t.chromeTabId),
    );
    const { groups: kept, remap } = keepGroups(w.groups, tabs, home);
    const remapped = remapTabs(tabs, remap);
    return stampIfChanged(w, remapped, referenced(kept, remapped));
  }

  /** Rule 2: Chrome closed the window without us seeing it. */
  function missedClose(w: WindowRec): WindowRec | undefined {
    const rest = withoutMoved(w, undefined);
    if (rest.tabs.length === 0) return undefined; // every tab moved to another window
    return closeWindow({ windows: [rest] }, rest.id, now).windows[0];
  }

  let changed = false;
  const windows: WindowRec[] = [];
  const known = new Set<number>();
  for (const w of o.windows) {
    let next: WindowRec | undefined = w;
    if (w.state === 'live') {
      const chromeId = w.chromeWindowId!;
      known.add(chromeId);
      if (!present.has(chromeId)) next = missedClose(w);
      else if (!isClosing(w) && tabsByWindow.has(chromeId)) {
        const { tabs, groups } = content(chromeId, w);
        next = stampIfChanged(w, tabs, groups);
      } else if (!isClosing(w)) {
        // Rule 3: no tabs this round (e.g. its last tab just moved out); keep the rest.
        next = withoutMoved(w, chromeId);
      }
    }
    if (next !== w) changed = true;
    if (next) windows.push(next);
  }

  const newProvisional: number[] = [];
  for (const chromeId of snapshot.windowIds) {
    if (known.has(chromeId) || !tabsByWindow.has(chromeId)) continue;
    const draggedOut = tabsByWindow.get(chromeId)!.some((t) => tabIndex.has(t.id));
    const { tabs, groups } = content(chromeId, { tabs: [], groups: [] });
    const rec: WindowRec = {
      id: newId(),
      state: 'live',
      chromeWindowId: chromeId,
      lastLiveAt: now,
      originInstallId: installId,
      modifiedAt: now,
      tabs,
      groups,
    };
    if (!draggedOut) {
      rec.provisional = true;
      newProvisional.push(chromeId);
    }
    windows.push(rec);
    changed = true;
  }

  return { outline: changed ? { windows } : o, newProvisional };
}

/** Chrome swapped a tab's ID (prerender or discard): the record keeps its place. */
export function replaceTabId(o: Outline, addedTabId: number, removedTabId: number): Outline {
  let changed = false;
  const windows = o.windows.map((w) => {
    const i = w.tabs.findIndex((t) => t.chromeTabId === removedTabId);
    if (i === -1) return w;
    changed = true;
    const tabs = [...w.tabs];
    tabs[i] = { ...tabs[i]!, chromeTabId: addedTabId };
    return { ...w, tabs };
  });
  return changed ? { windows } : o;
}
