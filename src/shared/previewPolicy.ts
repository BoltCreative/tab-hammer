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
