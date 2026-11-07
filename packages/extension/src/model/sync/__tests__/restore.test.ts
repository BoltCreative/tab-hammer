import { describe, expect, it } from 'vitest';
import { group, tab, win } from '../../outline/__tests__/recs';
import type { Outline } from '../../outline/types';
import { restoreWindows, selfRestoreWindows } from '../restore';
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

  it("keeps the file's window order among the windows it adds", () => {
    const r = restoreWindows({ windows: [] }, [swin('c'), swin('a'), swin('b')], opts());
    expect(r.outline.windows.map((w) => w.id)).toEqual(['c', 'a', 'b']);
  });

  it('skips windows already present (by ID) and leaves them untouched', () => {
    const a = win('a', { name: 'mine', tabs: [tab('a1')] });
    const local: Outline = { windows: [a] };
    const r = restoreWindows(local, [swin('a', { name: 'theirs' })], opts());
    expect(r.added).toEqual([]);
    expect(r.outline).toBe(local);
    expect(r.outline.windows[0]).toBe(a);
  });

  it('brings a window that is in the local trash back out, hibernated, in its own place', () => {
    const local: Outline = {
      windows: [
        win('a', { state: 'trashed', closedAt: 1, name: 'mine', tabs: [tab('a1'), tab('a2')] }),
        win('b', { tabs: [tab('b1')] }),
      ],
    };
    // The local record is kept (it's this computer's latest), only taken out of the trash.
    const r = restoreWindows(local, [swin('a', { name: 'theirs' }), swin('c')], opts());
    expect(r.added).toEqual(['c']);
    expect(r.untrashed).toEqual(['a']);
    const a = r.outline.windows[0]!;
    expect(a).toMatchObject({ id: 'a', state: 'hibernated', name: 'mine', modifiedAt: 50 });
    expect(a.closedAt).toBeUndefined();
    expect(a.tabs.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(r.outline.windows.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves a locally trashed window in the trash when the file has it trashed too', () => {
    const local: Outline = {
      windows: [win('a', { state: 'trashed', closedAt: 1, tabs: [tab('a1')] })],
    };
    const r = restoreWindows(local, [swin('a', { state: 'trashed', closedAt: 1 })], opts());
    expect(r).toMatchObject({ added: [], untrashed: [] });
    expect(r.outline).toBe(local);
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

describe('selfRestoreWindows', () => {
  const url = (n: string) => `https://e.test/${n}`;
  // What Chrome has open on the wiped profile: fresh records, live.
  const openNow = () =>
    win('fresh', {
      chromeWindowId: 7,
      tabs: [
        tab('ft1', { chromeTabId: 70, url: url('a'), title: 'A' }),
        tab('ft2', { chromeTabId: 71, url: url('b'), title: 'B' }),
      ],
    });
  const fileLive = () =>
    swin('saved', {
      state: 'live',
      name: 'Work',
      tabs: [stab('st1', { url: url('a') }), stab('st2', { url: url('b') })],
    });
  const run = (o: Outline, ws: Parameters<typeof selfRestoreWindows>[1]) =>
    selfRestoreWindows(o, ws, { now: 99, newId: ids() });

  it("brings windows back in the file's order, whatever order Chrome reopened them in", () => {
    const live = (id: string, n: number, page: string) =>
      win(id, {
        chromeWindowId: n,
        tabs: [tab(`${id}-t`, { chromeTabId: n * 10, url: url(page) })],
      });
    const saved = (id: string, page: string) =>
      swin(id, { state: 'live', tabs: [stab(`${id}-s`, { url: url(page) })] });
    const r = run({ windows: [live('f1', 1, 'x'), live('f2', 2, 'y'), live('f3', 3, 'z')] }, [
      saved('Z', 'z'),
      saved('H', 'h'),
      saved('X', 'x'),
      saved('Y', 'y'),
    ]);
    expect(r.outline.windows.map((w) => [w.id, w.chromeWindowId])).toEqual([
      ['Z', 3],
      ['H', undefined],
      ['X', 1],
      ['Y', 2],
    ]);
  });

  it('re-links a live window to its saved record instead of showing it twice', () => {
    const r = run({ windows: [openNow()] }, [fileLive()]);
    expect(r.outline.windows).toHaveLength(1);
    const w = r.outline.windows[0]!;
    expect(w).toMatchObject({ id: 'saved', name: 'Work', state: 'live', chromeWindowId: 7 });
    expect(w.openAtShutdown).toBeUndefined();
    expect(w.tabs.map((t) => [t.id, t.chromeTabId])).toEqual([
      ['st1', 70],
      ['st2', 71],
    ]);
  });

  it('re-links a partial match, keeping the unrestored tab hibernated', () => {
    const saved = fileLive();
    saved.tabs.push(stab('st3', { url: url('c') }));
    const r = run({ windows: [openNow()] }, [saved]);
    expect(r.outline.windows).toHaveLength(1);
    expect(r.outline.windows[0]!.tabs.map((t) => [t.id, t.chromeTabId !== undefined])).toEqual([
      ['st1', true],
      ['st2', true],
      ['st3', false],
    ]);
  });

  it('never re-links a window that was hibernated in the file', () => {
    const r = run({ windows: [openNow()] }, [{ ...fileLive(), state: 'hibernated' }]);
    expect(r.outline.windows.map((w) => [w.id, w.state])).toEqual([
      ['fresh', 'live'],
      ['saved', 'hibernated'],
    ]);
    expect(r.outline.windows[1]!.openAtShutdown).toBeUndefined();
  });

  it('leaves an unmatched live window from the file hibernated, as a re-link candidate', () => {
    const other = swin('gone', { state: 'live', tabs: [stab('g1', { url: url('z') })] });
    const r = run({ windows: [openNow()] }, [other]);
    expect(r.outline.windows.map((w) => [w.id, w.state])).toEqual([
      ['fresh', 'live'],
      ['gone', 'hibernated'],
    ]);
    expect(r.outline.windows[1]).toMatchObject({ openAtShutdown: true });
    expect(r.outline.windows[1]!.tabs[0]!.liveAtClose).toBe(true);
  });

  it('keeps the trash, and with nothing to add changes nothing', () => {
    const r = run({ windows: [] }, [swin('t', { state: 'trashed', closedAt: 4 })]);
    expect(r.outline.windows.map((w) => [w.id, w.state])).toEqual([['t', 'trashed']]);
    const local: Outline = { windows: [openNow()] };
    expect(run(local, []).outline).toBe(local);
  });

  it('plain Restore all never marks windows for re-linking', () => {
    const r = restoreWindows({ windows: [] }, [fileLive()], opts());
    expect(r.outline.windows[0]!.openAtShutdown).toBeUndefined();
    expect(r.outline.windows[0]!.tabs.some((t) => t.liveAtClose)).toBe(false);
  });
});
