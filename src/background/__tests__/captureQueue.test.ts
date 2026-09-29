import { describe, expect, it } from 'vitest';
import { createCaptureQueue } from '../captureQueue';

/** A queue whose runs finish only when the test says so. */
function setup(maxWaiting = 3) {
  const started: number[] = [];
  const finishers = new Map<number, (r: string) => void>();
  let active = 0;
  let maxActive = 0;
  const queue = createCaptureQueue<number, string>({
    run: (key) => {
      started.push(key);
      maxActive = Math.max(maxActive, ++active);
      return new Promise<string>((resolve) =>
        finishers.set(key, (r) => {
          active--;
          resolve(r);
        }),
      );
    },
    dropped: 'dropped',
    failed: () => 'failed',
    maxWaiting,
  });
  const finish = async (key: number, result = `shot ${key}`) => {
    finishers.get(key)!(result);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { queue, started, finish, maxActive: () => maxActive };
}

describe('createCaptureQueue', () => {
  it('runs one capture at a time, in request order', async () => {
    const { queue, started, finish, maxActive } = setup();
    const a = queue.request(1);
    const b = queue.request(2);
    expect(started).toEqual([1]);
    await finish(1);
    expect(started).toEqual([1, 2]);
    await finish(2);
    await expect(a).resolves.toBe('shot 1');
    await expect(b).resolves.toBe('shot 2');
    expect(maxActive()).toBe(1);
  });

  it('shares one capture between repeated requests for a tab, waiting or in flight', async () => {
    const { queue, started, finish } = setup();
    const running = [queue.request(1), queue.request(1)];
    const waiting = [queue.request(2), queue.request(2)];
    await finish(1);
    await finish(2);
    expect(started).toEqual([1, 2]);
    expect(await Promise.all(running)).toEqual(['shot 1', 'shot 1']);
    expect(await Promise.all(waiting)).toEqual(['shot 2', 'shot 2']);
  });

  it('keeps only the most recent waiting requests when they pile up', async () => {
    const { queue, started, finish } = setup(2);
    queue.request(1); // running
    const stale = queue.request(2);
    queue.request(3);
    queue.request(4); // pushes out 2
    await expect(stale).resolves.toBe('dropped');
    await finish(1);
    await finish(3);
    await finish(4);
    expect(started).toEqual([1, 3, 4]);
  });

  it('turns a rejected run into the failed result and moves on', async () => {
    const queue = createCaptureQueue<number, string>({
      run: async (key) => {
        if (key === 1) throw new Error('boom');
        return 'ok';
      },
      dropped: 'dropped',
      failed: (err) => `failed: ${(err as Error).message}`,
      maxWaiting: 3,
    });
    await expect(queue.request(1)).resolves.toBe('failed: boom');
    await expect(queue.request(2)).resolves.toBe('ok');
  });
});
