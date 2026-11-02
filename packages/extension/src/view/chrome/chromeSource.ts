import type { GroupColor, RawSnapshot } from '../../model/types';
import type { MoveOp } from '../../model/moveSelection';
import { SWAP_KEY, SWAP_MAX_AGE_MS, hiddenBySwap, isSwapRecord } from '../../shared/captureSwap';

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
  const [windows, tabs, groups, stored] = await Promise.all([
    chrome.windows.getAll(),
    chrome.tabs.query({}),
    chrome.tabGroups.query({}),
    chrome.storage.local.get(SWAP_KEY).catch(() => ({}) as Record<string, unknown>),
  ]);
  // The temporary tab of a preview capture's minimized-window swap is left out, so the tree (and
  // the hover card open over it) doesn't change while it exists.
  const swap = isSwapRecord(stored[SWAP_KEY]) ? stored[SWAP_KEY] : undefined;
  const now = Date.now();
  return {
    selfWindowId,
    lastFocusedWindowId,
    windows: windows.flatMap((w) => (w.id === undefined ? [] : [{ id: w.id }])),
    tabs: tabs.flatMap((t) =>
      t.id === undefined || hiddenBySwap(swap, { id: t.id, windowId: t.windowId }, now)
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
              lastAccessed: t.lastAccessed,
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
  // A swap ending can reveal a tab it hid (one the user kept), and so can its record going stale
  // (left over from a crash), which no Chrome event announces.
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  const watchSwap = (record: unknown) => {
    clearTimeout(staleTimer);
    if (!isSwapRecord(record)) return;
    const wait = Math.max(0, record.at + SWAP_MAX_AGE_MS + 1 - Date.now());
    staleTimer = setTimeout(fire, wait);
  };
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(SWAP_KEY in changes)) return;
    watchSwap(changes[SWAP_KEY]!.newValue);
    fire();
  };
  chrome.storage.onChanged.addListener(onStorage);
  void chrome.storage.local
    .get(SWAP_KEY)
    .then((stored) => watchSwap(stored[SWAP_KEY]))
    .catch(() => {});
  return () => {
    clearTimeout(staleTimer);
    chrome.storage.onChanged.removeListener(onStorage);
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

/** Runs a drag-move's planned Chrome calls in order (see model/moveSelection.ts). */
export async function applyMoveOps(ops: MoveOp[]): Promise<void> {
  for (const o of ops) {
    switch (o.op) {
      case 'moveTab':
        await chrome.tabs.move(o.tabId, { windowId: o.windowId, index: o.index });
        break;
      case 'moveGroup':
        await chrome.tabGroups.move(o.groupId, { windowId: o.windowId, index: o.index });
        break;
      case 'group':
        await chrome.tabs.group({ tabIds: o.tabIds as [number, ...number[]], groupId: o.groupId });
        break;
      case 'ungroup':
        await chrome.tabs.ungroup(o.tabIds as [number, ...number[]]);
        break;
      case 'moveNextTo': {
        // Read positions now: earlier calls in this plan have shifted them. A move removes the tab
        // first, so a tab left of the anchor lands one lower.
        const [tab, anchor] = await Promise.all([
          chrome.tabs.get(o.tabId),
          chrome.tabs.get(o.anchorTabId),
        ]);
        const left = tab.windowId === anchor.windowId && tab.index < anchor.index ? 1 : 0;
        const index = anchor.index - left + (o.side === 'after' ? 1 : 0);
        await chrome.tabs.move(o.tabId, { windowId: anchor.windowId, index });
        break;
      }
    }
  }
}
