import { describe, expect, it } from 'vitest';
import {
  closeWindow,
  deleteWindow,
  expireTrash,
  findRow,
  hibernate,
  renameWindow,
  startFresh,
  trash,
  untrash,
} from '../lifecycle';
import { TRASH_TTL_MS } from '../types';
import { group, tab, win } from './recs';

const NOW = 1_000_000;

describe('closeWindow', () => {
  it('closing a live window with only live tabs trashes it, marking which tabs were live', () => {
    const o = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          tabs: [tab('a', { chromeTabId: 11 }), tab('b', { chromeTabId: 12 })],
        }),
      ],
    };
    const w = closeWindow(o, 'w', NOW).windows[0]!;
    expect(w).toMatchObject({ state: 'trashed', closedAt: NOW, lastLiveAt: NOW });
    expect(w.chromeWindowId).toBeUndefined();
    expect(w.tabs.map((t) => [t.chromeTabId, t.liveAtClose])).toEqual([
      [undefined, true],
      [undefined, true],
    ]);
  });

  it('closing a live window that holds hibernated tabs hibernates it instead', () => {
    const o = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          provisional: true,
          groups: [group('g', { chromeGroupId: 5 })],
          tabs: [tab('a', { chromeTabId: 11 }), tab('b')],
        }),
      ],
    };
    const w = closeWindow(o, 'w', NOW).windows[0]!;
    expect(w.state).toBe('hibernated');
    expect(w.closedAt).toBeUndefined();
    expect(w.provisional).toBeUndefined();
    expect(w.groups[0]!.chromeGroupId).toBeUndefined();
    expect(w.tabs.map((t) => t.liveAtClose)).toEqual([true, false]);
  });

  it('returns untouched windows by reference', () => {
    const o = {
      windows: [
        win('w1', { chromeWindowId: 1, tabs: [tab('a', { chromeTabId: 11 })] }),
        win('w2', { chromeWindowId: 2, tabs: [tab('b', { chromeTabId: 12 })] }),
      ],
    };
    const r = closeWindow(o, 'w1', NOW);
    expect(r.windows[1]).toBe(o.windows[1]);
  });
});

describe('hibernate', () => {
  it('hibernating the last live tab hibernates the window and closes just the tab', () => {
    const o = {
      windows: [win('w', { chromeWindowId: 1, tabs: [tab('a', { chromeTabId: 11 }), tab('b')] })],
    };
    const r = hibernate(o, ['a'], NOW);
    expect(r.effects).toEqual({ closeWindows: [], closeTabs: [11] });
    const w = r.outline.windows[0]!;
    expect(w.state).toBe('hibernated');
    expect(w.chromeWindowId).toBeUndefined();
    expect(w.tabs.map((t) => [t.id, t.chromeTabId])).toEqual([
      ['a', undefined],
      ['b', undefined],
    ]);
  });

  it('hibernating one of several live tabs keeps the window live', () => {
    const o = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          tabs: [tab('a', { chromeTabId: 11 }), tab('b', { chromeTabId: 12 })],
        }),
      ],
    };
    const r = hibernate(o, ['a'], NOW);
    expect(r.effects).toEqual({ closeWindows: [], closeTabs: [11] });
    const w = r.outline.windows[0]!;
    expect(w.state).toBe('live');
    expect(w.modifiedAt).toBe(0);
    expect(w.tabs.map((t) => t.chromeTabId)).toEqual([undefined, 12]);
  });

  it('hibernating a live window closes it in Chrome and keeps every tab row', () => {
    const o = {
      windows: [
        win('w', {
          chromeWindowId: 7,
          tabs: [tab('a', { chromeTabId: 11 }), tab('b', { chromeTabId: 12 })],
        }),
      ],
    };
    const r = hibernate(o, ['w'], NOW);
    expect(r.effects).toEqual({ closeWindows: [7], closeTabs: [] });
    const w = r.outline.windows[0]!;
    expect(w).toMatchObject({ state: 'hibernated', lastLiveAt: NOW, modifiedAt: NOW });
    expect(w.tabs).toHaveLength(2);
    expect(w.tabs.every((t) => t.chromeTabId === undefined && t.liveAtClose === true)).toBe(true);
  });

  it('hibernating a group hibernates its live tabs', () => {
    const o = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          groups: [group('g', { chromeGroupId: 5 })],
          tabs: [tab('a', { chromeTabId: 11, groupId: 'g' }), tab('b', { chromeTabId: 12 })],
        }),
      ],
    };
    const r = hibernate(o, ['g'], NOW);
    expect(r.effects.closeTabs).toEqual([11]);
    const w = r.outline.windows[0]!;
    expect(w.tabs[1]!.chromeTabId).toBe(12);
    expect(w.groups[0]!.chromeGroupId).toBeUndefined();
  });
});

describe('trash', () => {
  it('a window deleted while hibernated is remembered as hibernated at close; a live one is not', () => {
    const o = {
      windows: [
        win('h', { tabs: [tab('a')] }),
        win('l', { chromeWindowId: 1, tabs: [tab('b', { chromeTabId: 11 })] }),
      ],
    };
    const [h, l] = trash(o, ['h', 'l'], NOW).outline.windows;
    expect(h).toMatchObject({ state: 'trashed', hibernatedAtClose: true });
    expect(l!.state).toBe('trashed');
    expect(l!.hibernatedAtClose).toBeUndefined();
    // Out of the trash, the mark goes.
    expect(untrash({ windows: [h!] }, ['h'], NOW).windows[0]!.hibernatedAtClose).toBeUndefined();
  });

  it('trashing a hibernated tab deletes it; trashing a live tab removes it and closes it', () => {
    const o = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          tabs: [tab('a', { chromeTabId: 11 }), tab('b', { chromeTabId: 12 }), tab('c')],
        }),
      ],
    };
    const r1 = trash(o, ['c'], NOW);
    expect(r1.effects).toEqual({ closeWindows: [], closeTabs: [] });
    expect(r1.outline.windows[0]!.tabs.map((t) => t.id)).toEqual(['a', 'b']);
    expect(r1.outline.windows[0]!.modifiedAt).toBe(NOW);
    const r2 = trash(o, ['a'], NOW);
    expect(r2.effects).toEqual({ closeWindows: [], closeTabs: [11] });
    expect(r2.outline.windows[0]!.tabs.map((t) => t.id)).toEqual(['b', 'c']);
    expect(r2.outline.windows[0]!.state).toBe('live');
  });

  it('trashing a live window closes it; a hibernated window just moves to trash', () => {
    const o = {
      windows: [
        win('l', { chromeWindowId: 3, tabs: [tab('a', { chromeTabId: 11 })] }),
        win('h', { tabs: [tab('b')] }),
      ],
    };
    const r = trash(o, ['l', 'h'], NOW);
    expect(r.effects).toEqual({ closeWindows: [3], closeTabs: [] });
    expect(r.outline.windows.map((w) => [w.state, w.closedAt])).toEqual([
      ['trashed', NOW],
      ['trashed', NOW],
    ]);
  });

  it('trashing every live tab of a window with no hibernated tabs trashes the window with those tabs', () => {
    const o = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          tabs: [tab('a', { chromeTabId: 11 }), tab('b', { chromeTabId: 12 })],
        }),
      ],
    };
    const r = trash(o, ['a', 'b'], NOW);
    expect(r.effects).toEqual({ closeWindows: [], closeTabs: [11, 12] });
    const w = r.outline.windows[0]!;
    expect(w).toMatchObject({ state: 'trashed', closedAt: NOW });
    expect(w.tabs.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('trashing every live tab of a window that holds hibernated tabs hibernates the window', () => {
    const o = {
      windows: [win('w', { chromeWindowId: 1, tabs: [tab('a', { chromeTabId: 11 }), tab('b')] })],
    };
    const r = trash(o, ['a'], NOW);
    expect(r.effects).toEqual({ closeWindows: [], closeTabs: [11] });
    const w = r.outline.windows[0]!;
    expect(w.state).toBe('hibernated');
    expect(w.tabs.map((t) => t.id)).toEqual(['b']);
  });

  it('trashing the last tab of a hibernated window deletes the window', () => {
    const o = { windows: [win('w', { tabs: [tab('a')] }), win('x', { tabs: [tab('b')] })] };
    const r = trash(o, ['a'], NOW);
    expect(r.outline.windows.map((w) => w.id)).toEqual(['x']);
  });
});

describe('rename, delete, expire', () => {
  it('renaming trims, and an empty name clears it', () => {
    const o = { windows: [win('w', { name: 'Old' })] };
    expect(renameWindow(o, 'w', '  Work  ', NOW).windows[0]!.name).toBe('Work');
    expect(renameWindow(o, 'w', '   ', NOW).windows[0]!.name).toBeUndefined();
  });

  it('ops stamp changed records only', () => {
    const o = {
      windows: [win('w', { tabs: [tab('a')] }), win('x')],
    };
    const r = renameWindow(o, 'w', 'X', NOW);
    expect(r.windows[0]!.modifiedAt).toBe(NOW);
    expect(r.windows[0]!.tabs[0]!.modifiedAt).toBe(0);
    expect(r.windows[1]).toBe(o.windows[1]);
    const same = renameWindow(r, 'w', ' X ', NOW + 5);
    expect(same.windows[0]!.modifiedAt).toBe(NOW);
  });

  it('deleteWindow removes the record', () => {
    const o = { windows: [win('w'), win('x')] };
    expect(deleteWindow(o, 'w').windows.map((w) => w.id)).toEqual(['x']);
  });

  it('trash entries expire after 7 days, not before', () => {
    const o = {
      windows: [
        win('edge', { state: 'trashed', closedAt: NOW - TRASH_TTL_MS }),
        win('old', { state: 'trashed', closedAt: NOW - TRASH_TTL_MS - 1 }),
        win('h', { tabs: [tab('a')] }),
      ],
    };
    expect(expireTrash(o, NOW).windows.map((w) => w.id)).toEqual(['edge', 'h']);
  });
});

describe('startFresh and openAtShutdown', () => {
  it('a fresh launch hibernates every live window, marked open-at-shutdown: nothing goes to the trash', () => {
    const o = {
      windows: [
        win('live', { chromeWindowId: 1, tabs: [tab('a', { chromeTabId: 11 })] }),
        win('mixed', {
          chromeWindowId: 2,
          tabs: [tab('b', { chromeTabId: 12 }), tab('c')],
        }),
        win('user', { tabs: [tab('d')] }),
        win('bin', { state: 'trashed', closedAt: 5 }),
      ],
    };
    const r = startFresh(o, NOW);
    const [live, mixed, user, bin] = r.windows;
    // A crash or a quit that Chrome doesn't restore isn't the user closing the window.
    expect(live).toMatchObject({ state: 'hibernated', openAtShutdown: true, lastLiveAt: NOW });
    expect(live!.closedAt).toBeUndefined();
    expect(live!.tabs.map((t) => [t.chromeTabId, t.liveAtClose])).toEqual([[undefined, true]]);
    expect(mixed).toMatchObject({ state: 'hibernated', openAtShutdown: true });
    expect(user).toBe(o.windows[2]);
    expect(bin).toBe(o.windows[3]);
  });

  it('user actions clear open-at-shutdown', () => {
    const o = { windows: [win('w', { openAtShutdown: true, tabs: [tab('a')] })] };
    expect(renameWindow(o, 'w', 'N', NOW).windows[0]!.openAtShutdown).toBeUndefined();
    const live = {
      windows: [
        win('v', {
          chromeWindowId: 1,
          openAtShutdown: true,
          tabs: [tab('a', { chromeTabId: 11 })],
        }),
      ],
    };
    expect(hibernate(live, ['v'], NOW).outline.windows[0]!.openAtShutdown).toBeUndefined();
  });
});

describe('findRow', () => {
  it('finds windows, groups, and tabs by record id', () => {
    const o = {
      windows: [win('w', { groups: [group('g')], tabs: [tab('a', { groupId: 'g' })] })],
    };
    expect(findRow(o, 'w')).toEqual({ window: o.windows[0] });
    expect(findRow(o, 'a')!.tab).toBe(o.windows[0]!.tabs[0]);
    expect(findRow(o, 'g')!.group).toBe(o.windows[0]!.groups[0]);
    expect(findRow(o, 'nope')).toBeUndefined();
  });
});

describe('untrash', () => {
  it('brings trashed windows back hibernated, in place, and leaves the rest alone', () => {
    const o = {
      windows: [
        win('t1', { state: 'trashed', closedAt: 5, openAtShutdown: true, tabs: [tab('a')] }),
        win('h', { tabs: [tab('b')] }),
        win('t2', { state: 'trashed', closedAt: 6, tabs: [tab('c')] }),
        win('t3', { state: 'trashed', closedAt: 7, tabs: [tab('d')] }),
      ],
    };
    const r = untrash(o, ['t1', 'h', 't3', 'nope'], NOW);
    expect(r.windows.map((w) => [w.id, w.state])).toEqual([
      ['t1', 'hibernated'],
      ['h', 'hibernated'],
      ['t2', 'trashed'],
      ['t3', 'hibernated'],
    ]);
    expect(r.windows[0]).toMatchObject({ modifiedAt: NOW, openAtShutdown: true });
    expect(r.windows[0]!.closedAt).toBeUndefined();
    expect(r.windows[1]).toBe(o.windows[1]);
    expect(untrash(o, [], NOW)).toBe(o);
  });
});
