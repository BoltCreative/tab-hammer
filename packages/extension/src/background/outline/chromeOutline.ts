// Reads what Chrome has open into the pure model's ChromeSnapshot, and the live-only details the
// view renders alongside the outline; carries out the Chrome side of outline commands.
import type { OpenPlan, Opened } from '../../model/outline/open';
import type { ChromeSnapshot, Effects, GroupRec, LiveGroup } from '../../model/outline/types';
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
  return {
    windowIds,
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
 * Reopened background tabs are discarded so they load only when first visited. Not in the e2e
 * build: headless Chromium segfaults moments after any chrome.tabs.discard.
 */
const DISCARD_BACKGROUND_TABS = import.meta.env.MODE !== 'e2e';

/** Closes what a model op says to close. Each error is ignored: the window or tab is already gone. */
export async function runEffects(e: Effects): Promise<void> {
  await Promise.all([
    ...e.closeWindows.map((id) => chrome.windows.remove(id).catch(() => undefined)),
    ...(e.closeTabs.length > 0 ? [chrome.tabs.remove(e.closeTabs).catch(() => undefined)] : []),
  ]);
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
 * Opens `plan`'s tabs in Chrome, in order, then their groups. A tab Chrome refuses is skipped (its
 * record stays hibernated) and the tabs after it shift left by one. Background tabs are discarded,
 * best effort, so they load only when first visited. Throws only if a new window can't be created.
 */
export async function openPlanned(plan: OpenPlan): Promise<Opened> {
  const created: { tabId: string; chromeTabId: number; groupId?: string }[] = [];
  const background: number[] = [];
  let pending = plan.tabs;
  let chromeWindowId = plan.chromeWindowId;
  if (chromeWindowId === null) {
    const [first, ...rest] = plan.tabs;
    const w = await chrome.windows.create({ url: first!.url, focused: true });
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
      background.push(tab.id);
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

  // Discarding swaps a tab's ID; the replacement is the one to attach.
  const swapped = new Map<number, number>();
  await Promise.all(
    (DISCARD_BACKGROUND_TABS ? background : []).map(async (id) => {
      const tab = await chrome.tabs.discard(id).catch(() => undefined);
      if (tab?.id !== undefined && tab.id !== id) swapped.set(id, tab.id);
    }),
  );

  return {
    chromeWindowId,
    tabs: created.map((t) => ({
      tabId: t.tabId,
      chromeTabId: swapped.get(t.chromeTabId) ?? t.chromeTabId,
    })),
    groups,
  };
}
