// Screenshots each window's visible tab as the user browses, for the view's hover preview.
// Chrome can only capture the tab currently showing in a window, so we capture whenever a tab
// becomes visible and keep the latest shot per page URL (so restored tabs keep theirs after a
// browser restart).
import { prunePreviews, putPreview } from '../shared/previewStore';
import { createCaptureScheduler, isCapturableUrl } from './captureScheduler';

const PREVIEW_WIDTH = 320;
// Pruning reads every key, so do it every so often rather than after each write.
const PRUNE_EVERY_WRITES = 25;
let writesSincePrune = 0;

async function downscale(dataUrl: string): Promise<{ image: Blob; width: number; height: number }> {
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

async function activeTab(windowId: number): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  return tab;
}

async function captureWindow(windowId: number): Promise<void> {
  const win = await chrome.windows.get(windowId);
  if (win.type !== 'normal') return; // Tab Hammer's own window is a popup; never capture it
  const { viewWindowId } = await chrome.storage.session.get('viewWindowId');
  if (windowId === viewWindowId) return;
  const tab = await activeTab(windowId);
  if (tab?.id === undefined || tab.status !== 'complete' || !isCapturableUrl(tab.url)) return;

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
  // The window may have switched tabs or navigated while we captured; don't mislabel the shot.
  const after = await activeTab(windowId);
  if (after?.id !== tab.id || after.url !== tab.url) return;
  await putPreview(tab.url!, { capturedAt: Date.now(), ...(await downscale(dataUrl)) });
  if (++writesSincePrune >= PRUNE_EVERY_WRITES) {
    writesSincePrune = 0;
    await prunePreviews();
  }
}

const scheduler = createCaptureScheduler({
  debounceMs: 500,
  // Chrome allows 2 captureVisibleTab calls per second; leave a little headroom.
  minIntervalMs: 550,
  capture: captureWindow,
});

const quietly = (p: Promise<unknown>) => void p.catch(() => {});

/** Registers the capture listeners. Must run synchronously at service worker top level. */
export function registerPreviewCapture(): void {
  chrome.tabs.onActivated.addListener(({ windowId }) => scheduler.trigger(windowId));
  chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
    if (change.status === 'complete' && tab.active) scheduler.trigger(tab.windowId);
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduler.trigger(windowId);
  });

  // A prerendered or instant page swapped in; it may never fire a 'complete' update.
  chrome.tabs.onReplaced.addListener((addedTabId) =>
    quietly(
      chrome.tabs.get(addedTabId).then((t) => {
        if (t.active) scheduler.trigger(t.windowId);
      }),
    ),
  );
  // Previews outlive tabs (a page may be open elsewhere or reopened later), so nothing is deleted
  // when a tab closes; age and size limits keep the store bounded instead.
  chrome.runtime.onStartup.addListener(() => quietly(prunePreviews()));
}
