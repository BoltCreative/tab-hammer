// Decides when to screenshot a window's visible tab. Pure apart from the injected timer, so the
// debounce and rate-limit edge cases are unit-testable with fake timers.

export interface SchedulerOptions {
  /** Wait this long after a window's last trigger, so the page has painted. */
  debounceMs: number;
  /** Minimum gap between capture starts (Chrome allows 2 captureVisibleTab calls per second). */
  minIntervalMs: number;
  /** Captures one window. Rejections are swallowed: a failed capture just means no preview. */
  capture: (windowId: number) => Promise<void>;
  now?: () => number;
}

export interface CaptureScheduler {
  /** A window's visible tab may have changed; (re)start that window's debounce. */
  trigger(windowId: number): void;
}

export function createCaptureScheduler(opts: SchedulerOptions): CaptureScheduler {
  const now = opts.now ?? Date.now;
  const debounces = new Map<number, ReturnType<typeof setTimeout>>();
  const queue: number[] = []; // windows whose debounce has elapsed, in order, no duplicates
  let running = false;
  let waiting = false; // a rate-limit timer is pending
  let lastStart = -Infinity;

  const pump = () => {
    if (running || waiting || queue.length === 0) return;
    const wait = lastStart + opts.minIntervalMs - now();
    if (wait > 0) {
      waiting = true;
      setTimeout(() => {
        waiting = false;
        pump();
      }, wait);
      return;
    }
    const windowId = queue.shift()!;
    running = true;
    lastStart = now();
    opts
      .capture(windowId)
      .catch(() => {})
      .finally(() => {
        running = false;
        pump();
      });
  };

  return {
    trigger(windowId) {
      clearTimeout(debounces.get(windowId));
      debounces.set(
        windowId,
        setTimeout(() => {
          debounces.delete(windowId);
          if (!queue.includes(windowId)) queue.push(windowId);
          pump();
        }, opts.debounceMs),
      );
    },
  };
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
