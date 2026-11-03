// Reads what Chrome has open into the pure model's ChromeSnapshot, and the live-only details the
// view renders alongside the outline.
import type { ChromeSnapshot, LiveGroup } from '../../model/outline/types';
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
