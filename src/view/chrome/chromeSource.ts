import type { GroupColor, RawSnapshot } from '../../model/types';

let selfWindowIdPromise: Promise<number | null> | null = null;
function getSelfWindowId(): Promise<number | null> {
  selfWindowIdPromise ??= chrome.windows.getCurrent().then((w) => w.id ?? null);
  return selfWindowIdPromise;
}

// Tab Hammer's own window is focused whenever it is in use, so "focused" means the most
// recently focused window other than Tab Hammer. Seeded once from Chrome, then kept current
// by onFocusChanged (see trackFocus).
let lastFocusedWindowId: number | null = null;
let lastFocusedSeed: Promise<void> | null = null;
function seedLastFocused(): Promise<void> {
  lastFocusedSeed ??= chrome.windows
    .getLastFocused({ windowTypes: ['normal'] })
    .then((w) => {
      lastFocusedWindowId ??= w.id ?? null;
    })
    .catch(() => {
      // No normal window exists yet; onFocusChanged fills it in later.
    });
  return lastFocusedSeed;
}

async function trackFocus(windowId: number): Promise<void> {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (windowId === (await getSelfWindowId())) return;
  lastFocusedWindowId = windowId;
}

export async function snapshot(): Promise<RawSnapshot> {
  const [selfWindowId] = await Promise.all([getSelfWindowId(), seedLastFocused()]);
  const [windows, tabs, groups] = await Promise.all([
    chrome.windows.getAll(),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
  ]);
  return {
    selfWindowId,
    lastFocusedWindowId,
    windows: windows.flatMap((w) => (w.id === undefined ? [] : [{ id: w.id }])),
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
  // Registered before `fire` so the focus is updated before the snapshot that follows.
  const onFocusChanged = (windowId: number) => void trackFocus(windowId);
  chrome.windows.onFocusChanged.addListener(onFocusChanged);
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
  return () => {
    chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    events.forEach((e) => e.removeListener(fire));
  };
}

export async function activateTab(tabId: number, windowId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(windowId, { focused: true });
}

export async function focusWindow(windowId: number): Promise<void> {
  await chrome.windows.update(windowId, { focused: true });
}
