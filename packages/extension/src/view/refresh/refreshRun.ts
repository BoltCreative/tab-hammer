// The header's "Refresh previews": captures every tab's preview (or only the missing and stale
// ones) in the background, one at a time through the service worker's on-demand capture queue,
// the same path the preview panel uses. Background tabs are drawn offscreen by the debugger, so no
// tab visibly switches. It runs in the view, so the preview panel's capture waits behind at most
// one of its captures, and closing Tab Hammer or pressing Stop ends it.
import type { CaptureOutcome } from '../../shared/captureOutcomes';
import { STALE_PREVIEW_MS, isCapturableUrl, previewKey } from '../../shared/previewPolicy';

export type RefreshMode = 'stale' | 'all';

export interface RefreshTab {
  id: number;
  windowId: number;
  url?: string;
  discarded: boolean;
  status?: string;
  incognito: boolean;
}

/**
 * Sleeping tabs are left alone: a discarded one would reload when the debugger attached, and an
 * unloaded one (lazily restored after a browser restart) the capture would load first. Loading
 * every sleeping tab is what Chrome's memory saving avoids.
 */
export function isAsleep(tab: Pick<RefreshTab, 'discarded' | 'status'>): boolean {
  return tab.discarded || tab.status === 'unloaded';
}

/** Whether the tab is worth capturing for this run, given when its page was last captured. */
export function wantsRefresh(
  tab: RefreshTab,
  capturedAt: number | undefined,
  mode: RefreshMode,
  now: number,
): boolean {
  if (tab.incognito || isAsleep(tab) || !isCapturableUrl(tab.url)) return false;
  return mode === 'all' || capturedAt === undefined || now - capturedAt > STALE_PREVIEW_MS;
}

/**
 * The tabs to capture, in outline order (windows, then tabs). Tabs on the same page share a
 * preview, so each page is captured once.
 */
export function pickRefreshTargets(
  tabs: readonly RefreshTab[],
  capturedAt: (url: string) => number | undefined,
  mode: RefreshMode,
  now: number,
  ownWindowId: number | null,
): RefreshTab[] {
  const seen = new Set<string>();
  return tabs.filter((t) => {
    if (t.windowId === ownWindowId || !t.url) return false;
    if (!wantsRefresh(t, capturedAt(t.url), mode, now)) return false;
    const key = previewKey(t.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface RefreshProgress {
  done: number;
  total: number;
  saved: number;
  failed: number;
}

export interface RefreshDeps {
  /** The tab as it is now, or undefined if it closed. */
  getTab: (tabId: number) => Promise<RefreshTab | undefined>;
  /** When the page at `url` was last captured. */
  capturedAt: (url: string) => Promise<number | undefined>;
  capture: (tabId: number) => Promise<CaptureOutcome>;
  onProgress: (p: RefreshProgress) => void;
  now?: () => number;
}

/**
 * Captures each target in turn. Just before each, the tab is looked up again and skipped if it
 * closed, went to sleep, or (in 'stale' mode) got a fresh preview meanwhile, e.g. because the
 * user looked at it. Resolves with the final progress once done or stopped.
 */
export async function runRefresh(
  targets: readonly RefreshTab[],
  mode: RefreshMode,
  deps: RefreshDeps,
  signal: AbortSignal,
): Promise<RefreshProgress> {
  const now = deps.now ?? Date.now;
  const progress: RefreshProgress = { done: 0, total: targets.length, saved: 0, failed: 0 };
  deps.onProgress({ ...progress });
  for (const target of targets) {
    if (signal.aborted) break;
    const tab = await deps.getTab(target.id).catch(() => undefined);
    const url = tab?.url;
    const due =
      tab !== undefined &&
      url !== undefined &&
      wantsRefresh(tab, await deps.capturedAt(url).catch(() => undefined), mode, now());
    if (due && !signal.aborted) {
      const outcome = await deps
        .capture(target.id)
        .catch((err: unknown): CaptureOutcome => `error:${String(err)}`);
      if (outcome === 'saved') progress.saved++;
      else if (outcome.startsWith('error:')) progress.failed++;
    }
    progress.done++;
    deps.onProgress({ ...progress });
  }
  return progress;
}
