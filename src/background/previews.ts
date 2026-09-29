// Screenshots each window's visible tab as the user browses, for the view's hover preview.
// Chrome can only capture the tab currently showing in a window, so we capture whenever a tab
// becomes visible and keep the latest shot per page URL (so restored tabs keep theirs after a
// browser restart).
import { PRUNE_LIMITS } from '../shared/previewPolicy';
import { prunePreviews, putPreview } from '../shared/previewStore';
import { createCaptureScheduler } from './captureScheduler';
import { createWindowCapturer, type Shot } from './captureWindow';

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

// The service worker is killed after ~30s idle, so in-memory counters don't survive long.
// Prune on the first write of each lifetime (applies the age limit regularly) and whenever a
// write pushes the store over its size cap.
let prunedThisLifetime = false;
async function save(url: string, shot: Shot & { capturedAt: number }): Promise<void> {
  const count = await putPreview(url, shot);
  if (!prunedThisLifetime || count > PRUNE_LIMITS.maxEntries) {
    prunedThisLifetime = true;
    await prunePreviews();
  }
}

const captureWindow = createWindowCapturer({
  hasPermission: () => chrome.permissions.contains({ origins: ['<all_urls>'] }),
  getWindow: (windowId) => chrome.windows.get(windowId),
  viewWindowId: async () => {
    const { viewWindowId } = await chrome.storage.session.get('viewWindowId');
    return typeof viewWindowId === 'number' ? viewWindowId : undefined;
  },
  activeTab: async (windowId) => (await chrome.tabs.query({ windowId, active: true }))[0],
  captureVisibleTab: (windowId) =>
    chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 }),
  downscale,
  save,
  retry: (windowId) => scheduler.trigger(windowId),
});

const scheduler = createCaptureScheduler({
  debounceMs: 500,
  // Chrome allows 2 captureVisibleTab calls per second; leave a little headroom.
  minIntervalMs: 550,
  capture: captureWindow,
});

const quietly = (p: Promise<unknown>) => void p.catch(() => {});

/** Registers the capture listeners. Must run synchronously at service worker top level. */
export function registerPreviewCapture(): void {
  // Incognito tabs are filtered here so they don't spend the capture rate budget; captureWindow
  // also refuses incognito windows, since previews persist on disk.
  chrome.tabs.onActivated.addListener(({ windowId }) => scheduler.trigger(windowId));
  chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
    if (change.status === 'complete' && tab.active && !tab.incognito) {
      scheduler.trigger(tab.windowId);
    }
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduler.trigger(windowId);
  });

  // A prerendered or instant page swapped in; it may never fire a 'complete' update.
  chrome.tabs.onReplaced.addListener((addedTabId) =>
    quietly(
      chrome.tabs.get(addedTabId).then((t) => {
        if (t.active && !t.incognito) scheduler.trigger(t.windowId);
      }),
    ),
  );
  // Previews outlive tabs (a page may be open elsewhere or reopened later), so nothing is deleted
  // when a tab closes; age and size limits keep the store bounded instead.
  chrome.runtime.onStartup.addListener(() => quietly(prunePreviews()));
}
