// Screenshots each window's visible tab as the user browses, for the view's hover preview.
// Chrome can only capture the tab currently showing in a window, so we capture whenever a tab
// becomes visible and keep the latest shot per page URL (so restored tabs keep theirs after a
// browser restart).
import {
  OUTCOMES_KEY,
  TAB_OUTCOMES_KEY,
  withOutcome,
  type CaptureOutcome,
  type OutcomeMap,
} from '../shared/captureOutcomes';
import { SWAP_KEY, isSwapRecord } from '../shared/captureSwap';
import {
  isCaptureTabRequest,
  isClearPreviewsRequest,
  type CaptureTabReply,
} from '../shared/messages';
import { clearPreviews, putPreview } from '../shared/previewStore';
import { browserSession } from './session';
import { createViewWindowFinder } from './viewWindow';
import { createCaptureQueue } from './captureQueue';
import { createLoadWaiter } from './waitForLoad';
import { createCaptureScheduler } from './captureScheduler';
import {
  createActivationGenerations,
  createWindowCapturer,
  message,
  type Shot,
} from './captureWindow';
import { SCREENSHOT_PARAMS, createTabCapturer } from './debuggerCapture';

// About 2× the card's ~404 CSS px width, so previews stay sharp on Retina displays.
const PREVIEW_WIDTH = 640;

async function downscale(dataUrl: string): Promise<Shot> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const width = Math.min(PREVIEW_WIDTH, bitmap.width);
  const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return {
    image: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 }),
    width,
    height,
  };
}

// A preview is kept exactly as long as this computer's outline has a tab at its address (see
// previewPrune.ts, run from the outline's change hook); saving never evicts anything.
async function save(url: string, shot: Shot & { capturedAt: number }): Promise<void> {
  await putPreview(url, shot);
}

// Window captures run one at a time (the scheduler serializes them), and so do tab captures (the
// queue does), and each kind has its own key, so these read-modify-writes can't race.
async function recordUnder(
  key: string,
  id: number,
  outcome: CaptureOutcome,
  url?: string,
): Promise<void> {
  const { [key]: prev } = await chrome.storage.session.get(key);
  const map = prev && typeof prev === 'object' ? (prev as OutcomeMap) : {};
  const entry = url === undefined ? { at: Date.now(), outcome } : { at: Date.now(), outcome, url };
  await chrome.storage.session.set({ [key]: withOutcome(map, id, entry) });
}

const waitForComplete = createLoadWaiter({
  onUpdated: chrome.tabs.onUpdated,
  onRemoved: chrome.tabs.onRemoved,
  getStatus: async (tabId) => (await chrome.tabs.get(tabId)).status,
});

// Finds Tab Hammer's own window (see viewWindow.ts); the capturers skip it.
export const viewWindows = createViewWindowFinder(() => browserSession.current());
const viewWindowId = viewWindows.viewWindowId;

const record = (windowId: number, outcome: CaptureOutcome) =>
  recordUnder(OUTCOMES_KEY, windowId, outcome);

const generations = createActivationGenerations();

const captureWindow = createWindowCapturer({
  hasPermission: () => chrome.permissions.contains({ origins: ['<all_urls>'] }),
  getWindow: (windowId) => chrome.windows.get(windowId),
  viewWindowId,
  activeTab: async (windowId) => (await chrome.tabs.query({ windowId, active: true }))[0],
  captureVisibleTab: (windowId) =>
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 }),
  downscale,
  save,
  retry: (windowId) => scheduler.trigger(windowId),
  generation: generations.get,
  record,
});

const scheduler = createCaptureScheduler<CaptureOutcome>({
  debounceMs: 500,
  // Chrome allows 2 captureVisibleTab calls per second; leave a little headroom.
  minIntervalMs: 550,
  // Well past a normal capture (a screenshot, a downscale, a save).
  captureTimeoutMs: 10_000,
  capture: captureWindow,
});

// On-demand captures for the preview panel (see debuggerCapture.ts).
const captureTab = createTabCapturer({
  hasPermission: () =>
    chrome.permissions.contains({ permissions: ['debugger'], origins: ['<all_urls>'] }),
  getTab: (tabId) => chrome.tabs.get(tabId),
  getWindow: (windowId) => chrome.windows.get(windowId),
  viewWindowId,
  tabsInWindow: (windowId) => chrome.tabs.query({ windowId }),
  collapsedGroups: async (windowId) =>
    (await chrome.tabGroups.query({ windowId, collapsed: true })).map((g) => g.id),
  activate: async (tabId) => void (await chrome.tabs.update(tabId, { active: true })),
  createBlankTab: async (windowId) =>
    (await chrome.tabs.create({ windowId, url: 'about:blank', active: true })).id!,
  removeTab: (tabId) => chrome.tabs.remove(tabId),
  saveSwap: (record) =>
    record
      ? chrome.storage.local.set({ [SWAP_KEY]: record })
      : chrome.storage.local.remove(SWAP_KEY),
  loadSwap: async () => {
    const { [SWAP_KEY]: record } = await chrome.storage.local.get(SWAP_KEY);
    return isSwapRecord(record) ? record : undefined;
  },
  attach: (tabId) => chrome.debugger.attach({ tabId }, '1.3'),
  detach: (tabId) => chrome.debugger.detach({ tabId }),
  screenshot: async (tabId) => {
    const res = await chrome.debugger.sendCommand(
      { tabId },
      'Page.captureScreenshot',
      SCREENSHOT_PARAMS,
    );
    return (res as { data: string }).data;
  },
  // Through the scheduler, so it shares the captureVisibleTab rate limit.
  captureVisible: async (windowId) => {
    const done = scheduler.nextCapture(windowId);
    scheduler.trigger(windowId);
    return (await done) ?? 'error:capture failed';
  },
  downscale,
  save,
  previousOutcome: async (tabId) => {
    const { [TAB_OUTCOMES_KEY]: map } = await chrome.storage.session.get(TAB_OUTCOMES_KEY);
    return map && typeof map === 'object' ? (map as OutcomeMap)[tabId] : undefined;
  },
  record: (tabId, outcome, url) => recordUnder(TAB_OUTCOMES_KEY, tabId, outcome, url),
  sessionId: () => browserSession.current(),
  waitForComplete,
  // To be confirmed in real Chrome: reloading a sleeping background tab (lazily restored, or
  // discarded) loads it without activating it, and keeps its tab ID.
  reload: (tabId) => chrome.tabs.reload(tabId),
});

/**
 * A previous service worker may have died mid-capture: finish undoing its minimized-window swap,
 * and detach any debugger session it left behind (detach only ends our own sessions, never
 * DevTools'; tabs we aren't attached to just reject).
 */
async function cleanUpAfterCrash(): Promise<void> {
  await captureTab.recover().catch(() => {});
  const targets = await chrome.debugger.getTargets().catch(() => []);
  await Promise.all(
    targets
      .filter((t) => t.attached && t.tabId !== undefined)
      .map((t) => chrome.debugger.detach({ tabId: t.tabId }).catch(() => {})),
  );
}
// Runs once per service worker lifetime, before its first capture. It is also started early by
// onInstalled (the extension was reloaded or updated) and onStartup (the browser launched). Either
// order is safe: recovery reads the browser session ID, which waits until onStartup has renewed it
// (see browserSession.ts), so a record from before a browser restart is dropped, never acted on.
let cleanedUp: Promise<void> | undefined;
const cleanUpOnce = () => (cleanedUp ??= cleanUpAfterCrash());

// Keyed by tab and mode, so a Refresh request never shares a hover's banner-free result.
type TabCaptureKey = `${number}:${'any' | 'visible'}`;
const tabQueue = createCaptureQueue<TabCaptureKey, CaptureOutcome>({
  run: async (key, signal) => {
    await cleanUpOnce();
    const [tabId, mode] = key.split(':');
    return captureTab.capture(Number(tabId), mode === 'any', signal);
  },
  dropped: 'skipped:superseded',
  failed: (err) => `error:${message(err)}`,
  // Only the last few hovered cards are still worth capturing.
  maxWaiting: 3,
  // Well past a normal run: up to 8s waiting for the tab to load, a 5s screenshot limit, and a few
  // tab calls.
  runTimeoutMs: 20_000,
});

/**
 * The view's "Clear previews" debug button: every stored preview, and every recorded outcome
 * (which also ends all failure cooldowns, since those are read from the tab outcomes).
 */
async function clearAll(): Promise<void> {
  await clearPreviews();
  await chrome.storage.session.remove([OUTCOMES_KEY, TAB_OUTCOMES_KEY]);
}

const quietly = (p: Promise<unknown>) => void p.catch(() => {});

/** A window capture is due or running (test hook: wait it out before asserting on the store). */
export const capturesPending = (): boolean => scheduler.pending();

/** Registers the capture listeners. Must run synchronously at service worker top level. */
export function registerPreviewCapture(): void {
  // Incognito tabs are filtered here so they don't spend the capture rate budget; captureWindow
  // also refuses incognito windows, since previews persist on disk.
  // Every change to what a window shows bumps its activation generation, so a capture in flight
  // across the change is dropped (see createActivationGenerations).
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    generations.bump(windowId);
    scheduler.trigger(windowId);
  });
  chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
    if (!tab.active) return;
    if (change.url !== undefined || change.status === 'loading') generations.bump(tab.windowId);
    if (change.status === 'complete' && !tab.incognito) scheduler.trigger(tab.windowId);
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduler.trigger(windowId);
  });

  // A prerendered or instant page swapped in; it may never fire a 'complete' update.
  chrome.tabs.onReplaced.addListener((addedTabId) =>
    quietly(
      chrome.tabs.get(addedTabId).then((t) => {
        generations.bump(t.windowId);
        if (t.active && !t.incognito) scheduler.trigger(t.windowId);
      }),
    ),
  );
  // Previews are deleted once no window record uses their address (previewPrune.ts, wired in
  // index.ts), never here when a tab closes: the same page may be open in another tab.
  chrome.runtime.onStartup.addListener(() => {
    quietly(browserSession.launched());
    quietly(cleanUpOnce());
  });
  // Previews never go stale and never follow Chrome's history: clearing browsing data leaves them.
  // Only Clear previews, Refresh all, and the outline dropping their address remove or replace
  // them.
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    quietly(browserSession.installed(reason));
    quietly(cleanUpOnce());
  });

  // The preview panel asks for a tab it has no fresh preview of; reply once the capture is done.
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (isClearPreviewsRequest(msg)) {
      void clearAll().then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    if (!isCaptureTabRequest(msg)) return false;
    void tabQueue
      .request(`${msg.tabId}:${msg.allowDebugger === true ? 'any' : 'visible'}`)
      .then((outcome) => sendResponse({ outcome } satisfies CaptureTabReply));
    return true; // the reply is async
  });
}
