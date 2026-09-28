import type { GroupColor, RawSnapshot } from '../../model/types';

let selfWindowId: number | null = null;

export async function snapshot(): Promise<RawSnapshot> {
  if (selfWindowId === null) selfWindowId = (await chrome.windows.getCurrent()).id ?? null;
  const [windows, tabs, groups] = await Promise.all([
    chrome.windows.getAll(),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
  ]);
  return {
    selfWindowId,
    windows: windows.flatMap((w) => (w.id === undefined ? [] : [{ id: w.id, focused: w.focused }])),
    tabs: tabs.flatMap((t) =>
      t.id === undefined
        ? []
        : [
            {
              id: t.id,
              windowId: t.windowId,
              index: t.index,
              groupId: t.groupId,
              title: t.title,
              url: t.url,
              pendingUrl: t.pendingUrl,
              active: t.active,
              discarded: t.discarded,
            },
          ],
    ),
    groups: groups.map((g) => ({
      id: g.id,
      windowId: g.windowId,
      title: g.title,
      color: g.color as GroupColor,
      collapsed: g.collapsed,
    })),
  };
}

type AnyEvent = { addListener(cb: () => void): void; removeListener(cb: () => void): void };

/** Calls onChange at most once per animation frame, however many Chrome events arrive. */
export function subscribe(onChange: () => void): () => void {
  let scheduled = false;
  const fire = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      onChange();
    });
  };
  const events: AnyEvent[] = [
    chrome.tabs.onCreated,
    chrome.tabs.onRemoved,
    chrome.tabs.onUpdated,
    chrome.tabs.onMoved,
    chrome.tabs.onAttached,
    chrome.tabs.onDetached,
    chrome.tabs.onActivated,
    chrome.tabs.onReplaced,
    chrome.windows.onCreated,
    chrome.windows.onRemoved,
    chrome.windows.onFocusChanged,
    chrome.tabGroups.onCreated,
    chrome.tabGroups.onUpdated,
    chrome.tabGroups.onRemoved,
    chrome.tabGroups.onMoved,
  ] as unknown as AnyEvent[];
  for (const e of events) e.addListener(fire);
  return () => events.forEach((e) => e.removeListener(fire));
}

export async function activateTab(tabId: number, windowId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(windowId, { focused: true });
}

export async function focusWindow(windowId: number): Promise<void> {
  await chrome.windows.update(windowId, { focused: true });
}
