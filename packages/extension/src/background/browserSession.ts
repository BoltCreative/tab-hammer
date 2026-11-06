// An ID for the current browser session, so a swap record (see debuggerCapture.ts) is only acted
// on in the browser session that made it: tab and window IDs are reused after a browser restart.
// It lives in chrome.storage.local, so it survives extension reloads and updates (the usual way a
// swap gets interrupted during development), and is renewed from runtime.onStartup, which fires
// when the browser launches but not when the extension reloads.
//
// On a browser launch, other events (the preview panel's capture request) can reach the service
// worker before onStartup does, and would read the previous session's ID. So the ID is only handed
// out once this session is confirmed: by a marker in chrome.storage.session (in memory, so gone
// after a browser restart, and also after an extension reload or disable), or by onStartup or
// onInstalled firing (onInstalled for a Chrome update or an install starts a new session too, see
// installed()). Without the marker, current() waits for one of those. If neither comes (the
// extension was re-enabled, which fires nothing), it starts a new session after a few seconds:
// dropping an old swap record is safe, acting on a stale one is not.

export interface KeyValueStore {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

export const BROWSER_SESSION_KEY = 'browserSession';
/** In chrome.storage.session: set once this browser session's ID is known to be current. */
export const SESSION_CONFIRMED_KEY = 'browserSessionConfirmed';
/** How long current() waits for onStartup/onInstalled before starting a new session itself. */
export const LAUNCH_EVENT_WAIT_MS = 5000;

export interface BrowserSession {
  /** This browser session's ID; waits until it's known to be current. */
  current(): Promise<string>;
  /** runtime.onStartup: the browser launched, so start a new session. */
  launched(): Promise<void>;
  /**
   * runtime.onInstalled with its reason. An extension reload or update ('update') happens within
   * the session, so the ID is kept. 'chrome_update' means Chrome just launched, and 'install'
   * either comes with no earlier session at all or means Chrome re-installed the extension at
   * launch (one loaded with --load-extension, as the e2e tests run it, gets no onStartup): both
   * start a new session, so a launch is recognized even when onInstalled beats onStartup.
   */
  installed(reason: string): Promise<void>;
}

export function createBrowserSession(opts: {
  /** chrome.storage.local */
  local: KeyValueStore;
  /** chrome.storage.session */
  session: KeyValueStore;
  newId: () => string;
  waitMs?: number;
  setTimer?: (fn: () => void, ms: number) => void;
}): BrowserSession {
  const waitMs = opts.waitMs ?? LAUNCH_EVENT_WAIT_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));

  let confirm!: () => void;
  const confirmedByEvent = new Promise<void>((r) => (confirm = r));
  let confirmed: Promise<void> | undefined;

  // The marker records why the session is confirmed: 'renewed' once a launch (or the give-up
  // timer) started this browser session's ID, 'kept' when only an extension update or reload has
  // vouched for the stored one. A launch event still renews over 'kept': an update applied at
  // browser launch fires onInstalled('update') next to onStartup, in either order.
  type Marker = 'renewed' | 'kept';
  const readMarker = async (): Promise<Marker | undefined> => {
    const { [SESSION_CONFIRMED_KEY]: marker } = await opts.session
      .get(SESSION_CONFIRMED_KEY)
      .catch(() => ({}) as Record<string, unknown>);
    return marker === 'renewed' || marker === 'kept' ? marker : undefined;
  };
  const mark = (marker: Marker) => opts.session.set({ [SESSION_CONFIRMED_KEY]: marker });
  const renew = async () => {
    await opts.local.set({ [BROWSER_SESSION_KEY]: opts.newId() });
  };

  // Launch events reaching this worker run one at a time, so two of them can't both see an
  // unconfirmed session and both renew. current() waits for every event already queued, so it
  // never hands out an ID a queued launch event is about to replace.
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  const serialized = (step: () => Promise<void>) => {
    queued++;
    const run = chain.then(step).finally(() => {
      if (--queued === 0) confirm();
    });
    chain = run.catch(() => {});
    return run;
  };
  /** onStartup, or an onInstalled that means the browser launched. */
  const launchStep = async () => {
    if ((await readMarker()) !== 'renewed') {
      await renew();
      await mark('renewed');
    }
  };

  const whenConfirmed = () =>
    (confirmed ??= (async () => {
      if ((await readMarker()) !== undefined) return;
      const gaveUp = new Promise<'timeout'>((r) => setTimer(() => r('timeout'), waitMs));
      if ((await Promise.race([confirmedByEvent, gaveUp])) === 'timeout') {
        // No launch event came: start a new session, unless one arrived meanwhile.
        await serialized(async () => {
          if ((await readMarker()) === undefined) {
            await renew();
            await mark('renewed');
          }
        });
      }
    })());

  return {
    async current() {
      await whenConfirmed();
      await chain; // a launch event already queued in this worker may still renew
      const { [BROWSER_SESSION_KEY]: id } = await opts.local.get(BROWSER_SESSION_KEY);
      if (typeof id === 'string') return id;
      await renew(); // first use, e.g. right after install
      const { [BROWSER_SESSION_KEY]: fresh } = await opts.local.get(BROWSER_SESSION_KEY);
      return fresh as string;
    },
    launched: () => serialized(launchStep),
    installed: (reason) =>
      serialized(async () => {
        if (reason === 'install' || reason === 'chrome_update') return launchStep();
        if ((await readMarker()) === undefined) await mark('kept');
      }),
  };
}
