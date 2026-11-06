// Pure rules for the preview store: what key a page is stored under, and what to evict (a preview
// lives exactly as long as this computer's outline uses its address).

/**
 * The store key for a page. Previews are keyed by URL rather than tab ID so they survive a
 * browser restart (tab IDs are reassigned; restored tabs keep their URLs). The #fragment is
 * dropped because it rarely changes what the page looks like; the query string is kept.
 */
export function previewKey(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * The preview keys this computer's outline uses: every tab of every window record, live,
 * hibernated, or in the trash (Recently closed), plus the pages Chrome has open right now (a
 * capture can be saved before the outline has reconciled its tab's new address). Other computers'
 * synced outlines don't count.
 */
export function referencedKeys(
  windows: readonly { tabs: readonly { url: string }[] }[],
  openUrls: readonly string[],
): Set<string> {
  const keys = new Set<string>();
  for (const w of windows) for (const t of w.tabs) keys.add(previewKey(t.url));
  for (const url of openUrls) keys.add(previewKey(url));
  return keys;
}

/**
 * Keys to delete: previews no record references. A preview is kept exactly as long as the outline
 * uses its address, however old it is, so there's no age or size limit. One saved at or after
 * `since` (when the caller read the outline and Chrome's tabs) is kept too: its tab may have
 * reached that address after the read.
 */
export function pickEvictions(
  entries: readonly { key: string; capturedAt: number }[],
  referenced: ReadonlySet<string>,
  since: number,
): string[] {
  return entries.filter((e) => e.capturedAt < since && !referenced.has(e.key)).map((e) => e.key);
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

/**
 * Whether showing the tab in the preview panel should ask the service worker for a shot of it: it
 * has no preview, and its page is one Chrome lets an extension capture. A preview never goes
 * stale: it is how the page looked the last time the user had it on screen (Tab Hammer captures a
 * window's visible tab as they browse), so an old one is kept, not retaken.
 * Only a window's active (on-screen) tab qualifies: a hover never attaches the debugger, since
 * its infobar shifts the outline under the pointer, so background tabs wait for a Refresh run.
 * The preview is looked up by the tab's current URL, so one of another page never counts.
 */
export function wantsOnDemandCapture(
  tab: { url: string; discarded: boolean; active: boolean },
  capturedAt: number | undefined,
): boolean {
  if (!tab.active || tab.discarded || !isCapturableUrl(tab.url)) return false;
  return capturedAt === undefined;
}
