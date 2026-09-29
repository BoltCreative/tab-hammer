// Talks to the service worker about preview captures: reads its record of the latest attempt for
// a tab and its window (see ../../shared/captureOutcomes.ts), so the hover card can say why a tab
// has no preview, and asks it to capture a tab on demand.
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

/**
 * The latest capture attempt that concerns this tab: its own on-demand one if it has one (it is
 * about this very tab), else its window's.
 */
export async function latestCaptureOutcome(
  windowId: number,
  tabId: number,
): Promise<OutcomeEntry | undefined> {
  const stored = await chrome.storage.session.get([OUTCOMES_KEY, TAB_OUTCOMES_KEY]);
  const pick = (map: unknown, id: number) =>
    map && typeof map === 'object' ? (map as OutcomeMap)[id] : undefined;
  return pick(stored[TAB_OUTCOMES_KEY], tabId) ?? pick(stored[OUTCOMES_KEY], windowId);
}

/** Asks the service worker to screenshot the tab now; resolves when it is done. */
export async function requestTabCapture(tabId: number): Promise<CaptureOutcome> {
  const reply = (await chrome.runtime.sendMessage({
    type: CAPTURE_TAB,
    tabId,
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
