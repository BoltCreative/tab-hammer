import { describe, expect, it } from 'vitest';
import { matchRestored } from '../applyMatch';
import type { Outline } from '../types';
import { group, tab, win } from './recs';

const NOW = 1000;
const url = (id: string) => `https://e.test/${id}`;

function trashed(id: string, tabIds: string[], opts = {}) {
  return win(id, {
    state: 'trashed',
    closedAt: 5,
    openAtShutdown: true,
    name: 'Work',
    tabs: tabIds.map((t) => tab(t, { liveAtClose: true })),
    ...opts,
  });
}
function prov(
  id: string,
  chromeWindowId: number,
  tabs: ReturnType<typeof tab>[],
  groups = [] as ReturnType<typeof group>[],
) {
  return win(id, { chromeWindowId, provisional: true, tabs, groups });
}
const ptab = (id: string, n: number, opts = {}) =>
  tab(id, { chromeTabId: n, url: url(id.replace("'", '')), ...opts });

describe('matchRestored', () => {
  it('re-links a restored window into its trashed row, in place, with the same IDs and name', () => {
    const x = win('X', { chromeWindowId: 1, tabs: [ptab('x', 1)] });
    const o: Outline = {
      windows: [x, trashed('C', ['a', 'b']), prov('P', 9, [ptab("a'", 11), ptab("b'", 12)])],
    };
    const r = matchRestored(o, ['P'], NOW);
    expect(r.windows.map((w) => w.id)).toEqual(['X', 'C']);
    expect(r.windows[0]).toBe(x);
    const c = r.windows[1]!;
    expect(c).toMatchObject({ state: 'live', chromeWindowId: 9, name: 'Work', lastLiveAt: NOW });
    expect(c).not.toHaveProperty('closedAt');
    expect(c).not.toHaveProperty('openAtShutdown');
    expect(c).not.toHaveProperty('provisional');
    expect(c.tabs.map((t) => [t.id, t.chromeTabId])).toEqual([
      ['a', 11],
      ['b', 12],
    ]);
  });

  it('partial match: extra restored tabs become new rows, missing saved tabs stay hibernated in place', () => {
    const o: Outline = {
      windows: [
        trashed('C', ['a', 'm', 'b']),
        prov('P', 9, [ptab('a', 11), ptab('n', 12), ptab('b', 13)]),
      ],
    };
    const c = matchRestored(o, ['P'], NOW).windows[0]!;
    expect(c.tabs.map((t) => t.id)).toEqual(['a', 'm', 'n', 'b']);
    expect(c.tabs.find((t) => t.id === 'm')!.chromeTabId).toBeUndefined();
  });

  it('hibernated tabs of a partly live window are not scored and stay hibernated', () => {
    const cw = win('C', {
      state: 'hibernated',
      openAtShutdown: true,
      tabs: [
        tab('a', { liveAtClose: true }),
        tab('h', { liveAtClose: false }),
        tab('b', { liveAtClose: true }),
      ],
    });
    const o: Outline = { windows: [cw, prov('P', 9, [ptab('a', 11), ptab('b', 12)])] };
    const c = matchRestored(o, ['P'], NOW).windows[0]!;
    expect(c.tabs.map((t) => t.id)).toEqual(['a', 'h', 'b']);
    expect(c.tabs[1]!.chromeTabId).toBeUndefined();
  });

  it('user-hibernated windows are never matched', () => {
    const h = win('H', {
      tabs: [tab('a', { liveAtClose: true }), tab('b', { liveAtClose: true })],
    });
    const o: Outline = { windows: [h, prov('P', 9, [ptab('a', 11), ptab('b', 12)])] };
    const r = matchRestored(o, ['P'], NOW);
    expect(r.windows[0]).toBe(h);
  });

  it('a restored group re-attaches to the saved group holding most of its tabs', () => {
    const cw = trashed('C', ['a', 'b', 'c'], {
      groups: [group('G1', { title: 'old' }), group('G2')],
      tabs: [
        tab('a', { liveAtClose: true, groupId: 'G1' }),
        tab('b', { liveAtClose: true, groupId: 'G1' }),
        tab('c', { liveAtClose: true, groupId: 'G2' }),
      ],
    });
    const p = prov(
      'P',
      9,
      [
        ptab('a', 11, { groupId: 'PG' }),
        ptab('b', 12, { groupId: 'PG' }),
        ptab('c', 13, { groupId: 'PH' }),
      ],
      [
        group('PG', { chromeGroupId: 5, title: 'new', color: 'red' }),
        group('PH', { chromeGroupId: 6, title: 'G2' }),
      ],
    );
    const c = matchRestored({ windows: [cw, p] }, ['P'], NOW).windows[0]!;
    expect(c.groups.map((g) => [g.id, g.chromeGroupId, g.title, g.color])).toEqual([
      ['G1', 5, 'new', 'red'],
      ['G2', 6, 'G2', 'blue'],
    ]);
    expect(c.tabs.map((t) => t.groupId)).toEqual(['G1', 'G1', 'G2']);
  });

  it('an unmatched provisional window just loses the flag', () => {
    const p = prov('P', 9, [ptab('z', 11), ptab('y', 12)]);
    const r = matchRestored({ windows: [trashed('C', ['a', 'b']), p] }, ['P'], NOW);
    const out = r.windows[1]!;
    expect(out).not.toHaveProperty('provisional');
    expect(out).toMatchObject({ id: 'P', chromeWindowId: 9, modifiedAt: p.modifiedAt });
  });

  it('two restored windows match two trash entries in one pass', () => {
    const o: Outline = {
      windows: [
        trashed('C1', ['a', 'b']),
        trashed('C2', ['c', 'd']),
        prov('P2', 8, [ptab('c', 21), ptab('d', 22)]),
        prov('P1', 9, [ptab('a', 11), ptab('b', 12)]),
      ],
    };
    const r = matchRestored(o, ['P1', 'P2'], NOW);
    expect(r.windows.map((w) => [w.id, w.chromeWindowId])).toEqual([
      ['C1', 9],
      ['C2', 8],
    ]);
  });

  it('stamps modifiedAt only on the matched window and on tabs whose fields changed', () => {
    const cw = trashed('C', ['a', 'b'], {
      tabs: [
        tab('a', { liveAtClose: true, modifiedAt: 7 }),
        tab('b', { liveAtClose: true, modifiedAt: 7 }),
        tab('h', { modifiedAt: 7 }),
      ],
    });
    const o: Outline = {
      windows: [
        cw,
        prov('P', 9, [ptab('a', 11, { title: 'a' }), ptab('b', 12, { title: 'renamed' })]),
      ],
    };
    const c = matchRestored(o, ['P'], NOW).windows[0]!;
    expect(c.modifiedAt).toBe(NOW);
    expect(Object.fromEntries(c.tabs.map((t) => [t.id, t.modifiedAt]))).toEqual({
      a: 7,
      b: NOW,
      h: 7,
    });
  });
});
