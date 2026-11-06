// Talks to the service worker about preview captures: reads its record of the latest attempt for
// a tab and its window (see ../../shared/captureOutcomes.ts), so the preview panel can say why a
// tab has no preview, and asks it to capture a tab on demand (one tab for the preview panel, or
// each in turn for the header's "Refresh previews").
import {
  OUTCOMES_KEY,
  TAB_OUTCOMES_KEY,
  type CaptureOutcome,
  type OutcomeEntry,
  type OutcomeMap,
} from '../../shared/captureOutcomes';
import {
  CAPTURE_TAB,
  CLEAR_PREVIEWS,
  type CaptureTabReply,
  type CaptureTabRequest,
  type ClearPreviewsRequest,
} from '../../shared/messages';
import { getPreview } from '../../shared/previewStore';
import type { RefreshTab } from '../refresh/refreshRun';

/**
 * The latest capture attempt that concerns this tab: its own on-demand one if it has one (it is
 * about this very tab), else its window's.
 */
export async function latestCaptureOutcome(
  windowId: number,
  tabId: number,
): Promise<OutcomeEntry | undefined> {
  const stored = await chrome.storage.session.get([OUTCOMES_KEY, TAB_OUTCOMES_KEY]);
  return pick(stored[TAB_OUTCOMES_KEY], tabId) ?? pick(stored[OUTCOMES_KEY], windowId);
}

/**
 * The tab's own latest on-demand capture outcome, ignoring its window's (which is about the
 * window's visible tab, so says nothing about a background one).
 */
export async function tabCaptureOutcome(tabId: number): Promise<OutcomeEntry | undefined> {
  const stored = await chrome.storage.session.get(TAB_OUTCOMES_KEY);
  return pick(stored[TAB_OUTCOMES_KEY], tabId);
}

function pick(map: unknown, id: number): OutcomeEntry | undefined {
  return map && typeof map === 'object' ? (map as OutcomeMap)[id] : undefined;
}

/**
 * Asks the service worker to screenshot the tab now; resolves when it is done. `allowDebugger`
 * lets it capture a tab that isn't on screen, at the cost of Chrome's debugging infobar (which
 * shifts the outline): only the explicit Refresh runs pass true.
 */
export async function requestTabCapture(
  tabId: number,
  allowDebugger: boolean,
): Promise<CaptureOutcome> {
  const reply = (await chrome.runtime.sendMessage({
    type: CAPTURE_TAB,
    tabId,
    allowDebugger,
  } satisfies CaptureTabRequest)) as CaptureTabReply | undefined;
  return reply?.outcome ?? 'error:no reply from the service worker';
}

/** Asks the service worker to delete every preview and capture outcome; resolves when done. */
export async function clearAllPreviews(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({
    type: CLEAR_PREVIEWS,
  } satisfies ClearPreviewsRequest)) as { ok?: boolean } | undefined;
  if (!reply?.ok) throw new Error('clearing previews failed');
}

/** Whether the tab has finished loading (an on-demand capture loads it first if not). */
export async function isTabLoaded(tabId: number): Promise<boolean> {
  return (await chrome.tabs.get(tabId)).status === 'complete';
}

/** Calls `onLoaded` once the tab finishes loading. Returns the unsubscribe. */
export function watchTabLoaded(tabId: number, onLoaded: () => void): () => void {
  const listener = (id: number, change: { status?: string }) => {
    if (id === tabId && change.status === 'complete') onLoaded();
  };
  chrome.tabs.onUpdated.addListener(listener);
  return () => chrome.tabs.onUpdated.removeListener(listener);
}

/** Every tab, in outline order, for "Refresh previews", and Tab Hammer's own window (left out). */
export async function refreshCandidates(): Promise<{
  tabs: RefreshTab[];
  ownWindowId: number | null;
}> {
  const [tabs, own] = await Promise.all([chrome.tabs.query({}), chrome.windows.getCurrent()]);
  return { tabs: tabs.flatMap((t) => toRefreshTab(t) ?? []), ownWindowId: own.id ?? null };
}

/** The tab as it is now, or undefined if it closed. */
export async function refreshTab(tabId: number): Promise<RefreshTab | undefined> {
  return toRefreshTab(await chrome.tabs.get(tabId).catch(() => undefined));
}

function toRefreshTab(t: chrome.tabs.Tab | undefined): RefreshTab | undefined {
  if (t?.id === undefined) return undefined;
  return {
    id: t.id,
    windowId: t.windowId,
    url: t.url,
    discarded: t.discarded,
    status: t.status,
    incognito: t.incognito,
  };
}

/** When the page at `url` was last captured, if ever. */
export async function previewCapturedAt(url: string): Promise<number | undefined> {
  return (await getPreview(url))?.capturedAt;
}
