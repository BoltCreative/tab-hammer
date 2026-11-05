// Messages between the service worker (owns the persisted outline) and the view.
import type { Placement } from '../model/outline/place';
import type { WindowRec } from '../model/outline/types';

export const OUTLINE_PORT = 'tabHammer.outline';

export interface LiveDetails {
  tabs: Record<number, { active: boolean; discarded: boolean; lastAccessed?: number }>; // by chromeTabId
  focusedWindowId: number | null; // last-focused normal window
}

export interface OutlineState {
  windows: WindowRec[];
  live: LiveDetails;
}

export interface OutlineStateMessage {
  type: 'outline';
  state: OutlineState;
}

export const OUTLINE_COMMAND = 'tabHammer.outlineCommand';

export type OutlineCommand =
  | { cmd: 'hibernate'; ids: string[] }
  | { cmd: 'trash'; ids: string[] }
  | { cmd: 'open'; id: string }
  | { cmd: 'rename'; windowId: string; name: string }
  | { cmd: 'deleteForever'; windowId: string }
  | { cmd: 'place'; placement: Placement };

export interface OutlineCommandRequest {
  type: typeof OUTLINE_COMMAND;
  command: OutlineCommand;
}

export interface OutlineCommandReply {
  ok: boolean;
  error?: string;
}

export function isOutlineCommandRequest(msg: unknown): msg is OutlineCommandRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === OUTLINE_COMMAND &&
    typeof (msg as { command?: unknown }).command === 'object' &&
    (msg as { command?: unknown }).command !== null
  );
}
