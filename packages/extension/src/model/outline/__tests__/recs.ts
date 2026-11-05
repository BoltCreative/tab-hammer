import type { GroupRec, TabRec, WindowRec } from '../types';

export function tab(id: string, opts: Partial<TabRec> = {}): TabRec {
  return { id, url: `https://e.test/${id}`, title: id, modifiedAt: 0, ...opts };
}

export function group(id: string, opts: Partial<GroupRec> = {}): GroupRec {
  return { id, title: id, color: 'blue', collapsed: false, modifiedAt: 0, ...opts };
}

export function win(id: string, opts: Partial<WindowRec> = {}): WindowRec {
  return {
    id,
    state: opts.chromeWindowId === undefined ? 'hibernated' : 'live',
    lastLiveAt: 0,
    originInstallId: 'i',
    modifiedAt: 0,
    tabs: [],
    groups: [],
    ...opts,
  };
}
