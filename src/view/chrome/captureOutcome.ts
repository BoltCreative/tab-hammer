// Reads the service worker's record of each window's latest preview capture attempt (see
// ../../shared/captureOutcomes.ts), so the hover card can say why a tab has no preview.
import { OUTCOMES_KEY, type OutcomeEntry, type OutcomeMap } from '../../shared/captureOutcomes';

export async function latestCaptureOutcome(windowId: number): Promise<OutcomeEntry | undefined> {
  const { [OUTCOMES_KEY]: map } = await chrome.storage.session.get(OUTCOMES_KEY);
  return map && typeof map === 'object' ? (map as OutcomeMap)[windowId] : undefined;
}
