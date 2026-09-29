import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaptureScheduler } from '../captureScheduler';

// Fake timers also fake Date.now, which the scheduler uses as its clock.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(capture?: (windowId: number) => Promise<unknown>) {
  const starts: [windowId: number, at: number][] = [];
  const scheduler = createCaptureScheduler({
    debounceMs: 500,
    minIntervalMs: 550,
    capture: (windowId) => {
      starts.push([windowId, Date.now()]);
      return capture ? capture(windowId) : Promise.resolve();
    },
  });
  return { scheduler, starts };
}

describe('createCaptureScheduler', () => {
  it('captures once, debounceMs after the last of a burst of triggers for a window', async () => {
    const { scheduler, starts } = setup();
    const t0 = Date.now();
    scheduler.trigger(1);
    await vi.advanceTimersByTimeAsync(300);
    scheduler.trigger(1);
    await vi.advanceTimersByTimeAsync(300);
    scheduler.trigger(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(starts).toEqual([[1, t0 + 1100]]);
  });

  it('debounces each window independently', async () => {
    const { scheduler, starts } = setup();
    scheduler.trigger(1);
    await vi.advanceTimersByTimeAsync(100);
    scheduler.trigger(2);
    scheduler.trigger(1); // restarts window 1 only
    await vi.advanceTimersByTimeAsync(5000);
    expect(starts.map(([w]) => w)).toEqual([2, 1]);
  });

  it('spaces capture starts at least minIntervalMs apart to respect Chrome rate limit', async () => {
    const { scheduler, starts } = setup();
    for (const w of [1, 2, 3]) scheduler.trigger(w);
    await vi.advanceTimersByTimeAsync(5000);
    expect(starts.map(([w]) => w)).toEqual([1, 2, 3]);
    const [a, b, c] = starts.map(([, at]) => at);
    expect(b! - a!).toBeGreaterThanOrEqual(550);
    expect(c! - b!).toBeGreaterThanOrEqual(550);
  });

  it('never runs two captures at once, even when one outlasts the interval', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { scheduler, starts } = setup(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 2000));
      inFlight--;
    });
    scheduler.trigger(1);
    scheduler.trigger(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(starts.map(([w]) => w)).toEqual([1, 2]);
    expect(starts[1]![1] - starts[0]![1]).toBe(2000);
    expect(maxInFlight).toBe(1);
  });

  it('does not queue a window twice while it is waiting its turn', async () => {
    const { scheduler, starts } = setup();
    scheduler.trigger(1);
    scheduler.trigger(2);
    await vi.advanceTimersByTimeAsync(500); // 1 starts, 2 waits for the rate limit
    scheduler.trigger(2);
    await vi.advanceTimersByTimeAsync(0);
    // The re-trigger restarts 2's debounce; when it elapses, 2 is already queued — one capture.
    await vi.advanceTimersByTimeAsync(5000);
    expect(starts.map(([w]) => w).filter((w) => w === 2)).toHaveLength(1);
  });

  it('keeps going after a capture fails', async () => {
    const { scheduler, starts } = setup((w) =>
      w === 1 ? Promise.reject(new Error('nope')) : Promise.resolve(),
    );
    scheduler.trigger(1);
    scheduler.trigger(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(starts.map(([w]) => w)).toEqual([1, 2]);
  });

  it('nextCapture resolves with that window’s next capture result, or undefined if it failed', async () => {
    const { scheduler } = setup(async (w) => {
      if (w === 2) throw new Error('boom');
      return `shot of ${w}`;
    });
    const one = scheduler.nextCapture(1);
    const two = scheduler.nextCapture(2);
    scheduler.trigger(2);
    scheduler.trigger(1);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(one).resolves.toBe('shot of 1');
    await expect(two).resolves.toBeUndefined();
  });
});
