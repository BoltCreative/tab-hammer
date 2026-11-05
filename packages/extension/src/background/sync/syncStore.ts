// What the sync engine keeps on this computer: small flags in chrome.storage.local (the dirty flag
// among them), and in IndexedDB `tab-hammer-sync` the last file it pushed, its cache of other
// computers' files, and the local checkpoints.
import type { SyncFile } from '../../model/sync/schema';

export interface SyncFlags {
  dirty?: boolean; // the outline changed since the last successful push
  computerName?: string;
  selfRestorePending?: boolean; // the outline database started empty: check Drive before pushing
}

export interface CachedComputer {
  name: string; // its Drive file name
  installId: string;
  modifiedTime: number;
  file?: SyncFile; // absent when it failed validation
  problem?: 'newer' | 'malformed';
  reason?: string;
}

export interface StoredCheckpoint {
  id: string; // its file name
  checkpointAt: number;
  drastic: boolean;
  file: SyncFile;
}

export interface SyncStore {
  flags(): Promise<SyncFlags>;
  setFlags(patch: SyncFlags): Promise<void>;
  lastPushed(): Promise<SyncFile | undefined>;
  setLastPushed(file: SyncFile): Promise<void>;
  computers(): Promise<CachedComputer[]>;
  putComputer(c: CachedComputer): Promise<void>;
  deleteComputer(name: string): Promise<void>;
  checkpoints(): Promise<StoredCheckpoint[]>;
  putCheckpoint(c: StoredCheckpoint): Promise<void>;
  deleteCheckpoint(id: string): Promise<void>;
}

export function createMemorySyncStore(): SyncStore & { data: Record<string, unknown> } {
  let flags: SyncFlags = {};
  let last: SyncFile | undefined;
  const computers = new Map<string, CachedComputer>();
  const checkpoints = new Map<string, StoredCheckpoint>();
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    data: { computers, checkpoints },
    flags: async () => clone(flags),
    setFlags: async (patch) => void (flags = { ...flags, ...patch }),
    lastPushed: async () => clone(last),
    setLastPushed: async (f) => void (last = clone(f)),
    computers: async () => [...computers.values()].map(clone),
    putComputer: async (c) => void computers.set(c.name, clone(c)),
    deleteComputer: async (name) => void computers.delete(name),
    checkpoints: async () => [...checkpoints.values()].map(clone),
    putCheckpoint: async (c) => void checkpoints.set(c.id, clone(c)),
    deleteCheckpoint: async (id) => void checkpoints.delete(id),
  };
}

const FLAGS_KEY = 'sync';
const DB_NAME = 'tab-hammer-sync';
const STATE = 'state';
const COMPUTERS = 'computers';
const CHECKPOINTS = 'checkpoints';
const LAST_PUSHED = 'lastPushed';

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STATE);
      req.result.createObjectStore(COMPUTERS, { keyPath: 'name' });
      req.result.createObjectStore(CHECKPOINTS, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const conn = req.result;
      conn.onversionchange = () => {
        conn.close();
        dbPromise = null;
      };
      conn.onclose = () => {
        dbPromise = null;
      };
      resolve(conn);
    };
    req.onerror = () => reject(req.error);
  }).catch((err: unknown) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const tx = (await db()).transaction(store, mode);
  const req = op(tx.objectStore(store));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve((req ? req.result : undefined) as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** The real store: flags in chrome.storage.local (or the given area), the rest in IndexedDB. */
export function createSyncStore(
  local: Pick<chrome.storage.StorageArea, 'get' | 'set'> = chrome.storage.local,
): SyncStore {
  return {
    async flags() {
      const { [FLAGS_KEY]: v } = await local.get(FLAGS_KEY);
      return typeof v === 'object' && v !== null ? (v as SyncFlags) : {};
    },
    async setFlags(patch) {
      const current = await this.flags();
      await local.set({ [FLAGS_KEY]: { ...current, ...patch } });
    },
    lastPushed: () => run<SyncFile | undefined>(STATE, 'readonly', (s) => s.get(LAST_PUSHED)),
    setLastPushed: (f) => run(STATE, 'readwrite', (s) => void s.put(f, LAST_PUSHED)),
    computers: () => run<CachedComputer[]>(COMPUTERS, 'readonly', (s) => s.getAll()),
    putComputer: (c) => run(COMPUTERS, 'readwrite', (s) => void s.put(c)),
    deleteComputer: (name) => run(COMPUTERS, 'readwrite', (s) => void s.delete(name)),
    checkpoints: () => run<StoredCheckpoint[]>(CHECKPOINTS, 'readonly', (s) => s.getAll()),
    putCheckpoint: (c) => run(CHECKPOINTS, 'readwrite', (s) => void s.put(c)),
    deleteCheckpoint: (id) => run(CHECKPOINTS, 'readwrite', (s) => void s.delete(id)),
  };
}
