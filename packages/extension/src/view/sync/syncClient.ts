// The view's link to the service worker's sync engine: picker state over a port, commands as
// runtime messages.
import { useEffect, useState } from 'react';
import {
  SYNC_COMMAND,
  SYNC_PORT,
  type SyncCommand,
  type SyncCommandReply,
  type SyncCommandRequest,
  type SyncPickerState,
  type SyncStateMessage,
} from '../../shared/syncMessages';

const FIRST_RETRY_MS = 100;
const MAX_RETRY_MS = 2000;

function isStateMessage(msg: unknown): msg is SyncStateMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'sync';
}

/** The picker state, kept current while mounted (reconnecting if the worker restarts). */
export function useSyncState(): SyncPickerState | null {
  const [state, setState] = useState<SyncPickerState | null>(null);
  useEffect(() => {
    let stopped = false;
    let port: chrome.runtime.Port | null = null;
    let retryMs = FIRST_RETRY_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      const p = chrome.runtime.connect({ name: SYNC_PORT });
      port = p;
      p.onMessage.addListener((msg: unknown) => {
        if (stopped || !isStateMessage(msg)) return;
        retryMs = FIRST_RETRY_MS;
        setState(msg.state);
      });
      p.onDisconnect.addListener(() => {
        if (port === p) port = null;
        if (stopped) return;
        timer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      });
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      port?.disconnect();
    };
  }, []);
  return state;
}

/** Runs a sync command in the worker; resolves with its result, rejects with its error. */
export async function sendSyncCommand<T = unknown>(c: SyncCommand): Promise<T> {
  const request: SyncCommandRequest = { type: SYNC_COMMAND, command: c };
  const reply = (await chrome.runtime.sendMessage(request)) as SyncCommandReply | undefined;
  if (!reply) throw new Error('Tab Hammer: sync command got no reply');
  if (!reply.ok) throw new Error(reply.error);
  return reply.result as T;
}
