// The outcome of the latest preview capture attempt per window (captures of a window's visible
// tab) and per tab (on-demand captures from the hover card), kept in chrome.storage.session by
// the service worker so the hover card can say why a tab has no preview without DevTools.

/** 'saved', `skipped:<reason>` (a rule declined the capture), or `error:<stage>: <message>`. */
export type CaptureOutcome = 'saved' | `skipped:${string}` | `error:${string}`;

export interface OutcomeEntry {
  at: number; // ms since epoch
  outcome: CaptureOutcome;
}

/** Keyed by window ID (OUTCOMES_KEY) or tab ID (TAB_OUTCOMES_KEY). */
export type OutcomeMap = Record<string, OutcomeEntry>;

export const OUTCOMES_KEY = 'captureOutcomes';
export const TAB_OUTCOMES_KEY = 'tabCaptureOutcomes';
export const MAX_OUTCOMES = 20;
const MAX_MESSAGE = 200;

/** Returns `map` with one window's (or tab's) outcome replaced, keeping only the newest `max`. */
export function withOutcome(
  map: OutcomeMap,
  id: number,
  entry: OutcomeEntry,
  max = MAX_OUTCOMES,
): OutcomeMap {
  const next = { ...map, [id]: { ...entry, outcome: clip(entry.outcome) } };
  const newest = Object.entries<OutcomeEntry>(next)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, max);
  return Object.fromEntries(newest) as OutcomeMap;
}

function clip(outcome: CaptureOutcome): CaptureOutcome {
  return outcome.length > MAX_MESSAGE
    ? (`${outcome.slice(0, MAX_MESSAGE)}…` as CaptureOutcome)
    : outcome;
}

/** The more recent of two entries (e.g. a tab's own outcome and its window's). */
export function newerOutcome(
  a: OutcomeEntry | undefined,
  b: OutcomeEntry | undefined,
): OutcomeEntry | undefined {
  if (!a || !b) return a ?? b;
  return b.at > a.at ? b : a;
}

/** The hover card's one-line note for a tab with no preview. */
export function describeNoPreview(entry: OutcomeEntry | undefined): string {
  if (!entry) return 'No preview yet · no capture attempted in this window';
  const { outcome } = entry;
  let what: string;
  if (outcome === 'saved') what = 'saved';
  else if (outcome.startsWith('skipped:')) {
    what = `skipped (${outcome.slice('skipped:'.length).replaceAll('-', ' ')})`;
  } else what = `failed (${outcome.slice('error:'.length)})`;
  return `No preview yet · last capture: ${what}`;
}
