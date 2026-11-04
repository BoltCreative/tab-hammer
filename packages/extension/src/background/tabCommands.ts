// What each bridge method does to Chrome. Called by bridge.ts with a request from Claude's MCP
// server; Chrome's own errors (e.g. "No tab with id") propagate as the call's error.
import type { GroupColor, GroupInfo, Methods, TabInfo, WindowInfo } from '@tab-hammer/protocol';
import { SWAP_KEY, hiddenBySwap, isSwapRecord } from '../shared/captureSwap';

type Handlers = {
  [M in keyof Methods]: (params: Methods[M]['params']) => Promise<Methods[M]['result']>;
};

function tabInfo(t: chrome.tabs.Tab & { id: number }): TabInfo {
  return {
    tabId: t.id,
    title: t.title || t.url || t.pendingUrl || '',
    url: t.url || t.pendingUrl || '',
    active: t.active,
    pinned: t.pinned,
    discarded: t.discarded,
    ...(t.lastAccessed !== undefined && { lastAccessed: new Date(t.lastAccessed).toISOString() }),
  };
}

async function listTabs(): Promise<{ windows: WindowInfo[] }> {
  // Normal windows only: leaves out Tab Hammer's own popup window (and devtools windows).
  const [windows, groups, focused, stored] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    chrome.tabGroups.query({}),
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined),
    chrome.storage.local.get(SWAP_KEY).catch(() => ({}) as Record<string, unknown>),
  ]);
  // Skip the temporary tab a preview capture may have open, as the outline does.
  const swap = isSwapRecord(stored[SWAP_KEY]) ? stored[SWAP_KEY] : undefined;
  const now = Date.now();
  const groupById = new Map(groups.map((g) => [g.id, g]));
  return {
    windows: windows.flatMap((w) => {
      if (w.id === undefined) return [];
      const items: (TabInfo | GroupInfo)[] = [];
      let run: GroupInfo | null = null;
      for (const t of w.tabs ?? []) {
        if (t.id === undefined || hiddenBySwap(swap, { id: t.id, windowId: t.windowId }, now)) {
          continue;
        }
        const tab = tabInfo(t as chrome.tabs.Tab & { id: number });
        const g = groupById.get(t.groupId);
        if (!g) {
          run = null;
          items.push(tab);
          continue;
        }
        if (!run || run.groupId !== g.id) {
          run = {
            groupId: g.id,
            title: g.title ?? '',
            color: g.color as GroupColor,
            collapsed: g.collapsed,
            tabs: [],
          };
          items.push(run);
        }
        run.tabs.push(tab);
      }
      return [{ windowId: w.id, focused: w.id === focused?.id, incognito: w.incognito, items }];
    }),
  };
}

type CreateWindow = (data: chrome.windows.CreateData) => Promise<chrome.windows.Window | undefined>;
let createWindow: CreateWindow = (data) => chrome.windows.create(data);

/**
 * Has new windows opened through `create`: the service worker routes them through the outline, so
 * it records a window Tab Hammer opened as known rather than as one to re-link to a closed window.
 */
export function setWindowCreator(create: CreateWindow): void {
  createWindow = create;
}

function nonEmpty(ids: number[]): [number, ...number[]] {
  if (ids.length === 0) throw new Error('tabIds is empty');
  return ids as [number, ...number[]];
}

const handlers: Handlers = {
  list_tabs: listTabs,

  focus_tab: async ({ tabId }) => {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    return null;
  },

  open_tabs: async ({ urls, windowId }) => {
    if (windowId === undefined) {
      const win = await createWindow({ url: urls });
      return { windowId: win!.id!, tabIds: (win!.tabs ?? []).map((t) => t.id!) };
    }
    const tabs = [];
    for (const url of urls) tabs.push(await chrome.tabs.create({ windowId, url, active: false }));
    return { windowId, tabIds: tabs.map((t) => t.id!) };
  },

  move_tabs: async ({ tabIds, windowId, index }) => {
    let target = windowId;
    let rest = tabIds;
    if (target === undefined) {
      // A new window takes its first tab at creation; the rest follow it in order.
      const win = await createWindow({ tabId: tabIds[0] });
      target = win!.id!;
      rest = tabIds.slice(1);
    }
    if (rest.length > 0) await chrome.tabs.move(rest, { windowId: target, index: index ?? -1 });
    return { windowId: target };
  },

  group_tabs: async ({ tabIds, groupId, title, color }) => {
    let id: number;
    if (groupId !== undefined) {
      id = await chrome.tabs.group({ tabIds: nonEmpty(tabIds), groupId });
    } else {
      // New groups default to the "current" window, which from here is arbitrary: use the first tab's.
      const first = await chrome.tabs.get(tabIds[0]!);
      id = await chrome.tabs.group({
        tabIds: nonEmpty(tabIds),
        createProperties: { windowId: first.windowId },
      });
    }
    if (title !== undefined || color !== undefined) {
      await chrome.tabGroups.update(id, {
        ...(title !== undefined && { title }),
        ...(color !== undefined && { color }),
      });
    }
    return { groupId: id };
  },

  ungroup_tabs: async ({ tabIds }) => {
    await chrome.tabs.ungroup(nonEmpty(tabIds));
    return null;
  },

  update_group: async ({ groupId, title, color, collapsed }) => {
    await chrome.tabGroups.update(groupId, {
      ...(title !== undefined && { title }),
      ...(color !== undefined && { color }),
      ...(collapsed !== undefined && { collapsed }),
    });
    return null;
  },

  close_tabs: async ({ tabIds }) => {
    await chrome.tabs.remove(tabIds);
    return { closed: tabIds.length };
  },
};

export async function runCommand<M extends keyof Methods>(
  method: M,
  params: Methods[M]['params'],
): Promise<Methods[M]['result']> {
  const handler = handlers[method] as
    ((p: typeof params) => Promise<Methods[M]['result']>) | undefined;
  if (!handler) throw new Error(`Unknown method: ${String(method)}`);
  return handler(params);
}
