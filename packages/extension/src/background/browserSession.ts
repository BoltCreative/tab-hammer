// An ID for the current browser session, so a swap record (see debuggerCapture.ts) is only acted
// on in the browser session that made it: tab and window IDs are reused after a browser restart.
// It lives in chrome.storage.local, so it survives extension reloads and updates (the usual way a
// swap gets interrupted during development), and is renewed from runtime.onStartup, which fires
// when the browser launches but not when the extension reloads.

export interface KeyValueStore {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

export const BROWSER_SESSION_KEY = 'browserSession';

export function createBrowserSession(store: KeyValueStore, newId: () => string) {
  return {
    /** The current session's ID, created on first use (e.g. right after install). */
    async current(): Promise<string> {
      const { [BROWSER_SESSION_KEY]: id } = await store.get(BROWSER_SESSION_KEY);
      if (typeof id === 'string') return id;
      return this.renew();
    },
    /** Starts a new session. Call from runtime.onStartup. */
    async renew(): Promise<string> {
      const id = newId();
      await store.set({ [BROWSER_SESSION_KEY]: id });
      return id;
    },
  };
}
