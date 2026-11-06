// The header's "Capture missing" and "Refresh all": captures every tab's preview (or only the
// missing ones) in the background, one at a time through the service worker's on-demand capture queue,
// the same path the preview panel uses. Background tabs are drawn offscreen by the debugger, so no
// tab visibly switches. It runs in the view, so the preview panel's capture waits behind at most
// one of its captures, and closing Tab Hammer or pressing Stop ends it.
import type { CaptureOutcome } from '../../shared/captureOutcomes';
import { isCapturableUrl, previewKey } from '../../shared/previewPolicy';

/**
 * 'missing': tabs with no preview at all. Previews never go stale (an old one is how the page
 * looked when the user last had it on screen), so this is the everyday run. 'all': retake every
 * one, on request.
 */
export type RefreshMode = 'missing' | 'all';

export interface RefreshTab {
  id: number;
  windowId: number;
  url?: string;
  discarded: boolean;
  status?: string;
  incognito: boolean;
}

/**
 * Whether the tab is worth capturing for this run, given when its page was last captured.
 * Sleeping tabs (discarded by Chrome's memory saver, or not loaded since a browser restart) are
 * included: the capture wakes them in the background first, and they stay loaded until Chrome
 * puts them to sleep again.
 */
export function wantsRefresh(
  tab: RefreshTab,
  capturedAt: number | undefined,
  mode: RefreshMode,
): boolean {
  if (tab.incognito || !isCapturableUrl(tab.url)) return false;
  return mode === 'all' || capturedAt === undefined;
}

/**
 * What the preview panel says about a background tab with no preview that no Refresh run has
 * recorded anything for. It only points at Capture missing when a run would actually take the tab
 * (the same rule, wantsRefresh), and says why not otherwise. Read from Chrome's live tab.
 */
export function backgroundTabNote(tab: RefreshTab | undefined): CaptureOutcome {
  if (!tab) return 'skipped:no-tab';
  if (tab.incognito) return 'skipped:incognito';
  if (!isCapturableUrl(tab.url)) return 'skipped:not-capturable-url';
  return 'skipped:background-tab';
}

/**
 * The tabs to capture, in outline order (windows, then tabs). Tabs on the same page share a
 * preview, so each page is captured once.
 */
export function pickRefreshTargets(
  tabs: readonly RefreshTab[],
  capturedAt: (url: string) => number | undefined,
  mode: RefreshMode,
  ownWindowId: number | null,
): RefreshTab[] {
  const seen = new Set<string>();
  return tabs.filter((t) => {
    if (t.windowId === ownWindowId || !t.url) return false;
    if (!wantsRefresh(t, capturedAt(t.url), mode)) return false;
    const key = previewKey(t.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface RefreshProgress {
  done: number;
  total: number; // pages to capture: tabs on the same page share one preview
  saved: number;
  failed: number;
  /** Left alone after all: closed, already fresh, or the capture skipped it. */
  skipped: number;
}

export interface RefreshDeps {
  /** The tab as it is now, or undefined if it closed. */
  getTab: (tabId: number) => Promise<RefreshTab | undefined>;
  /** When the page at `url` was last captured. */
  capturedAt: (url: string) => Promise<number | undefined>;
  capture: (tabId: number) => Promise<CaptureOutcome>;
  onProgress: (p: RefreshProgress) => void;
}

/**
 * Captures each target in turn. Just before each, the tab is looked up again and skipped if it
 * closed, or (in 'missing' mode) got a preview meanwhile, e.g. because the user looked at it. Resolves with the final progress once done or stopped.
 */
export async function runRefresh(
  targets: readonly RefreshTab[],
  mode: RefreshMode,
  deps: RefreshDeps,
  signal: AbortSignal,
): Promise<RefreshProgress> {
  const progress: RefreshProgress = {
    done: 0,
    total: targets.length,
    saved: 0,
    failed: 0,
    skipped: 0,
  };
  deps.onProgress({ ...progress });
  for (const target of targets) {
    if (signal.aborted) break;
    const tab = await deps.getTab(target.id).catch(() => undefined);
    const url = tab?.url;
    const due =
      tab !== undefined &&
      url !== undefined &&
      wantsRefresh(tab, await deps.capturedAt(url).catch(() => undefined), mode);
    if (due && !signal.aborted) {
      const outcome = await deps
        .capture(target.id)
        .catch((err: unknown): CaptureOutcome => `error:${String(err)}`);
      if (outcome === 'saved') progress.saved++;
      else if (outcome.startsWith('error:')) progress.failed++;
      else progress.skipped++;
    } else progress.skipped++;
    progress.done++;
    deps.onProgress({ ...progress });
  }
  return progress;
}
