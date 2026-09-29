// Runs on-demand tab captures one at a time. Hovering down a list of tabs fires a request per
// card, so requests for a tab already waiting or in flight share its result, and when too many
// pile up the oldest waiting ones are dropped: the user has moved on from those cards.

export interface CaptureQueue<K, R> {
  /** Resolves with the capture's result, or with `dropped` if the request was pushed out. */
  request(key: K): Promise<R>;
}

export function createCaptureQueue<K, R>(opts: {
  run: (key: K) => Promise<R>;
  /** Result for a request dropped before it ran, and for a run that rejected. */
  dropped: R;
  failed: (err: unknown) => R;
  /** Most requests allowed to wait (not counting the one running). */
  maxWaiting: number;
}): CaptureQueue<K, R> {
  interface Entry {
    key: K;
    promise: Promise<R>;
    resolve: (r: R) => void;
  }
  const waiting: Entry[] = [];
  let running: Entry | null = null;

  const pump = () => {
    if (running || waiting.length === 0) return;
    const entry = waiting.shift()!;
    running = entry;
    opts
      .run(entry.key)
      .catch(opts.failed)
      .then((result) => {
        running = null;
        entry.resolve(result);
        pump();
      });
  };

  return {
    request(key) {
      const existing = running?.key === key ? running : waiting.find((e) => e.key === key);
      if (existing) return existing.promise;
      let resolve!: (r: R) => void;
      const promise = new Promise<R>((r) => (resolve = r));
      waiting.push({ key, promise, resolve });
      while (waiting.length > opts.maxWaiting) waiting.shift()!.resolve(opts.dropped);
      pump();
      return promise;
    },
  };
}
