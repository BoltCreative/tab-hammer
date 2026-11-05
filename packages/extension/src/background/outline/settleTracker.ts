// Debounces per-window churn: a window "settles" once nothing has touched any tracked window for
// SETTLE_QUIET_MS. One shared timer; every touch restarts it, and all pending windows settle together.
export const SETTLE_QUIET_MS = 1500;

export interface SettleTracker {
  touch(chromeWindowId: number): void;
  forget(chromeWindowId: number): void;
}

export function createSettleTracker(opts: {
  onSettled: (chromeWindowIds: number[]) => void;
  quietMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): SettleTracker {
  const quietMs = opts.quietMs ?? SETTLE_QUIET_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const ids = new Set<number>();
  let handle: unknown;
  let armed = false;

  function disarm() {
    if (armed) clearTimer(handle);
    armed = false;
  }
  function arm() {
    disarm();
    armed = true;
    handle = setTimer(() => {
      armed = false;
      const settled = [...ids];
      ids.clear();
      opts.onSettled(settled);
    }, quietMs);
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
  };
}
