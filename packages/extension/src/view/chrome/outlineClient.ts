// The view's link to the service worker's outline: state arrives over a port on every change, and
// commands go back as runtime messages.
import { useEffect, useRef, useState } from 'react';
import { buildTree } from '../../model/buildTree';
import type { OutlineView } from '../../model/types';
import {
  OUTLINE_COMMAND,
  OUTLINE_PORT,
  type OutlineCommand,
  type OutlineCommandReply,
  type OutlineCommandRequest,
  type OutlineState,
  type OutlineStateMessage,
} from '../../shared/outlineMessages';

const FIRST_RETRY_MS = 100;
const MAX_RETRY_MS = 2000;

function isStateMessage(msg: unknown): msg is OutlineStateMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'outline';
}

/**
 * Connects to the worker's outline port; calls onState on every broadcast; reconnects (100ms, then
 * doubling to 2s) when the port drops, e.g. the worker restarted. Returns an unsubscribe.
 */
export function subscribeOutline(onState: (s: OutlineState) => void): () => void {
  let stopped = false;
  let port: chrome.runtime.Port | null = null;
  let retryMs = FIRST_RETRY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (stopped) return;
    const p = chrome.runtime.connect({ name: OUTLINE_PORT });
    port = p;
    p.onMessage.addListener((msg: unknown) => {
      if (stopped || !isStateMessage(msg)) return;
      retryMs = FIRST_RETRY_MS; // a working connection resets the backoff
      onState(msg.state);
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
    port = null;
  };
}

/** Runs a command in the worker; rejects when the worker reports it failed. */
export async function sendOutlineCommand(c: OutlineCommand): Promise<void> {
  const request: OutlineCommandRequest = { type: OUTLINE_COMMAND, command: c };
  const reply = (await chrome.runtime.sendMessage(request)) as OutlineCommandReply | undefined;
  if (!reply?.ok) throw new Error(reply?.error ?? 'Tab Hammer: outline command got no reply');
}

const EMPTY: OutlineView = { windows: [], trash: [] };

/**
 * The worker's outline as view rows, kept current while the component is mounted. `onChange` runs
 * with each new view as it arrives (e.g. to drop view state the change made stale).
 */
export function useOutline(onChange?: (view: OutlineView) => void): OutlineView {
  const [view, setView] = useState<OutlineView>(EMPTY);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(
    () =>
      subscribeOutline((s) => {
        const next = buildTree(s);
        setView(next);
        onChangeRef.current?.(next);
      }),
    [],
  );
  return view;
}
