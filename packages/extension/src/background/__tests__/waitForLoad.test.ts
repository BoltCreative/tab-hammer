import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoadWaiter } from '../waitForLoad';

function event<A extends unknown[]>() {
  const listeners = new Set<(...args: A) => void>();
  return {
    addListener: (cb: (...args: A) => void) => void listeners.add(cb),
    removeListener: (cb: (...args: A) => void) => void listeners.delete(cb),
    emit: (...args: A) => listeners.forEach((cb) => cb(...args)),
    count: () => listeners.size,
  };
}

function setup(status = 'loading') {
  const onUpdated = event<[number, { status?: string }]>();
  const onRemoved = event<[number]>();
  const wait = createLoadWaiter({ onUpdated, onRemoved, getStatus: async () => status });
  return { wait, onUpdated, onRemoved };
}

afterEach(() => vi.useRealTimers());

describe('createLoadWaiter', () => {
  it('resolves true when the tab finishes loading, ignoring other tabs', async () => {
    const { wait, onUpdated } = setup();
    const done = wait(5, 8000);
    await Promise.resolve();
    onUpdated.emit(6, { status: 'complete' });
    onUpdated.emit(5, { status: 'complete' });
    await expect(done).resolves.toBe(true);
    expect(onUpdated.count()).toBe(0);
  });

  it('resolves true at once for a tab that is already loaded', async () => {
    await expect(setup('complete').wait(5, 8000)).resolves.toBe(true);
  });

  it('finishes early, false, if the tab is closed while loading', async () => {
    const { wait, onRemoved } = setup();
    const done = wait(5, 8000);
    onRemoved.emit(5);
    await expect(done).resolves.toBe(false);
    expect(onRemoved.count()).toBe(0);
  });

  it('gives up, false, after the time limit', async () => {
    vi.useFakeTimers();
    const { wait } = setup();
    const done = wait(5, 8000);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(done).resolves.toBe(false);
  });
});
