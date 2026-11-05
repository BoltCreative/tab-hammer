import { describe, expect, it } from 'vitest';
import { group, tab, win } from '../../outline/__tests__/recs';
import type { Outline } from '../../outline/types';
import { restoreWindows } from '../restore';
import { sgroup, stab, swin } from './files';

function ids() {
  let n = 0;
  return () => `new-${++n}`;
}
const opts = (keepTrash = false) => ({ now: 50, newId: ids(), keepTrash });

describe('restoreWindows', () => {
  it('appends missing windows, hibernated, at the bottom', () => {
    const local: Outline = { windows: [win('a', { chromeWindowId: 1, tabs: [tab('a1')] })] };
    const r = restoreWindows(local, [swin('b', { state: 'live' }), swin('c')], opts());
    expect(r.added).toEqual(['b', 'c']);
    expect(r.outline.windows.map((w) => [w.id, w.state])).toEqual([
      ['a', 'live'],
      ['b', 'hibernated'],
      ['c', 'hibernated'],
    ]);
    expect(r.outline.windows[1]!.tabs.every((t) => t.chromeTabId === undefined)).toBe(true);
    expect(r.outline.windows[1]!.chromeWindowId).toBeUndefined();
  });

  it('skips windows already present (by ID) and leaves them untouched', () => {
    const a = win('a', { name: 'mine', tabs: [tab('a1')] });
    const local: Outline = { windows: [a] };
    const r = restoreWindows(local, [swin('a', { name: 'theirs' })], opts());
    expect(r.added).toEqual([]);
    expect(r.outline).toBe(local);
    expect(r.outline.windows[0]).toBe(a);
  });

  it('skips a window present only in the local trash', () => {
    const local: Outline = { windows: [win('a', { state: 'trashed', closedAt: 1 })] };
    expect(restoreWindows(local, [swin('a')], opts()).added).toEqual([]);
  });

  it('leaves the file trash out of Restore all', () => {
    const r = restoreWindows(
      { windows: [] },
      [swin('t', { state: 'trashed', closedAt: 3 })],
      opts(),
    );
    expect(r.added).toEqual([]);
  });

  it('keeps the file trash as trash for self-restore', () => {
    const r = restoreWindows(
      { windows: [] },
      [swin('t', { state: 'trashed', closedAt: 3 }), swin('t2', { state: 'trashed' })],
      opts(true),
    );
    expect(r.outline.windows.map((w) => [w.id, w.state, w.closedAt])).toEqual([
      ['t', 'trashed', 3],
      ['t2', 'trashed', 50],
    ]);
  });

  it('drops closedAt on a window coming in hibernated', () => {
    const r = restoreWindows({ windows: [] }, [swin('b', { closedAt: 9 })], opts());
    expect(r.outline.windows[0]!.closedAt).toBeUndefined();
  });

  it('skips windows with no tabs', () => {
    expect(restoreWindows({ windows: [] }, [swin('e', { tabs: [] })], opts()).added).toEqual([]);
  });

  it('gives a tab or group whose ID is taken a fresh ID, keeping membership', () => {
    // t1 and g1 were moved into window a since the file was written.
    const local: Outline = {
      windows: [win('a', { tabs: [tab('t1', { groupId: 'g1' })], groups: [group('g1')] })],
    };
    const r = restoreWindows(
      local,
      [
        swin('b', {
          groups: [sgroup('g1'), sgroup('g2')],
          tabs: [stab('t1', { groupId: 'g1' }), stab('t2', { groupId: 'g2' })],
        }),
      ],
      opts(),
    );
    const b = r.outline.windows[1]!;
    expect(b.groups.map((g) => g.id)).toEqual(['new-1', 'g2']);
    expect(b.tabs.map((t) => [t.id, t.groupId])).toEqual([
      ['new-2', 'new-1'],
      ['t2', 'g2'],
    ]);
    expect(r.outline.windows[0]).toBe(local.windows[0]);
  });

  it('does not mutate its inputs', () => {
    const local: Outline = { windows: [win('a', { tabs: [tab('a1')] })] };
    const source = [swin('b')];
    const before = JSON.stringify([local, source]);
    restoreWindows(local, source, opts());
    expect(JSON.stringify([local, source])).toBe(before);
  });
});
