// Runtime messages between the view and the service worker.
import type { CaptureOutcome } from './captureOutcomes';

/** View → service worker: capture this tab now for its hover card. */
export interface CaptureTabRequest {
  type: 'tabHammer.captureTab';
  tabId: number;
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
