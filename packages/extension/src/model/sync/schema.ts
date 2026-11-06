// The sync file: one computer's exported outline as stored in Drive (and in local checkpoints).
// Every file is validated before it is uploaded or read in; the validated copy is rebuilt field by
// field, so nothing the schema doesn't know about reaches the outline.
import type { GroupColor } from '../types';
import type { WindowState } from '../outline/types';
import type { SyncGroup, SyncTab, SyncWindow } from './export';

export const SYNC_SCHEMA_VERSION = 1;

export interface SyncFile {
  schemaVersion: number;
  installId: string;
  computerName: string;
  platform: string;
  updatedAt: number;
  checkpointAt?: number; // checkpoints only
  windows: SyncWindow[];
}

export type Validation =
  { ok: true; file: SyncFile } | { ok: false; problem: 'newer' | 'malformed'; reason: string };

const STATES: ReadonlySet<string> = new Set<WindowState>(['live', 'hibernated', 'trashed']);
const COLORS: ReadonlySet<string> = new Set<GroupColor>([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

class Malformed extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Malformed(`${where}: not an object`);
  return v as Obj;
}
function str(o: Obj, key: string, where: string, nonEmpty = false): string {
  const v = o[key];
  if (typeof v !== 'string' || (nonEmpty && v === ''))
    throw new Malformed(`${where}.${key}: not a${nonEmpty ? ' non-empty' : ''} string`);
  return v;
}
function num(o: Obj, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Malformed(`${where}.${key}: not a number`);
  return v;
}
function arr(o: Obj, key: string, where: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new Malformed(`${where}.${key}: not an array`);
  return v;
}
const has = (o: Obj, key: string) => o[key] !== undefined;

function group(v: unknown, where: string): SyncGroup {
  const o = obj(v, where);
  const color = str(o, 'color', where);
  if (!COLORS.has(color)) throw new Malformed(`${where}.color: unknown color ${color}`);
  if (typeof o.collapsed !== 'boolean') throw new Malformed(`${where}.collapsed: not a boolean`);
  return {
    id: str(o, 'id', where, true),
    title: str(o, 'title', where),
    color: color as GroupColor,
    collapsed: o.collapsed,
    modifiedAt: num(o, 'modifiedAt', where),
  };
}

function tab(v: unknown, where: string, groupIds: Set<string>): SyncTab {
  const o = obj(v, where);
  const out: SyncTab = {
    id: str(o, 'id', where, true),
    url: str(o, 'url', where),
    title: str(o, 'title', where),
    modifiedAt: num(o, 'modifiedAt', where),
  };
  if (has(o, 'groupId')) {
    const g = str(o, 'groupId', where, true);
    if (!groupIds.has(g)) throw new Malformed(`${where}.groupId: no group ${g} in its window`);
    out.groupId = g;
  }
  return out;
}

function window(v: unknown, where: string): SyncWindow {
  const o = obj(v, where);
  const state = str(o, 'state', where);
  if (!STATES.has(state)) throw new Malformed(`${where}.state: unknown state ${state}`);
  const groups = arr(o, 'groups', where).map((g, i) => group(g, `${where}.groups[${i}]`));
  const groupIds = new Set(groups.map((g) => g.id));
  const out: SyncWindow = {
    id: str(o, 'id', where, true),
    state: state as WindowState,
    lastLiveAt: num(o, 'lastLiveAt', where),
    originInstallId: str(o, 'originInstallId', where),
    modifiedAt: num(o, 'modifiedAt', where),
    tabs: arr(o, 'tabs', where).map((t, i) => tab(t, `${where}.tabs[${i}]`, groupIds)),
    groups,
  };
  if (has(o, 'name')) out.name = str(o, 'name', where);
  if (has(o, 'closedAt')) out.closedAt = num(o, 'closedAt', where);
  return out;
}

/** The file, or why it can't be used: from a newer Tab Hammer, or not a valid sync file. */
export function validateSyncFile(v: unknown): Validation {
  try {
    const o = obj(v, 'file');
    const version = num(o, 'schemaVersion', 'file');
    if (!Number.isInteger(version) || version < 1)
      throw new Malformed(`file.schemaVersion: ${version} is not a version`);
    if (version > SYNC_SCHEMA_VERSION)
      return { ok: false, problem: 'newer', reason: `schema version ${version}` };
    const file: SyncFile = {
      schemaVersion: version,
      installId: str(o, 'installId', 'file', true),
      computerName: str(o, 'computerName', 'file'),
      platform: str(o, 'platform', 'file'),
      updatedAt: num(o, 'updatedAt', 'file'),
      windows: arr(o, 'windows', 'file').map((w, i) => window(w, `file.windows[${i}]`)),
    };
    if (has(o, 'checkpointAt')) file.checkpointAt = num(o, 'checkpointAt', 'file');
    const seen = new Set<string>();
    for (const w of file.windows) {
      for (const id of [w.id, ...w.tabs.map((t) => t.id), ...w.groups.map((g) => g.id)]) {
        if (seen.has(id)) throw new Malformed(`file: ID ${id} appears twice`);
        seen.add(id);
      }
    }
    return { ok: true, file };
  } catch (err) {
    if (err instanceof Malformed) return { ok: false, problem: 'malformed', reason: err.message };
    throw err;
  }
}
