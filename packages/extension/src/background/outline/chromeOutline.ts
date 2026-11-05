// Reads what Chrome has open into the pure model's ChromeSnapshot, and the live-only details the
// view renders alongside the outline; carries out the Chrome side of outline commands.
import type { OpenPlan, Opened } from '../../model/outline/open';
import type {
  ChromeSnapshot,
  Effects,
  GroupRec,
  LiveGroup,
  WindowBounds,
} from '../../model/outline/types';
import type { GroupColor } from '../../model/types';
import { SWAP_KEY, hiddenBySwap, isSwapRecord } from '../../shared/captureSwap';
import type { LiveDetails } from '../../shared/outlineMessages';

/**
 * Chrome's normal windows (which leaves out Tab Hammer's own popup window and devtools windows),
 * their tabs minus a preview capture's temporary swap tab, and their groups. `launchUrls` holds
 * the address each tab was created or first committed with.
 */
export async function readSnapshot(
  launchUrls: ReadonlyMap<number, string>,
): Promise<ChromeSnapshot> {
  const [windows, tabs, groups, stored] = await Promise.all([
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.storage.local.get(SWAP_KEY).catch(() => ({}) as Record<string, unknown>),
  ]);
  const swap = isSwapRecord(stored[SWAP_KEY]) ? stored[SWAP_KEY] : undefined;
  const now = Date.now();
  const windowIds = windows.flatMap((w) => (w.id === undefined ? [] : [w.id]));
  const normal = new Set(windowIds);
  const windowBounds: Record<number, WindowBounds> = {};
  for (const w of windows) {
    const { id, left, top, width, height, state } = w;
    if (id === undefined || left === undefined || top === undefined) continue;
    if (width === undefined || height === undefined) continue;
    const s = state === 'maximized' || state === 'fullscreen' || state === 'minimized';
    windowBounds[id] = { left, top, width, height, state: s ? state : 'normal' };
  }
  return {
    windowIds,
    windowBounds,
    tabs: tabs.flatMap((t) => {
      if (t.id === undefined || !normal.has(t.windowId)) return [];
      if (hiddenBySwap(swap, { id: t.id, windowId: t.windowId }, now)) return [];
      const launchUrl = launchUrls.get(t.id);
      return [
        {
          id: t.id,
          windowId: t.windowId,
          index: t.index,
          groupId: t.groupId,
          url: t.url || t.pendingUrl || '',
          title: t.title ?? '',
          ...(launchUrl !== undefined && { launchUrl }),
          active: t.active,
          discarded: t.discarded,
          ...(t.lastAccessed !== undefined && { lastAccessed: t.lastAccessed }),
        },
      ];
    }),
    groups: groups.flatMap((g): LiveGroup[] =>
      normal.has(g.windowId)
        ? [
            {
              id: g.id,
              windowId: g.windowId,
              title: g.title ?? '',
              color: g.color as GroupColor,
              collapsed: g.collapsed,
            },
          ]
        : [],
    ),
  };
}

export function liveDetails(snapshot: ChromeSnapshot, focusedWindowId: number | null): LiveDetails {
  const tabs: LiveDetails['tabs'] = {};
  for (const t of snapshot.tabs) {
    tabs[t.id] = {
      active: t.active,
      discarded: t.discarded,
      ...(t.lastAccessed !== undefined && { lastAccessed: t.lastAccessed }),
    };
  }
  return { tabs, focusedWindowId };
}

/**
 * Closes what a model op says to close, and hands back what Chrome refused to close: already
 * gone, or a page cancelled the close.
 */
export async function runEffects(e: Effects): Promise<Effects> {
  const failed: Effects = { closeWindows: [], closeTabs: [] };
  await Promise.all([
    ...e.closeWindows.map((id) =>
      chrome.windows.remove(id).catch(() => void failed.closeWindows.push(id)),
    ),
    ...(e.closeTabs.length > 0
      ? [chrome.tabs.remove(e.closeTabs).catch(() => void failed.closeTabs.push(...e.closeTabs))]
      : []),
  ]);
  return failed;
}

/** A new Chrome group in `chromeWindowId` holding `chromeTabIds`, styled like `group`. */
export async function createGroup(
  chromeWindowId: number,
  chromeTabIds: [number, ...number[]],
  group: GroupRec,
): Promise<number> {
  const id = await chrome.tabs.group({
    tabIds: chromeTabIds,
    createProperties: { windowId: chromeWindowId },
  });
  await chrome.tabGroups.update(id, {
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
  });
  return id;
}

/**
 * Where a reopened window goes. Chrome won't take a maximized or fullscreen state together with
 * bounds, so those reopen in that state on Chrome's choice of screen; a minimized one reopens as a
 * normal window where it was.
 */
function placement(b: WindowBounds | undefined): Partial<chrome.windows.CreateData> | undefined {
  if (b === undefined) return undefined;
  if (b.state === 'maximized' || b.state === 'fullscreen') return { state: b.state };
  return { left: b.left, top: b.top, width: b.width, height: b.height };
}

/**
 * Opens `plan`'s tabs in Chrome, in order, then their groups. A tab Chrome refuses is skipped (its
 * record stays hibernated) and the tabs after it shift left by one. Every tab loads right away.
 * Throws only if a new window can't be created.
 */
export async function openPlanned(plan: OpenPlan): Promise<Opened> {
  const created: { tabId: string; chromeTabId: number; groupId?: string }[] = [];
  let pending = plan.tabs;
  let chromeWindowId = plan.chromeWindowId;
  if (chromeWindowId === null) {
    const [first, ...rest] = plan.tabs;
    const base: chrome.windows.CreateData = { url: first!.url, focused: true };
    const placed = placement(plan.bounds);
    // Bounds Chrome rejects (off every screen since a monitor change, say) don't stop the open.
    const w = placed
      ? await chrome.windows.create({ ...base, ...placed }).catch(() => chrome.windows.create(base))
      : await chrome.windows.create(base);
    const firstTabId = w?.tabs?.[0]?.id;
    if (w?.id === undefined || firstTabId === undefined) throw new Error('window create failed');
    chromeWindowId = w.id;
    created.push({ ...first!, chromeTabId: firstTabId });
    pending = rest;
  }

  let refused = 0; // planned indexes assume every earlier create succeeded
  for (const t of pending) {
    try {
      const tab = await chrome.tabs.create({
        windowId: chromeWindowId,
        index: t.index - refused,
        url: t.url,
        active: false,
      });
      if (tab.id === undefined) throw new Error('no tab id');
      created.push({ ...t, chromeTabId: tab.id });
    } catch {
      refused++;
    }
  }

  const groups: Opened['groups'] = [];
  for (const g of plan.groups) {
    const ids = created.filter((t) => t.groupId === g.id).map((t) => t.chromeTabId);
    if (ids.length === 0) continue;
    const tabIds = ids as [number, ...number[]];
    try {
      if (g.chromeGroupId !== undefined) {
        await chrome.tabs.group({ groupId: g.chromeGroupId, tabIds });
        groups.push({ groupId: g.id, chromeGroupId: g.chromeGroupId });
      } else {
        groups.push({ groupId: g.id, chromeGroupId: await createGroup(chromeWindowId, tabIds, g) });
      }
    } catch {
      // Left ungrouped; the next reconcile records what Chrome holds.
    }
  }

  return {
    chromeWindowId,
    tabs: created.map((t) => ({ tabId: t.tabId, chromeTabId: t.chromeTabId })),
    groups,
  };
}
