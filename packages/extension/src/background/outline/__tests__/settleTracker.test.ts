import { describe, expect, it } from 'vitest';
import { createSettleTracker, SETTLE_QUIET_MS } from '../settleTracker';

function harness() {
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const settled: number[][] = [];
  const tracker = createSettleTracker({
    onSettled: (ids) => settled.push(ids),
    setTimer: (fn, ms) => {
      const h = next++;
      timers.set(h, { fn, ms });
      return h;
    },
    clearTimer: (h) => timers.delete(h as number),
  });
  const fire = () => {
    const [h, t] = [...timers.entries()][0] ?? [];
    if (h === undefined || !t) throw new Error('no timer armed');
    timers.delete(h);
    t.fn();
  };
  return { tracker, timers, settled, fire };
}

describe('settle tracker', () => {
  it('settles all touched windows together once quiet', () => {
    const { tracker, timers, settled, fire } = harness();
    tracker.touch(1);
    tracker.touch(2);
    expect(timers.size).toBe(1);
    expect([...timers.values()][0]?.ms).toBe(SETTLE_QUIET_MS);
    expect(tracker.pending()).toEqual([1, 2]);
    fire();
    expect(settled).toEqual([[1, 2]]);
    expect(tracker.pending()).toEqual([]);
  });

  it('a touch restarts the quiet period', () => {
    const { tracker, timers } = harness();
    tracker.touch(1);
    const first = [...timers.keys()][0];
    tracker.touch(1);
    expect(timers.size).toBe(1);
    expect([...timers.keys()][0]).not.toBe(first);
  });

  it('a forgotten window is not reported', () => {
    const { tracker, timers, settled, fire } = harness();
    tracker.touch(1);
    tracker.touch(2);
    tracker.forget(1);
    fire();
    expect(settled).toEqual([[2]]);
    tracker.touch(3);
    tracker.forget(3);
    expect(timers.size).toBe(0);
    expect(settled).toEqual([[2]]);
  });
});
