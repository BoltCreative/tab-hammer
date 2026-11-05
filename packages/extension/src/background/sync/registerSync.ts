// Wires the sync engine into the service worker: Drive through chrome.identity (when a client ID
// is configured), Chrome Sync devices through chrome.sessions, the 5-minute pull alarm, the picker's
// port and commands. Must be called synchronously at service worker top level.
import { sessionIdOfRow } from '../../model/sync/devices';
import {
  SYNC_PORT,
  isSyncCommandRequest,
  type SyncCommand,
  type SyncCommandReply,
  type SyncStateMessage,
} from '../../shared/syncMessages';
import type { OutlineOwner } from '../outline/outlineOwner';
import { AuthError, type SyncBackend } from './backend';
import { createDeviceSource } from './devices';
import { createDriveBackend } from './driveBackend';
import { createSyncEngine, type SyncEngine } from './syncEngine';
import { createSyncStore } from './syncStore';

const PULL_ALARM = 'tabHammer.syncPull';
const PULL_MINUTES = 5;

export interface SyncHandle {
  engine: SyncEngine;
  noteChange(): void;
  /** Test hook: a Drive backend on `apiBase` with a fixed token, in place of chrome.identity. */
  useTestBackend(apiBase: string, token: string): void;
}

async function chromeToken(interactive: boolean): Promise<string> {
  let token: string | undefined;
  try {
    token = (await chrome.identity.getAuthToken({ interactive })).token;
  } catch (err) {
    // Not signed in to Chrome, consent not given, or revoked.
    throw new AuthError(err instanceof Error ? err.message : String(err));
  }
  if (!token) throw new AuthError('No token');
  return token;
}

export function registerSync(owner: OutlineOwner): SyncHandle {
  const configured = Boolean(chrome.runtime.getManifest().oauth2?.client_id);
  const drive: SyncBackend | null = configured
    ? createDriveBackend({
        fetch: (input, init) => fetch(input, init),
        token: () => chromeToken(false),
        dropToken: (token) => chrome.identity.removeCachedAuthToken({ token }),
      })
    : null;
  let testBackend: SyncBackend | null = null;
  const devices = createDeviceSource(chrome, (create) => owner.openWindow(create));
  const ports = new Set<chrome.runtime.Port>();

  let broadcastQueued = false;
  function broadcast(): void {
    if (broadcastQueued || ports.size === 0) return;
    broadcastQueued = true;
    void engine
      .pickerState()
      .then((state) => {
        broadcastQueued = false;
        const msg: SyncStateMessage = { type: 'sync', state };
        for (const p of ports) {
          try {
            p.postMessage(msg);
          } catch {
            ports.delete(p);
          }
        }
      })
      .catch((err: unknown) => {
        broadcastQueued = false;
        console.error('[sync] picker state', err);
      });
  }

  const engine = createSyncEngine({
    installId: () => owner.installId(),
    platform: async () => (await chrome.runtime.getPlatformInfo()).os,
    backend: () => testBackend ?? drive,
    signIn: async () => {
      if (testBackend) return;
      if (!drive) throw new Error('Drive sync is not configured');
      await chromeToken(true);
    },
    outline: {
      windows: () => owner.exportWindows(),
      restore: (windows, keepTrash) => owner.restoreWindows(windows, keepTrash),
      wasFresh: () => owner.wasFresh(),
    },
    devices: () => devices.read(),
    store: createSyncStore(),
    now: Date.now,
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as number) },
    onState: broadcast,
    onError: (err) => console.error('[sync]', err),
  });

  async function run(c: SyncCommand): Promise<unknown> {
    switch (c.cmd) {
      case 'refresh':
        await engine.sync();
        broadcast(); // the device list too, which has no change event
        return undefined;
      case 'outlineOf':
        return engine.outlineOf(c.source);
      case 'openHere': {
        const remote = await engine.outlineOf(c.source);
        const w = remote.windows.find(
          (x) =>
            x.id === c.rowId ||
            x.tabs.some((t) => t.id === c.rowId) ||
            x.groups.some((g) => g.id === c.rowId),
        );
        if (!w) throw new Error('That row is no longer there');
        if (c.source.kind === 'device' || sessionIdOfRow(w.id) !== undefined)
          return devices.openHere(w, c.rowId);
        return owner.openCopy(w, c.rowId);
      }
      case 'restoreAll':
        return engine.restoreAll(c.source);
      case 'forget':
        return engine.forget(c.installId);
      case 'rename':
        return engine.rename(c.name);
      case 'signIn':
        return engine.signIn();
      default: {
        const unknown: never = c;
        throw new Error(`unknown sync command: ${String((unknown as { cmd?: unknown }).cmd)}`);
      }
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== SYNC_PORT) return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    broadcastQueued = false; // a new port needs the state even if a broadcast is in flight
    broadcast();
  });

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isSyncCommandRequest(msg)) return false;
    run(msg.command).then(
      (result) => sendResponse({ ok: true, result } satisfies SyncCommandReply),
      (err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies SyncCommandReply),
    );
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PULL_ALARM) void engine.sync();
  });
  void chrome.alarms.get(PULL_ALARM).then((a) => {
    if (!a) return chrome.alarms.create(PULL_ALARM, { periodInMinutes: PULL_MINUTES });
  });

  void engine.start();

  return {
    engine,
    noteChange: () => engine.noteChange(),
    useTestBackend(apiBase, token) {
      testBackend = createDriveBackend({
        fetch: (input, init) => fetch(input, init),
        token: async () => token,
        dropToken: async () => undefined,
        apiBase,
      });
    },
  };
}
