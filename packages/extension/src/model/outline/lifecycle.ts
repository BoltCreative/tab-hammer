import {
  NO_EFFECTS,
  TRASH_TTL_MS,
  type Effects,
  type GroupRec,
  type OpResult,
  type Outline,
  type TabRec,
  type WindowRec,
} from './types';

export function findRow(
  o: Outline,
  id: string,
): { window: WindowRec; tab?: TabRec; group?: GroupRec } | undefined {
  for (const window of o.windows) {
    if (window.id === id) return { window };
    const tab = window.tabs.find((t) => t.id === id);
    if (tab) return { window, tab };
    const group = window.groups.find((g) => g.id === id);
    if (group) return { window, group };
  }
  return undefined;
}

const isLive = (t: TabRec): boolean => t.chromeTabId !== undefined;

function stripTab(t: TabRec): TabRec {
  const next = { ...t };
  delete next.chromeTabId;
  return next;
}

/** Groups with no live tab left lose their Chrome ID. */
export function syncGroups(w: WindowRec): WindowRec {
  const liveGroups = new Set(w.tabs.filter(isLive).map((t) => t.groupId));
  if (w.groups.every((g) => g.chromeGroupId === undefined || liveGroups.has(g.id))) return w;
  return {
    ...w,
    groups: w.groups.map((g) => {
      if (g.chromeGroupId === undefined || liveGroups.has(g.id)) return g;
      const next = { ...g };
      delete next.chromeGroupId;
      return next;
    }),
  };
}

/**
 * The window stops being live: Chrome IDs go, each tab remembers whether it was
 * live, and the caller picks the new state. Clears `provisional`.
 */
export function detach(w: WindowRec, now: number): WindowRec {
  const next: WindowRec = {
    ...w,
    lastLiveAt: now,
    modifiedAt: now,
    tabs: w.tabs.map((t) => ({ ...stripTab(t), liveAtClose: isLive(t) })),
    groups: w.groups.map((g) => {
      const gn = { ...g };
      delete gn.chromeGroupId;
      return gn;
    }),
  };
  delete next.chromeWindowId;
  delete next.provisional;
  return next;
}

/**
 * Closed by hand in Chrome: trashed, hibernated tabs included. Each tab keeps whether it was live
 * (`liveAtClose`), so restoring it reopens the live ones and leaves the rest hibernated.
 */
function closed(w: WindowRec, now: number): WindowRec {
  return { ...detach(w, now), state: 'trashed', closedAt: now };
}

export function clearShutdown(w: WindowRec): WindowRec {
  if (w.openAtShutdown === undefined) return w;
  const next = { ...w };
  delete next.openAtShutdown;
  return next;
}

function mapWindows(o: Outline, fn: (w: WindowRec) => WindowRec | undefined): Outline {
  let changed = false;
  const windows: WindowRec[] = [];
  for (const w of o.windows) {
    const next = fn(w);
    if (next !== w) changed = true;
    if (next) windows.push(next);
  }
  return changed ? { windows } : o;
}

export function closeWindow(o: Outline, windowId: string, now: number): Outline {
  return mapWindows(o, (w) => (w.id === windowId && w.state === 'live' ? closed(w, now) : w));
}

export function hibernate(o: Outline, ids: string[], now: number): OpResult {
  const selected = new Set(ids);
  const effects: Effects = { closeWindows: [], closeTabs: [] };
  const outline = mapWindows(o, (w) => {
    if (w.state !== 'live') return w;
    if (selected.has(w.id)) {
      effects.closeWindows.push(w.chromeWindowId!);
      return { ...clearShutdown(detach(w, now)), state: 'hibernated' };
    }
    const hib = new Set(
      w.tabs
        .filter((t) => isLive(t) && (selected.has(t.id) || (t.groupId && selected.has(t.groupId))))
        .map((t) => t.id),
    );
    if (hib.size === 0) return w;
    for (const t of w.tabs) if (hib.has(t.id)) effects.closeTabs.push(t.chromeTabId!);
    if (w.tabs.every((t) => !isLive(t) || hib.has(t.id))) {
      // Chrome closes the window with its last tab.
      return { ...clearShutdown(detach(w, now)), state: 'hibernated' };
    }
    return clearShutdown(
      syncGroups({ ...w, tabs: w.tabs.map((t) => (hib.has(t.id) ? stripTab(t) : t)) }),
    );
  });
  return { outline, effects: outline === o ? NO_EFFECTS : effects };
}

export function trash(o: Outline, ids: string[], now: number): OpResult {
  const selected = new Set(ids);
  const effects: Effects = { closeWindows: [], closeTabs: [] };
  const outline = mapWindows(o, (w) => {
    if (w.state === 'trashed') return w;
    if (selected.has(w.id)) {
      if (w.state === 'live') {
        effects.closeWindows.push(w.chromeWindowId!);
        return { ...clearShutdown(detach(w, now)), state: 'trashed', closedAt: now };
      }
      return {
        ...clearShutdown(w),
        state: 'trashed',
        closedAt: now,
        modifiedAt: now,
        hibernatedAtClose: true,
      };
    }
    const removed = new Set(
      w.tabs
        .filter((t) => selected.has(t.id) || (t.groupId && selected.has(t.groupId)))
        .map((t) => t.id),
    );
    const groupsGone = w.groups.filter((g) => selected.has(g.id));
    if (removed.size === 0 && groupsGone.length === 0) return w;
    for (const t of w.tabs)
      if (removed.has(t.id) && isLive(t)) effects.closeTabs.push(t.chromeTabId!);

    const tabs = w.tabs.filter((t) => !removed.has(t.id));
    const hadLive = w.tabs.some(isLive);
    if (w.state === 'hibernated' && tabs.length === 0) return undefined;
    if (w.state === 'live' && hadLive && !tabs.some(isLive)) {
      // Chrome closes the window with its last tab.
      if (tabs.some((t) => !isLive(t))) {
        const rest = { ...w, tabs, groups: w.groups.filter((g) => !selected.has(g.id)) };
        return { ...clearShutdown(detach(rest, now)), state: 'hibernated' };
      }
      return { ...clearShutdown(detach(w, now)), state: 'trashed', closedAt: now };
    }
    return clearShutdown(
      syncGroups({
        ...w,
        tabs,
        groups: w.groups.filter((g) => !selected.has(g.id)),
        modifiedAt: now,
      }),
    );
  });
  return { outline, effects: outline === o ? NO_EFFECTS : effects };
}

export function renameWindow(o: Outline, windowId: string, name: string, now: number): Outline {
  const trimmed = name.trim() || undefined;
  return mapWindows(o, (w) => {
    if (w.id !== windowId) return w;
    const cleared = clearShutdown(w);
    if (cleared.name === trimmed) return cleared;
    const next = { ...cleared, modifiedAt: now };
    if (trimmed === undefined) delete next.name;
    else next.name = trimmed;
    return next;
  });
}

export function deleteWindow(o: Outline, windowId: string): Outline {
  return mapWindows(o, (w) => (w.id === windowId ? undefined : w));
}

/**
 * Takes the given trashed windows out of the trash, hibernated, where they sit in the outline.
 * Nothing opens in Chrome. Other windows, and IDs that aren't trashed windows, are left alone.
 */
export function untrash(o: Outline, ids: string[], now: number): Outline {
  const selected = new Set(ids);
  return mapWindows(o, (w) => {
    if (w.state !== 'trashed' || !selected.has(w.id)) return w;
    const next: WindowRec = { ...w, state: 'hibernated', modifiedAt: now };
    delete next.closedAt;
    delete next.hibernatedAtClose;
    return next;
  });
}

export function expireTrash(o: Outline, now: number): Outline {
  return mapWindows(o, (w) =>
    w.state === 'trashed' && w.closedAt !== undefined && now - w.closedAt > TRASH_TTL_MS
      ? undefined
      : w,
  );
}

/**
 * Fresh browser launch: every live window stops being live and is kept hibernated, remembered as
 * open at shutdown. Never trashed: the browser quitting, crashing, or being killed isn't the user
 * closing a window, and Chrome may not restore any of them (no "Continue where you left off", or a
 * declined "Restore pages?"). Each one Chrome does restore is re-linked to its row (applyMatch).
 */
export function startFresh(o: Outline, now: number): Outline {
  return mapWindows(o, (w) =>
    w.state === 'live' ? { ...detach(w, now), state: 'hibernated', openAtShutdown: true } : w,
  );
}
