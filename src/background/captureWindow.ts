// Captures one window's visible tab into the preview store. Chrome and the store are injected so
// the skip rules and the after-capture checks are unit-testable.
import { isCapturableUrl } from './captureScheduler';

type WindowInfo = Pick<chrome.windows.Window, 'type' | 'state' | 'incognito'>;
type TabInfo = Pick<chrome.tabs.Tab, 'id' | 'url' | 'status' | 'lastAccessed' | 'incognito'>;
export interface Shot {
  image: Blob;
  width: number;
  height: number;
}

export interface CaptureDeps {
  getWindow: (windowId: number) => Promise<WindowInfo>;
  viewWindowId: () => Promise<number | undefined>; // Tab Hammer's own window
  activeTab: (windowId: number) => Promise<TabInfo | undefined>;
  captureVisibleTab: (windowId: number) => Promise<string>; // JPEG data URL
  downscale: (dataUrl: string) => Promise<Shot>;
  save: (url: string, shot: Shot & { capturedAt: number }) => Promise<void>;
  /** Schedules another capture of the window (through the rate limiter). */
  retry: (windowId: number) => void;
  now?: () => number;
}

// Chrome's error when captureVisibleTab is called more than twice a second.
const QUOTA_ERROR = 'MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND';

export function createWindowCapturer(deps: CaptureDeps): (windowId: number) => Promise<void> {
  const now = deps.now ?? Date.now;
  const retrying = new Set<number>(); // windows whose next capture is a quota-error retry

  return async (windowId) => {
    const isRetry = retrying.delete(windowId);
    const win = await deps.getWindow(windowId);
    // Never capture or store incognito pages: previews persist on disk across sessions.
    if (win.incognito) return;
    // Tab Hammer's own window is a popup; a minimized window shows nothing to capture.
    if (win.type !== 'normal' || win.state === 'minimized') return;
    if (windowId === (await deps.viewWindowId())) return;
    const tab = await deps.activeTab(windowId);
    if (tab?.id === undefined || tab.incognito) return;
    if (tab.status !== 'complete' || !isCapturableUrl(tab.url)) return;

    let dataUrl: string;
    try {
      dataUrl = await deps.captureVisibleTab(windowId);
    } catch (err) {
      // Retry once, not forever: a retry that also hits the quota gives up.
      if (String(err).includes(QUOTA_ERROR) && !isRetry) {
        retrying.add(windowId);
        deps.retry(windowId);
      }
      return; // any other failure just means no preview
    }

    // The window may have switched tabs, navigated, or gone A→B→A while we captured (a newer
    // lastAccessed); in any of those cases the shot may not be of this page, so drop it.
    const after = await deps.activeTab(windowId);
    if (
      after?.id !== tab.id ||
      after.url !== tab.url ||
      after.status !== 'complete' ||
      after.lastAccessed !== tab.lastAccessed
    ) {
      return;
    }
    await deps.save(tab.url!, { capturedAt: now(), ...(await deps.downscale(dataUrl)) });
  };
}
