// The persisted outline in IndexedDB: one record per window (keyed by Tab Hammer's window ID) plus
// one meta record holding the schema version, the browser session it was last saved in, and the
// window order. Modelled on shared/previewStore.ts.
import type { GroupRec, Outline, TabRec, WindowRec } from '../../model/outline/types';

export const OUTLINE_SCHEMA_VERSION = 1;

export interface OutlineMeta {
  schemaVersion: number;
  sessionId: string;
  order: string[]; // window IDs
}

type SyncTab = Omit<TabRec, 'chromeTabId' | 'launchUrl' | 'liveAtClose'>;
type SyncGroup = Omit<GroupRec, 'chromeGroupId'>;
export type SyncWindow = Omit<
  WindowRec,
  'chromeWindowId' | 'provisional' | 'openAtShutdown' | 'bounds' | 'tabs' | 'groups'
> & { tabs: SyncTab[]; groups: SyncGroup[] };

const DB_NAME = 'tab-hammer-outline';
const WINDOWS = 'windows';
const META = 'meta';
const META_KEY = 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, OUTLINE_SCHEMA_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(WINDOWS, { keyPath: 'id' });
      req.result.createObjectStore(META);
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
    dbPromise = null; // let the next call retry
    throw err;
  });
  return dbPromise;
}

/** Runs `op` in one transaction over both stores; resolves with its result once the transaction commits. */
async function run<T>(
  mode: IDBTransactionMode,
  op: (windows: IDBObjectStore, meta: IDBObjectStore) => () => T,
): Promise<T> {
  const tx = (await db()).transaction([WINDOWS, META], mode);
  const result = op(tx.objectStore(WINDOWS), tx.objectStore(META));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(result());
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function loadOutline(): Promise<{ meta: OutlineMeta | undefined; outline: Outline }> {
  return run('readonly', (w, m) => {
    const all = w.getAll() as IDBRequest<WindowRec[]>;
    const meta = m.get(META_KEY) as IDBRequest<OutlineMeta | undefined>;
    return () => {
      const metaRec = meta.result;
      const byId = new Map(all.result.map((rec) => [rec.id, rec]));
      const windows: WindowRec[] = [];
      for (const id of metaRec?.order ?? []) {
        const rec = byId.get(id);
        if (rec) {
          windows.push(rec);
          byId.delete(id);
        }
      }
      windows.push(...byId.values()); // records the order missed (shouldn't happen), kept rather than lost
      return { meta: metaRec, outline: { windows } };
    };
  });
}

/** Writes windows of `next` that aren't (by reference) in `prev`, deletes ones gone, and the meta, in one transaction. */
export function saveOutline(prev: Outline, next: Outline, sessionId: string): Promise<void> {
  const prevSet = new Set<WindowRec>(prev.windows);
  const nextIds = new Set(next.windows.map((w) => w.id));
  return run('readwrite', (w, m) => {
    for (const rec of next.windows) if (!prevSet.has(rec)) w.put(rec);
    for (const rec of prev.windows) if (!nextIds.has(rec.id)) w.delete(rec.id);
    const meta: OutlineMeta = {
      schemaVersion: OUTLINE_SCHEMA_VERSION,
      sessionId,
      order: next.windows.map((rec) => rec.id),
    };
    m.put(meta, META_KEY);
    return () => undefined;
  });
}

function toSyncWindow(rec: WindowRec): SyncWindow {
  // Rebuilt field by field (not delete-from-copy) so a new machine-local field can't leak by default.
  const out: SyncWindow = {
    id: rec.id,
    state: rec.state,
    lastLiveAt: rec.lastLiveAt,
    originInstallId: rec.originInstallId,
    modifiedAt: rec.modifiedAt,
    tabs: rec.tabs.map((t) => {
      const tab: SyncTab = { id: t.id, url: t.url, title: t.title, modifiedAt: t.modifiedAt };
      if (t.groupId !== undefined) tab.groupId = t.groupId;
      return tab;
    }),
    groups: rec.groups.map((g) => ({
      id: g.id,
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
      modifiedAt: g.modifiedAt,
    })),
  };
  if (rec.name !== undefined) out.name = rec.name;
  if (rec.closedAt !== undefined) out.closedAt = rec.closedAt;
  return out;
}

/** The outline as plain JSON in outline order, minus fields that only mean something on this machine. */
export async function exportOutline(): Promise<{ schemaVersion: number; windows: SyncWindow[] }> {
  const { outline } = await loadOutline();
  return { schemaVersion: OUTLINE_SCHEMA_VERSION, windows: outline.windows.map(toSyncWindow) };
}
