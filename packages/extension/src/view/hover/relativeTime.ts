const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/** "just now", "5 minutes ago", "yesterday", … for a past timestamp in ms. */
export function relativeTime(then: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - then);
  for (const [unit, ms] of UNITS) {
    if (elapsed >= ms) return rtf.format(-Math.floor(elapsed / ms), unit);
  }
  return 'just now';
}
