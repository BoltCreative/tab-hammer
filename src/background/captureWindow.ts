// Captures one window's visible tab into the preview store. Chrome and the store are injected so
// the skip rules and the after-capture checks are unit-testable.
import type { CaptureOutcome } from '../shared/captureOutcomes';
import { isCapturableUrl } from './captureScheduler';

type WindowInfo = Pick<chrome.windows.Window, 'type' | 'state' | 'incognito'>;
type TabInfo = Pick<chrome.tabs.Tab, 'id' | 'url' | 'status' | 'incognito'>;
export interface Shot {
  image: Blob;
  width: number;
  height: number;
}

export interface CaptureDeps {
  // Chrome may leave the <all_urls> host permission ungranted after an unpacked reload, or the
  // user can withhold it at any time; checked first so a missing grant never spends the capture
  // rate budget on a call that would just fail.
  hasPermission: () => Promise<boolean>;
  getWindow: (windowId: number) => Promise<WindowInfo>;
  viewWindowId: () => Promise<number | undefined>; // Tab Hammer's own window
  activeTab: (windowId: number) => Promise<TabInfo | undefined>;
  captureVisibleTab: (windowId: number) => Promise<string>; // JPEG data URL
  downscale: (dataUrl: string) => Promise<Shot>;
  save: (url: string, shot: Shot & { capturedAt: number }) => Promise<void>;
  /** Schedules another capture of the window (through the rate limiter). */
  retry: (windowId: number) => void;
  /** The window's activation generation (see createActivationGenerations). */
  generation: (windowId: number) => number;
  /** Records the attempt's outcome for the hover card's diagnostics. Failures are ignored. */
  record: (windowId: number, outcome: CaptureOutcome) => Promise<void>;
  now?: () => number;
}

/**
 * A per-window counter the service worker bumps whenever what a window shows may have changed
 * (tab activated, the active tab navigating or reloading, a tab swapped in). A capture that sees
 * the counter move may be of another page, even if the same tab is active again afterwards
 * (A→B→A). Chrome's tab.lastAccessed can't serve this: it also moves when a capture itself makes
 * an occluded or unfocused window's tab visible, which dropped every real-world shot.
 */
export function createActivationGenerations() {
  const gens = new Map<number, number>();
  return {
    bump: (windowId: number) => void gens.set(windowId, (gens.get(windowId) ?? 0) + 1),
    get: (windowId: number) => gens.get(windowId) ?? 0,
  };
}

// Chrome's error when captureVisibleTab is called more than twice a second.
const QUOTA_ERROR = 'MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createWindowCapturer(deps: CaptureDeps): (windowId: number) => Promise<void> {
  const now = deps.now ?? Date.now;
  const retrying = new Set<number>(); // windows whose next capture is a quota-error retry

  const attempt = async (windowId: number): Promise<CaptureOutcome> => {
    if (!(await deps.hasPermission())) return 'skipped:no-permission';
    const isRetry = retrying.delete(windowId);
    const win = await deps.getWindow(windowId);
    // Never capture or store incognito pages: previews persist on disk across sessions.
    if (win.incognito) return 'skipped:incognito';
    // Tab Hammer's own window is a popup; a minimized window shows nothing to capture.
    if (win.type !== 'normal') return 'skipped:not-normal-window';
    if (win.state === 'minimized') return 'skipped:minimized';
    if (windowId === (await deps.viewWindowId())) return 'skipped:own-window';
    const tab = await deps.activeTab(windowId);
    if (tab?.id === undefined) return 'skipped:no-tab';
    if (tab.incognito) return 'skipped:incognito';
    if (tab.status !== 'complete') return 'skipped:not-complete';
    if (!isCapturableUrl(tab.url)) return 'skipped:not-capturable-url';

    const generation = deps.generation(windowId);
    let dataUrl: string;
    try {
      dataUrl = await deps.captureVisibleTab(windowId);
    } catch (err) {
      // Retry once, not forever: a retry that also hits the quota gives up.
      if (String(err).includes(QUOTA_ERROR) && !isRetry) {
        retrying.add(windowId);
        deps.retry(windowId);
      }
      return `error:capture: ${message(err)}`;
    }

    // The window may have switched tabs, navigated, or gone A→B→A while we captured; in any of
    // those cases the shot may not be of this page, so drop it.
    const after = await deps.activeTab(windowId);
    if (deps.generation(windowId) !== generation || after?.id !== tab.id || after.url !== tab.url) {
      return 'skipped:changed-during-capture';
    }
    let shot: Shot;
    try {
      shot = await deps.downscale(dataUrl);
    } catch (err) {
      return `error:downscale: ${message(err)}`;
    }
    try {
      await deps.save(tab.url!, { capturedAt: now(), ...shot });
    } catch (err) {
      return `error:save: ${message(err)}`;
    }
    return 'saved';
  };

  return async (windowId) => {
    const outcome = await attempt(windowId).catch((err): CaptureOutcome => `error:${message(err)}`);
    await deps.record(windowId, outcome).catch(() => {});
  };
}
