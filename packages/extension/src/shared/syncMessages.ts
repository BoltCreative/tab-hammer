// Messages between the service worker's sync engine and the view's device picker.
import type { SyncWindow } from '../model/sync/export';
import type { ComputerEntry, DeviceEntry } from '../model/sync/devices';

/** What Restore all did: windows it added, and windows it took out of this computer's trash. */
export interface RestoreCounts {
  added: number;
  untrashed: number;
}

export const SYNC_PORT = 'tabHammer.sync';
export const SYNC_COMMAND = 'tabHammer.syncCommand';

export type DriveStatus =
  | 'off' // no OAuth client ID configured
  | 'signedOut' // configured, but no sign-in to use
  | 'syncing'
  | 'ok'
  | 'error';

export interface CheckpointEntry {
  id: string; // its file name (local and Drive copies share it)
  checkpointAt: number;
  drastic: boolean;
  windowCount?: number; // unknown for one only in Drive, not yet downloaded
  tabCount?: number;
}

export interface SyncPickerState {
  drive: {
    status: DriveStatus;
    message?: string; // the error, for 'error'
    lastSyncAt?: number;
    skipped: string[]; // files that failed validation, as "<computer>: <why>"
  };
  self: { installId: string; name: string };
  computers: ComputerEntry[]; // other Tab Hammer computers, newest first
  devices: DeviceEntry[]; // Chrome Sync-only devices, newest first
  checkpoints: CheckpointEntry[]; // this computer's, newest first
}

export interface SyncStateMessage {
  type: 'sync';
  state: SyncPickerState;
}

export type SyncSource =
  | { kind: 'computer'; installId: string }
  | { kind: 'checkpoint'; id: string }
  | { kind: 'device'; name: string };

/** A device's or checkpoint's outline, read-only, open (non-trashed) windows only. */
export interface RemoteOutline {
  title: string;
  updatedAt?: number; // a computer's last write, a device's newest session
  checkpointAt?: number;
  windows: SyncWindow[];
}

export type SyncCommand =
  | { cmd: 'refresh' } // pull now (the picker opened, or a device is being viewed)
  | { cmd: 'outlineOf'; source: SyncSource }
  | { cmd: 'openHere'; source: SyncSource; rowId: string }
  | { cmd: 'restoreAll'; source: SyncSource }
  | { cmd: 'forget'; installId: string }
  | { cmd: 'rename'; name: string }
  | { cmd: 'signIn' };

export interface SyncCommandRequest {
  type: typeof SYNC_COMMAND;
  command: SyncCommand;
}

export type SyncCommandReply = { ok: true; result?: unknown } | { ok: false; error: string };

export function isSyncCommandRequest(msg: unknown): msg is SyncCommandRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === SYNC_COMMAND &&
    typeof (msg as { command?: unknown }).command === 'object' &&
    (msg as { command?: unknown }).command !== null
  );
}
