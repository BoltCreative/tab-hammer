import type { SyncGroup, SyncTab, SyncWindow } from '../export';
import type { SyncFile } from '../schema';

export function stab(id: string, opts: Partial<SyncTab> = {}): SyncTab {
  return { id, url: `https://e.test/${id}`, title: id, modifiedAt: 0, ...opts };
}

export function sgroup(id: string, opts: Partial<SyncGroup> = {}): SyncGroup {
  return { id, title: id, color: 'blue', collapsed: false, modifiedAt: 0, ...opts };
}

export function swin(id: string, opts: Partial<SyncWindow> = {}): SyncWindow {
  return {
    id,
    state: 'hibernated',
    lastLiveAt: 0,
    originInstallId: 'other',
    modifiedAt: 0,
    tabs: [stab(`${id}-t1`)],
    groups: [],
    ...opts,
  };
}

export function sfile(windows: SyncWindow[], opts: Partial<SyncFile> = {}): SyncFile {
  return {
    schemaVersion: 1,
    installId: 'other',
    computerName: 'Laptop',
    platform: 'mac',
    updatedAt: 1000,
    windows,
    ...opts,
  };
}
