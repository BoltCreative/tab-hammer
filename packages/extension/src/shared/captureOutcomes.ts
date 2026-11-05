// The outcome of the latest preview capture attempt per window (captures of a window's visible
// tab) and per tab (on-demand captures from the preview panel), kept in chrome.storage.session by
// the service worker so the preview panel can say why a tab has no preview without DevTools.

/** 'saved', `skipped:<reason>` (a rule declined the capture), or `error:<stage>: <message>`. */
export type CaptureOutcome = 'saved' | `skipped:${string}` | `error:${string}`;

export interface OutcomeEntry {
  at: number; // ms since epoch
  outcome: CaptureOutcome;
  url?: string; // the page it was for (on-demand tab outcomes)
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

/** Short text for a known `skipped:<reason>` outcome. */
const SKIP_TEXT: Record<string, string> = {
  'no-permission': "Preview permissions haven't been granted yet",
  incognito: 'Incognito tabs are never captured',
  'not-normal-window': "This kind of window can't be previewed",
  minimized: 'Preview paused while the window is minimized',
  'own-window': "Tab Hammer doesn't preview its own window",
  'no-tab': "Couldn't find the tab to capture",
  'not-loaded-yet': 'Page had not finished loading yet',
  'not-capturable-url': 'Chrome doesn’t allow previews of this page',
  'changed-during-capture': 'Page changed while it was being captured',
  discarded: 'Tab is asleep — open it once to get a preview',
  'background-tab': 'Background tab — Refresh stale (in the ⋯ menu) captures it',
  'swap-pending': "Already refreshing this tab's preview",
  superseded: 'Skipped to keep up with your cursor — hover again',
};

/**
 * Ordered rules matched against the free-text detail that follows `error:` (or an unrecognized
 * `skipped:` reason), for outcomes whose message comes from Chrome/CDP rather than our own code.
 * The first match wins.
 */
const DETAIL_RULES: { test: RegExp; text: string }[] = [
  {
    test: /chrome-extension:\/\/.*different extension/i,
    text: "Another extension's content on this page blocks previews",
  },
  {
    test: /another debugger is already attached/i,
    text: 'DevTools or another tool is inspecting this tab',
  },
  { test: /-32603|internal error/i, text: "Chrome couldn't draw this page" },
  { test: /timed out|gave up/i, text: 'Page took too long to draw' },
  {
    test: /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/,
    text: 'Chrome is limiting captures right now — try again shortly',
  },
  {
    test: /no reply from the service worker/i,
    text: 'Lost touch with the extension — try again',
  },
];

/** Shown when nothing above recognizes the outcome; the raw detail stays available separately. */
const FALLBACK_TEXT = "Couldn't capture a preview";

/**
 * Maps a recorded capture outcome to a short, human sentence for the preview panel, in place of the
 * raw outcome code or Chrome/CDP error text. Table-driven: exact skip reasons map directly via
 * SKIP_TEXT; free-text detail (error messages, or an unrecognized skip reason) is matched against
 * DETAIL_RULES; anything else falls back to FALLBACK_TEXT.
 */
export function friendlyCaptureOutcome(outcome: CaptureOutcome): string {
  if (outcome === 'saved') return 'A preview was captured but isn’t available for this page';
  if (outcome.startsWith('skipped:')) {
    const text = SKIP_TEXT[outcome.slice('skipped:'.length)];
    if (text !== undefined) return text;
  }
  for (const rule of DETAIL_RULES) if (rule.test.test(outcome)) return rule.text;
  return FALLBACK_TEXT;
}

export interface OutcomeDescription {
  /** Short, friendly text: always safe to show as the preview panel's status line. */
  text: string;
  /** The raw outcome, kept for a tooltip (element `title`) so debugging detail isn't lost. */
  detail?: string;
}

/** The preview panel's one-line note for a tab with no preview (or no usable one). */
export function describeNoPreview(entry: OutcomeEntry | undefined): OutcomeDescription {
  if (!entry) return { text: 'No preview yet' };
  return { text: friendlyCaptureOutcome(entry.outcome), detail: entry.outcome };
}
