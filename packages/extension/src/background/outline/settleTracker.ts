// Debounces per-window churn: a window "settles" once nothing has touched any tracked window for
// SETTLE_QUIET_MS. One shared timer; every touch restarts it, and all pending windows settle together.
// With `quietMs: null` there is no timer: windows settle only on flush() (the e2e build, so a test
// settles them once Chrome has finished restoring, instead of racing a quiet period).
export const SETTLE_QUIET_MS = 1500;

export interface SettleTracker {
  touch(chromeWindowId: number): void;
  forget(chromeWindowId: number): void;
  /** Settles every pending window now. */
  flush(): void;
}

export function createSettleTracker(opts: {
  onSettled: (chromeWindowIds: number[]) => void;
  quietMs?: number | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): SettleTracker {
  const quietMs = opts.quietMs === undefined ? SETTLE_QUIET_MS : opts.quietMs;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const ids = new Set<number>();
  let handle: unknown;
  let armed = false;

  function disarm() {
    if (armed) clearTimer(handle);
    armed = false;
  }
  function settle() {
    armed = false;
    const settled = [...ids];
    ids.clear();
    if (settled.length > 0) opts.onSettled(settled);
  }
  function arm() {
    disarm();
    if (quietMs === null) return;
    armed = true;
    handle = setTimer(settle, quietMs);
  }

  return {
    touch(id) {
      ids.add(id);
      arm();
    },
    forget(id) {
      ids.delete(id);
      if (ids.size === 0) disarm();
    },
    flush() {
      disarm();
      settle();
    },
  };
}
