// Each tab's launch URL (the first address Chrome created or committed it with), first one wins.
// Mirrored to chrome.storage.session so it survives the worker idling out between a tab's creation
// and its window settling; session storage ends with the browser session, as tab IDs do.
//
// One key per tab, so no write can clobber another tab's entry. Until the stored entries are
// loaded, nothing is written: a worker woken by a tab event notes that tab before it has read
// storage, and the stored entry (recorded first) must win.

export const LAUNCH_URL_PREFIX = 'launchUrl:';
const keyFor = (tabId: number) => `${LAUNCH_URL_PREFIX}${tabId}`;

export interface SessionStore {
  getAll: () => Promise<Record<string, unknown>>;
  set: (items: Record<string, string>) => Promise<void>;
  remove: (keys: string[]) => Promise<void>;
}

export interface LaunchUrls {
  readonly urls: ReadonlyMap<number, string>;
  note(tabId: number, url: string | undefined): void;
  forget(tabId: number): void;
  /** Reads the stored entries; later calls do nothing. */
  load(): Promise<void>;
}

export function createLaunchUrls(store: SessionStore, onError: (err: unknown) => void): LaunchUrls {
  const urls = new Map<number, string>();
  let loaded = false;
  let loading: Promise<void> | undefined;
  const removedBeforeLoad = new Set<number>();

  const quietly = (p: Promise<void>) => void p.catch(onError);

  async function load(): Promise<void> {
    const stored = await store.getAll();
    const fromStore = new Set<number>();
    for (const [key, url] of Object.entries(stored)) {
      if (!key.startsWith(LAUNCH_URL_PREFIX) || typeof url !== 'string') continue;
      const tabId = Number(key.slice(LAUNCH_URL_PREFIX.length));
      if (removedBeforeLoad.has(tabId)) continue;
      urls.set(tabId, url); // recorded first, so it wins over one noted since the worker woke
      fromStore.add(tabId);
    }
    const unsaved: Record<string, string> = {};
    for (const [tabId, url] of urls) if (!fromStore.has(tabId)) unsaved[keyFor(tabId)] = url;
    const gone = [...removedBeforeLoad].map(keyFor);
    removedBeforeLoad.clear();
    loaded = true;
    if (Object.keys(unsaved).length > 0) quietly(store.set(unsaved));
    if (gone.length > 0) quietly(store.remove(gone));
  }

  return {
    urls,
    note(tabId, url) {
      if (!url || urls.has(tabId)) return;
      urls.set(tabId, url);
      if (loaded) quietly(store.set({ [keyFor(tabId)]: url }));
    },
    forget(tabId) {
      const had = urls.delete(tabId);
      if (!loaded) removedBeforeLoad.add(tabId);
      else if (had) quietly(store.remove([keyFor(tabId)]));
    },
    load() {
      loading ??= load().catch((err: unknown) => {
        loading = undefined; // let a retried init try again
        throw err;
      });
      return loading;
    },
  };
}
