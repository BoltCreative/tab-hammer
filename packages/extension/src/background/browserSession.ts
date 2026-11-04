// An ID for the current browser session, so a swap record (see debuggerCapture.ts) is only acted
// on in the browser session that made it: tab and window IDs are reused after a browser restart.
// It lives in chrome.storage.local, so it survives extension reloads and updates (the usual way a
// swap gets interrupted during development), and is renewed from runtime.onStartup, which fires
// when the browser launches but not when the extension reloads.
//
// On a browser launch, other events (a hover card's capture request) can reach the service worker
// before onStartup does, and would read the previous session's ID. So the ID is only handed out
// once this session is confirmed: by a marker in chrome.storage.session (in memory, so gone after a
// browser restart, and also after an extension reload or disable), or by onStartup or onInstalled
// firing (onInstalled for a Chrome update or an install starts a new session too, see
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

  const markConfirmed = () => opts.session.set({ [SESSION_CONFIRMED_KEY]: true });
  const renew = async () => {
    await opts.local.set({ [BROWSER_SESSION_KEY]: opts.newId() });
  };

  const whenConfirmed = () =>
    (confirmed ??= (async () => {
      const { [SESSION_CONFIRMED_KEY]: marker } = await opts.session
        .get(SESSION_CONFIRMED_KEY)
        .catch(() => ({}) as Record<string, unknown>);
      if (marker === true) return;
      const gaveUp = new Promise<'timeout'>((r) => setTimer(() => r('timeout'), waitMs));
      if ((await Promise.race([confirmedByEvent, gaveUp])) === 'timeout') {
        await renew();
        await markConfirmed();
      }
    })());

  // A launch event renews only while this session isn't confirmed yet, so a second launch event
  // (onInstalled then onStartup, possibly in a new worker instance) or a current() that already
  // gave up waiting never starts a second session for the same launch.
  const isConfirmed = async () => {
    const { [SESSION_CONFIRMED_KEY]: marker } = await opts.session
      .get(SESSION_CONFIRMED_KEY)
      .catch(() => ({}) as Record<string, unknown>);
    return marker === true;
  };

  return {
    async current() {
      await whenConfirmed();
      const { [BROWSER_SESSION_KEY]: id } = await opts.local.get(BROWSER_SESSION_KEY);
      if (typeof id === 'string') return id;
      await renew(); // first use, e.g. right after install
      const { [BROWSER_SESSION_KEY]: fresh } = await opts.local.get(BROWSER_SESSION_KEY);
      return fresh as string;
    },
    async launched() {
      if (!(await isConfirmed())) await renew();
      await markConfirmed();
      confirm();
    },
    async installed(reason) {
      if ((reason === 'install' || reason === 'chrome_update') && !(await isConfirmed())) {
        await renew();
      }
      await markConfirmed();
      confirm();
    },
  };
}
