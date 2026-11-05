import { describe, expect, it } from 'vitest';
import { createJobQueue } from '../jobQueue';

describe('createJobQueue', () => {
  it('folds a burst of scheduled runs into one', async () => {
    const q = createJobQueue({ init: async () => {}, onError: () => {} });
    let runs = 0;
    const schedule = q.coalesced(async () => void runs++);
    schedule();
    schedule();
    schedule();
    await q.idle();
    expect(runs).toBe(1);
    schedule();
    await q.idle();
    expect(runs).toBe(2);
  });

  it('retries init on the next job after it fails, and coalesced runs keep working', async () => {
    const errors: unknown[] = [];
    let initCalls = 0;
    const q = createJobQueue({
      init: async () => {
        initCalls++;
        if (initCalls === 1) throw new Error('db unavailable');
      },
      onError: (err) => errors.push(err),
    });
    let runs = 0;
    const schedule = q.coalesced(async () => void runs++);

    schedule(); // init fails; this run is lost
    await q.idle();
    expect(runs).toBe(0);
    expect(errors).toHaveLength(1);

    schedule(); // not swallowed by the failed run's leftover state
    await q.idle();
    expect(initCalls).toBe(2);
    expect(runs).toBe(1);
  });

  it('runs jobs in order and keeps going after one fails', async () => {
    const q = createJobQueue({ init: async () => {}, onError: () => {} });
    const order: number[] = [];
    const first = q.enqueue(async () => {
      order.push(1);
      throw new Error('boom');
    });
    const second = q.enqueue(async () => {
      order.push(2);
      return 'ok';
    });
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    expect(order).toEqual([1, 2]);
  });
});
