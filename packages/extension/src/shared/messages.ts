// Runtime messages between the view and the service worker.
import type { CaptureOutcome } from './captureOutcomes';

/** View → service worker: capture this tab now (for its hover card, or a Refresh run). */
export interface CaptureTabRequest {
  type: 'tabHammer.captureTab';
  tabId: number;
  /**
   * May attach chrome.debugger to capture a tab that isn't on screen. Its "started debugging this
   * browser" infobar shifts the outline, so only the explicit Refresh runs set it; never a hover.
   */
  allowDebugger?: boolean;
}

/** The service worker's reply, once the capture has finished (or was skipped or dropped). */
export interface CaptureTabReply {
  outcome: CaptureOutcome;
}

export const CAPTURE_TAB = 'tabHammer.captureTab' as const;

export function isCaptureTabRequest(msg: unknown): msg is CaptureTabRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === CAPTURE_TAB &&
    typeof (msg as { tabId?: unknown }).tabId === 'number'
  );
}

/** View → service worker: delete every stored preview and capture outcome (a debug tool). */
export const CLEAR_PREVIEWS = 'tabHammer.clearPreviews' as const;
export interface ClearPreviewsRequest {
  type: typeof CLEAR_PREVIEWS;
}

export function isClearPreviewsRequest(msg: unknown): msg is ClearPreviewsRequest {
  return (
    typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === CLEAR_PREVIEWS
  );
}
