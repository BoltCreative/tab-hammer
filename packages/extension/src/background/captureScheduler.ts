// Decides when to screenshot a window's visible tab. Pure apart from the injected timer, so the
// debounce and rate-limit edge cases are unit-testable with fake timers.

export interface SchedulerOptions<R = unknown> {
  /** Wait this long after a window's last trigger, so the page has painted. */
  debounceMs: number;
  /** Minimum gap between capture starts (Chrome allows 2 captureVisibleTab calls per second). */
  minIntervalMs: number;
  /** Captures one window. Rejections are swallowed: a failed capture just means no preview. */
  capture: (windowId: number) => Promise<R>;
  /**
   * A capture still running after this long is given up on (its result counts as a failure), so
   * one Chrome call that never settles can't hold up every later capture, of every window.
   */
  captureTimeoutMs: number;
  now?: () => number;
}

export interface CaptureScheduler<R = unknown> {
  /** A window's visible tab may have changed; (re)start that window's debounce. */
  trigger(windowId: number): void;
  /**
   * Resolves with the result of the window's next capture to finish (undefined if it rejected).
   * Pair it with trigger() to capture a window on demand through the debounce and rate limit.
   */
  nextCapture(windowId: number): Promise<R | undefined>;
}

export function createCaptureScheduler<R = unknown>(
  opts: SchedulerOptions<R>,
): CaptureScheduler<R> {
  const now = opts.now ?? Date.now;
  const debounces = new Map<number, ReturnType<typeof setTimeout>>();
  const queue: number[] = []; // windows whose debounce has elapsed, in order, no duplicates
  let running = false;
  let waiting = false; // a rate-limit timer is pending
  let lastStart = -Infinity;
  const waiters = new Map<number, ((result: R | undefined) => void)[]>();
  const settle = (windowId: number, result: R | undefined) => {
    const list = waiters.get(windowId);
    waiters.delete(windowId);
    list?.forEach((resolve) => resolve(result));
  };

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), opts.captureTimeoutMs);
    });
    Promise.race([opts.capture(windowId).catch(() => undefined), gaveUp]).then((result) => {
      clearTimeout(timer);
      running = false;
      settle(windowId, result);
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
    nextCapture(windowId) {
      return new Promise((resolve) => {
        waiters.set(windowId, [...(waiters.get(windowId) ?? []), resolve]);
      });
    },
  };
}
