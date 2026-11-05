// Runs async jobs one at a time, in order, each behind a successful `init`. A failed init is
// retried by the next job; a failed job is reported and the queue moves on.

export interface JobQueue {
  /** Queues `job`; the returned promise settles with it. */
  enqueue<T>(job: () => Promise<T>): Promise<T>;
  /**
   * A scheduler for `job` that keeps at most one run queued and not yet started: calls while one
   * is waiting are folded into it.
   */
  coalesced(job: () => Promise<void>): () => void;
  /** Resolves once nothing is queued or running. */
  idle(): Promise<void>;
}

export function createJobQueue(opts: {
  init: () => Promise<void>;
  onError: (err: unknown) => void;
}): JobQueue {
  let tail: Promise<void> = Promise.resolve();
  let initialized = false;

  function run<T>(job: () => Promise<T>, onStart?: () => void): Promise<T> {
    const result = tail.then(async () => {
      onStart?.(); // before init, so a failing init can't leave the job marked as waiting
      if (!initialized) {
        await opts.init();
        initialized = true;
      }
      return job();
    });
    tail = result.then(() => undefined, opts.onError);
    return result;
  }

  return {
    enqueue: (job) => run(job),
    coalesced(job) {
      let waiting = false;
      return () => {
        if (waiting) return;
        waiting = true;
        void run(job, () => (waiting = false));
      };
    },
    async idle() {
      for (;;) {
        const t = tail;
        await t;
        if (t === tail) return;
      }
    },
  };
}
