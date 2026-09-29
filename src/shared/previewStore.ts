// Page screenshots for the hover preview, in IndexedDB keyed by normalized page URL (see
// previewKey), so they survive a browser restart and are shared by tabs on the same page.
// The service worker writes and prunes; the view reads.
import { pickEvictions, previewKey } from './previewPolicy';

export interface Preview {
  key: string; // previewKey(url)
  capturedAt: number; // ms since epoch
  image: Blob; // downscaled JPEG
  width: number;
  height: number;
}

const DB_NAME = 'tab-hammer-previews';
const STORE = 'previews';
const BY_CAPTURED_AT = 'capturedAt';

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () =>
      req.result
        .createObjectStore(STORE, { keyPath: 'key' })
        .createIndex(BY_CAPTURED_AT, 'capturedAt');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err: unknown) => {
    dbPromise = null; // let the next call retry
    throw err;
  });
  return dbPromise;
}

/** Runs `op` in one transaction and resolves with its result once the transaction commits. */
async function run<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => () => T,
): Promise<T> {
  const tx = (await db()).transaction(STORE, mode);
  const result = op(tx.objectStore(STORE));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(result());
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** The latest preview of the page at `url` (any tab, any session), if one was captured. */
export function getPreview(url: string): Promise<Preview | undefined> {
  return run('readonly', (s) => {
    const req = s.get(previewKey(url)) as IDBRequest<Preview | undefined>;
    return () => req.result;
  });
}

export function putPreview(url: string, shot: Omit<Preview, 'key'>): Promise<void> {
  return run('readwrite', (s) => {
    s.put({ ...shot, key: previewKey(url) });
    return () => undefined;
  });
}

/** Applies the age and size limits (see pickEvictions). Reads only keys, never the images. */
export async function prunePreviews(now = Date.now()): Promise<void> {
  const entries = await run('readonly', (s) => {
    const found: { key: string; capturedAt: number }[] = [];
    const req = s.index(BY_CAPTURED_AT).openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      found.push({ key: cursor.primaryKey as string, capturedAt: cursor.key as number });
      cursor.continue();
    };
    return () => found;
  });
  const evict = pickEvictions(entries, now);
  if (evict.length === 0) return;
  await run('readwrite', (s) => {
    evict.forEach((k) => s.delete(k));
    return () => undefined;
  });
}
