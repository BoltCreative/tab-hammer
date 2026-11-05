// Pure rules for the preview store: what key a page is stored under, and what to evict.

/**
 * The store key for a page. Previews are keyed by URL rather than tab ID so they survive a
 * browser restart (tab IDs are reassigned; restored tabs keep their URLs). The #fragment is
 * dropped because it rarely changes what the page looks like; the query string is kept.
 */
export function previewKey(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

export interface PruneLimits {
  maxEntries: number;
  maxAgeMs: number;
}

export const PRUNE_LIMITS: PruneLimits = { maxEntries: 1000, maxAgeMs: 30 * 24 * 60 * 60 * 1000 };

/**
 * Keys to delete: everything older than maxAgeMs, then the least recently captured entries
 * until at most maxEntries remain.
 */
export function pickEvictions(
  entries: readonly { key: string; capturedAt: number }[],
  now: number,
  limits: PruneLimits = PRUNE_LIMITS,
): string[] {
  const cutoff = now - limits.maxAgeMs;
  const expired = entries.filter((e) => e.capturedAt < cutoff).map((e) => e.key);
  const fresh = entries.filter((e) => e.capturedAt >= cutoff);
  const overflow = fresh.length - limits.maxEntries;
  if (overflow <= 0) return expired;
  const oldestFirst = fresh.slice().sort((a, b) => a.capturedAt - b.capturedAt);
  return [...expired, ...oldestFirst.slice(0, overflow).map((e) => e.key)];
}

const CAPTURABLE_SCHEMES = new Set(['http:', 'https:', 'file:']);

/**
 * Whether Chrome will let an extension screenshot a page at this URL. chrome://, extension pages,
 * about:, view-source:, devtools, data: URLs (refused even with <all_urls>) and the Chrome Web
 * Store are all skipped, so they don't spend the capture rate budget.
 */
export function isCapturableUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!CAPTURABLE_SCHEMES.has(parsed.protocol)) return false;
  if (parsed.hostname === 'chromewebstore.google.com') return false;
  return !(parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'));
}

/** A preview older than this is refreshed on demand when its hover card opens. */
export const STALE_PREVIEW_MS = 10 * 60 * 1000;

/**
 * Whether opening the hover card should ask the service worker for a fresh shot of the tab: it
 * has no preview, or only an old one, and its page is one Chrome lets an extension capture.
 * Only a window's active (on-screen) tab qualifies: a hover never attaches the debugger, since
 * its infobar shifts the outline under the pointer, so background tabs wait for a Refresh run.
 * The preview is looked up by the tab's current URL, so one of another page never counts.
 */
export function wantsOnDemandCapture(
  tab: { url: string; discarded: boolean; active: boolean },
  capturedAt: number | undefined,
  now: number,
): boolean {
  if (!tab.active || tab.discarded || !isCapturableUrl(tab.url)) return false;
  return capturedAt === undefined || now - capturedAt > STALE_PREVIEW_MS;
}
