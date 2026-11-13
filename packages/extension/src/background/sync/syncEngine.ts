// The sync engine: pushes this computer's outline to its own file (one writer per file), pulls the
// other computers' files into a local cache, takes checkpoints, and restores. Everything it touches
// is injected (backend, store, outline, clock, timers), so it runs the same against Drive in the
// service worker and against an in-memory backend in tests.
//
// Nothing a remote file says changes this computer's outline except an explicit Restore all, or the
// self-restore of a computer whose outline database started empty.
import {
  dailyCheckpointDue,
  isDrasticDrop,
  pruneCheckpoints,
  type CheckpointMeta,
} from '../../model/sync/checkpoints';
import {
  assembleDevices,
  sessionWindows,
  type ComputerEntry,
  type SessionDeviceLike,
} from '../../model/sync/devices';
import type { SyncWindow } from '../../model/sync/export';
import { SYNC_SCHEMA_VERSION, validateSyncFile, type SyncFile } from '../../model/sync/schema';
import type {
  CheckpointEntry,
  DriveStatus,
  RemoteOutline,
  RestoreCounts,
  SyncPickerState,
  SyncSource,
} from '../../shared/syncMessages';
import { createJobQueue } from '../outline/jobQueue';
import {
  AuthError,
  NotFoundError,
  checkpointFileName,
  outlineFileName,
  parseCheckpointName,
  parseOutlineName,
  type SyncBackend,
} from './backend';
import type { CachedComputer, StoredCheckpoint, SyncFlags, SyncStore } from './syncStore';

export const PUSH_DELAY_MS = 10_000;

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface SyncEngineDeps {
  installId: () => Promise<string>;
  platform: () => Promise<string>; // chrome.runtime.getPlatformInfo().os
  /** The Drive backend, or null when Drive sync isn't configured (no OAuth client ID). */
  backend: () => SyncBackend | null;
  /** Asks the user to sign in (interactive getAuthToken); rejects if they don't. */
  signIn: () => Promise<void>;
  outline: {
    windows: () => Promise<SyncWindow[]>; // this computer's export, trash included
    /**
     * Adds the windows this outline lacks (hibernated) and takes the ones it has in its trash back
     * out; returns how many of each. A self-restore keeps the file's trash and re-links the windows
     * open now to the ones live in the file.
     */
    restore: (windows: SyncWindow[], selfRestore: boolean) => Promise<RestoreCounts>;
    /** The outline database was empty when this worker started. */
    wasFresh: () => Promise<boolean>;
  };
  devices: () => Promise<SessionDeviceLike[]>; // chrome.sessions.getDevices
  store: SyncStore;
  now: () => number;
  timers: Timers;
  onState?: () => void; // something the picker shows changed
  onError?: (err: unknown) => void;
}

export interface SyncEngine {
  start(): Promise<void>; // pull, then push anything unpushed
  noteChange(): void; // the outline changed: push in PUSH_DELAY_MS
  sync(): Promise<void>; // pull, then push if needed (alarm, picker open, test hook)
  flushNow(): Promise<void>; // the pending push, now (test hook)
  pickerState(): Promise<SyncPickerState>;
  outlineOf(source: SyncSource): Promise<RemoteOutline>;
  restoreAll(source: SyncSource): Promise<RestoreCounts>;
  forget(installId: string): Promise<void>;
  rename(name: string): Promise<void>;
  signIn(): Promise<void>;
  idle(): Promise<void>;
}

const PLATFORM_NAMES: Record<string, string> = {
  mac: 'Mac',
  win: 'Windows',
  linux: 'Linux',
  cros: 'ChromeOS',
  android: 'Android',
  openbsd: 'OpenBSD',
  fuchsia: 'Fuchsia',
};

export const defaultComputerName = (platform: string) => PLATFORM_NAMES[platform] ?? 'Computer';

const open = (ws: SyncWindow[]) => ws.filter((w) => w.state !== 'trashed');
const tabCount = (ws: SyncWindow[]) => ws.reduce((n, w) => n + w.tabs.length, 0);
const sameWindows = (a: SyncFile, b: SyncFile) =>
  JSON.stringify(a.windows) === JSON.stringify(b.windows);
const sameContent = (a: SyncFile, b: SyncFile) =>
  a.computerName === b.computerName && sameWindows(a, b);

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { store } = deps;
  let installId = '';
  let platform = '';
  let flags: SyncFlags = {};
  let status: DriveStatus = 'off';
  let message: string | undefined;
  let lastSyncAt: number | undefined;
  let ownFilePresent: boolean | undefined; // from the last listing
  let driveCheckpoints: { id: string; checkpointAt: number }[] = []; // this install's, in Drive
  let changes = 0; // bumped by every noteChange, so a push only clears the dirty flag it covered
  let timer: unknown;

  const notify = () => deps.onState?.();
  const queue = createJobQueue({
    init,
    onError: (err) => (deps.onError ?? console.error)(err),
  });

  async function init(): Promise<void> {
    installId = await deps.installId();
    platform = await deps.platform();
    flags = await store.flags();
    if ((await deps.outline.wasFresh()) && !flags.selfRestorePending)
      await setFlags({ selfRestorePending: true });
    status = deps.backend() ? 'syncing' : 'off';
  }

  async function setFlags(patch: SyncFlags): Promise<void> {
    flags = { ...flags, ...patch };
    await store.setFlags(patch);
  }

  const computerName = () => flags.computerName ?? defaultComputerName(platform);

  function buildFile(windows: SyncWindow[]): SyncFile {
    return {
      schemaVersion: SYNC_SCHEMA_VERSION,
      installId,
      computerName: computerName(),
      platform,
      updatedAt: deps.now(),
      windows,
    };
  }

  /** Runs a Drive operation, recording how it went as the status the picker shows. */
  async function online(op: (b: SyncBackend) => Promise<void>): Promise<void> {
    const backend = deps.backend();
    if (!backend) {
      status = 'off';
      return;
    }
    status = 'syncing';
    notify();
    try {
      await op(backend);
      status = 'ok';
      message = undefined;
      lastSyncAt = deps.now();
    } catch (err) {
      if (err instanceof AuthError) {
        status = 'signedOut';
        message = undefined;
      } else {
        status = 'error';
        message = err instanceof Error ? err.message : String(err);
        (deps.onError ?? console.error)(err);
      }
    } finally {
      notify();
    }
  }

  /** Every checkpoint known here or in Drive, by ID. */
  async function allCheckpoints(): Promise<
    (CheckpointMeta & { id: string; local?: StoredCheckpoint })[]
  > {
    const local = await store.checkpoints();
    const byId = new Map<string, CheckpointMeta & { id: string; local?: StoredCheckpoint }>();
    for (const c of driveCheckpoints) byId.set(c.id, { id: c.id, checkpointAt: c.checkpointAt });
    for (const c of local)
      byId.set(c.id, { id: c.id, checkpointAt: c.checkpointAt, drastic: c.drastic, local: c });
    return [...byId.values()];
  }

  /** Saves a checkpoint of `file` locally, and to Drive when there is one (best effort). */
  async function checkpoint(file: SyncFile, drastic: boolean): Promise<void> {
    let at = deps.now();
    const taken = new Set((await allCheckpoints()).map((c) => c.id));
    while (taken.has(checkpointFileName(installId, at))) at++; // two in one millisecond
    const id = checkpointFileName(installId, at);
    const cp: SyncFile = { ...file, checkpointAt: at };
    await store.putCheckpoint({ id, checkpointAt: at, drastic, file: cp });
    const backend = deps.backend();
    if (backend) {
      try {
        await backend.write(id, JSON.stringify(cp));
        driveCheckpoints.push({ id, checkpointAt: at });
      } catch {
        // The local copy stands; the Drive copy is a nicety (it survives a wiped profile).
      }
    }
    await prune(backend);
    notify();
  }

  async function prune(backend: SyncBackend | null): Promise<void> {
    const { drop } = pruneCheckpoints(await allCheckpoints());
    for (const c of drop) {
      if (c.local) await store.deleteCheckpoint(c.id);
      if (backend && driveCheckpoints.some((d) => d.id === c.id)) {
        try {
          await backend.remove(c.id);
          driveCheckpoints = driveCheckpoints.filter((d) => d.id !== c.id);
        } catch {
          // Pruned again next time.
        }
      }
    }
  }

  async function dailyCheckpoint(file: SyncFile): Promise<void> {
    if (file.windows.length === 0) return;
    const all = await allCheckpoints();
    if (!dailyCheckpointDue(all, deps.now())) return;
    const latest = (await store.checkpoints()).sort((a, b) => b.checkpointAt - a.checkpointAt)[0];
    if (latest && sameWindows(latest.file, file)) return; // unchanged since
    await checkpoint(file, false);
  }

  async function push(backend: SyncBackend, file: SyncFile, upTo: number): Promise<void> {
    const v = validateSyncFile(JSON.parse(JSON.stringify(file)));
    if (!v.ok) throw new Error(`not uploading an invalid outline: ${v.reason}`);
    const prev = await store.lastPushed();
    if (!(prev && ownFilePresent !== false && sameContent(prev, file))) {
      if (prev && isDrasticDrop(prev.windows, file.windows)) await checkpoint(prev, true);
      await backend.write(outlineFileName(installId), JSON.stringify(file));
      await store.setLastPushed(file);
      ownFilePresent = true;
    }
    if (changes === upTo) await setFlags({ dirty: false });
  }

  /** Daily checkpoint, then the push if one is due and allowed. */
  async function flush(): Promise<void> {
    const upTo = changes;
    const file = buildFile(await deps.outline.windows());
    await dailyCheckpoint(file);
    if (!deps.backend() || flags.selfRestorePending) return;
    if (!flags.dirty && ownFilePresent !== false) return;
    await online((b) => push(b, file, upTo));
  }

  async function readFile(backend: SyncBackend, name: string) {
    const text = await backend.read(name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false as const, problem: 'malformed' as const, reason: 'not JSON' };
    }
    return validateSyncFile(parsed);
  }

  async function pull(backend: SyncBackend): Promise<void> {
    const files = await backend.list();
    const own = outlineFileName(installId);
    ownFilePresent = files.some((f) => f.name === own);
    driveCheckpoints = files.flatMap((f) => {
      const c = parseCheckpointName(f.name);
      return c?.installId === installId ? [{ id: f.name, checkpointAt: c.at }] : [];
    });
    const cached = new Map((await store.computers()).map((c) => [c.name, c]));
    for (const f of files) {
      const id = parseOutlineName(f.name);
      if (id === undefined || id === installId) continue;
      const known = cached.get(f.name);
      cached.delete(f.name);
      if (known && known.modifiedTime === f.modifiedTime) continue; // unchanged: not downloaded
      let r;
      try {
        r = await readFile(backend, f.name);
      } catch (err) {
        if (err instanceof NotFoundError) continue; // deleted since the listing
        throw err;
      }
      const entry: CachedComputer = { name: f.name, installId: id, modifiedTime: f.modifiedTime };
      if (r.ok && r.file.installId !== id) {
        entry.problem = 'malformed';
        entry.reason = `its install ID doesn't match its file name`;
      } else if (r.ok) entry.file = r.file;
      else {
        entry.problem = r.problem;
        entry.reason = r.reason;
      }
      await store.putComputer(entry);
    }
    for (const gone of cached.keys()) await store.deleteComputer(gone);
    if (flags.selfRestorePending) await selfRestore(backend);
  }

  /** The outline database started empty: bring this computer's own file back in, if there is one. */
  async function selfRestore(backend: SyncBackend): Promise<void> {
    if (ownFilePresent) {
      let r;
      try {
        r = await readFile(backend, outlineFileName(installId));
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err; // retried on the next pull
        r = undefined;
      }
      if (r?.ok && r.file.windows.length > 0) {
        await checkpoint(buildFile(await deps.outline.windows()), true);
        await checkpoint(r.file, true);
        await deps.outline.restore(r.file.windows, true);
        await store.setLastPushed(r.file);
        if (
          flags.computerName === undefined &&
          r.file.computerName !== defaultComputerName(platform)
        )
          await setFlags({ computerName: r.file.computerName });
      }
    }
    await setFlags({ selfRestorePending: false, dirty: true });
  }

  async function sync(): Promise<void> {
    await online(pull);
    await flush();
  }

  function schedule(): void {
    if (timer !== undefined) deps.timers.clear(timer);
    timer = deps.timers.set(() => {
      timer = undefined;
      void queue.enqueue(flush);
    }, PUSH_DELAY_MS);
  }

  async function fileOf(source: SyncSource): Promise<RemoteOutline & { all: SyncWindow[] }> {
    switch (source.kind) {
      case 'computer': {
        const c = (await store.computers()).find((x) => x.installId === source.installId);
        if (!c?.file) throw new Error('That computer has no readable outline');
        return {
          title: c.file.computerName,
          updatedAt: c.file.updatedAt,
          windows: open(c.file.windows),
          all: c.file.windows,
        };
      }
      case 'checkpoint': {
        let file = (await store.checkpoints()).find((x) => x.id === source.id)?.file;
        const backend = deps.backend();
        if (!file && backend) {
          const r = await readFile(backend, source.id);
          if (!r.ok) throw new Error(`That checkpoint can't be read: ${r.reason}`);
          file = r.file;
        }
        if (!file) throw new Error('That checkpoint is gone');
        return {
          title: 'Checkpoint',
          checkpointAt: file.checkpointAt ?? file.updatedAt,
          windows: open(file.windows),
          all: file.windows,
        };
      }
      case 'device': {
        const d = (await deps.devices()).find((x) => x.deviceName === source.name);
        if (!d) throw new Error('That device is no longer listed');
        const windows = sessionWindows(d);
        return {
          title: d.deviceName,
          updatedAt: Math.max(0, ...d.sessions.map((s) => s.lastModified * 1000)),
          windows,
          all: windows,
        };
      }
    }
  }

  return {
    start: () => queue.enqueue(sync),
    sync: () => queue.enqueue(sync),
    idle: () => queue.idle(),
    noteChange() {
      changes++;
      if (!flags.dirty) void queue.enqueue(() => setFlags({ dirty: true }));
      schedule();
    },
    flushNow() {
      if (timer !== undefined) deps.timers.clear(timer);
      timer = undefined;
      return queue.enqueue(flush);
    },

    pickerState: () =>
      queue.enqueue(async () => {
        const cached = await store.computers();
        const computers: ComputerEntry[] = cached.map((c) => {
          const entry: ComputerEntry = {
            installId: c.installId,
            name: c.file?.computerName ?? 'Unreadable computer',
            updatedAt: c.file?.updatedAt ?? c.modifiedTime,
            windowCount: c.file ? open(c.file.windows).length : 0,
            tabCount: c.file ? tabCount(open(c.file.windows)) : 0,
          };
          if (c.problem) entry.problem = c.problem;
          return entry;
        });
        const devices = await deps.devices().catch(() => []);
        const assembled = assembleDevices(computerName(), computers, devices);
        const checkpoints: CheckpointEntry[] = (await allCheckpoints())
          .sort((a, b) => b.checkpointAt - a.checkpointAt)
          .map((c) => {
            const e: CheckpointEntry = {
              id: c.id,
              checkpointAt: c.checkpointAt,
              drastic: c.drastic ?? false,
            };
            if (c.local) {
              e.windowCount = open(c.local.file.windows).length;
              e.tabCount = tabCount(open(c.local.file.windows));
            }
            return e;
          });
        const drive: SyncPickerState['drive'] = {
          status,
          skipped: cached
            .filter((c) => c.problem)
            .map((c) =>
              c.problem === 'newer'
                ? `${c.installId.slice(0, 8)}: needs a newer Tab Hammer`
                : `${c.installId.slice(0, 8)}: ${c.reason ?? 'invalid file'}`,
            ),
        };
        if (message !== undefined) drive.message = message;
        if (lastSyncAt !== undefined) drive.lastSyncAt = lastSyncAt;
        return {
          drive,
          self: { installId, name: computerName() },
          computers: assembled.computers,
          devices: assembled.devices,
          checkpoints,
        };
      }),

    outlineOf: (source) =>
      queue.enqueue(async () => {
        const remote: RemoteOutline & { all?: SyncWindow[] } = await fileOf(source);
        delete remote.all;
        return remote;
      }),

    restoreAll: (source) =>
      queue.enqueue(async () => {
        if (source.kind === 'device') throw new Error('Restore all is for Tab Hammer outlines');
        const { all } = await fileOf(source);
        const current = buildFile(await deps.outline.windows());
        if (current.windows.length > 0) await checkpoint(current, true);
        return deps.outline.restore(all, false);
      }),

    forget: (id) =>
      queue.enqueue(async () => {
        if (id === installId) throw new Error("This computer can't forget itself");
        const backend = deps.backend();
        if (!backend) throw new Error('Drive sync is off');
        let failed: unknown;
        await online(async (b) => {
          try {
            const files = await b.list();
            for (const f of files) {
              if (parseOutlineName(f.name) === id || parseCheckpointName(f.name)?.installId === id)
                await b.remove(f.name);
            }
          } catch (err) {
            failed = err;
            throw err;
          }
        });
        if (failed) throw failed;
        await store.deleteComputer(outlineFileName(id));
        notify();
      }),

    rename: (name) =>
      queue.enqueue(async () => {
        const trimmed = name.trim();
        const next =
          trimmed === '' || trimmed === defaultComputerName(platform) ? undefined : trimmed;
        if (next === flags.computerName) return;
        flags = { ...flags, computerName: next };
        await store.setFlags({ computerName: next });
        changes++;
        await setFlags({ dirty: true });
        schedule();
        notify();
      }),

    signIn: async () => {
      await deps.signIn();
      await queue.enqueue(sync);
    },
  };
}
