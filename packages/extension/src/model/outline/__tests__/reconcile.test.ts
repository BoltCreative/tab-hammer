import { describe, expect, it } from 'vitest';
import { mergeHibernated, reconcile, replaceTabId, type ReconcileInput } from '../reconcile';
import type { ChromeSnapshot, LiveGroup, LiveTab, Outline, TabRec } from '../types';
import { group, tab, win } from './recs';

const NOW = 5_000;
const INSTALL = 'install-x';

type TabSpec = Omit<LiveTab, 'windowId' | 'index'>;

/** A Chrome tab; url/title derive from the Chrome ID so `live()` records match it. */
function t(id: number, opts: Partial<TabSpec> = {}): TabSpec {
  return {
    id,
    groupId: -1,
    url: `https://e.test/${id}`,
    title: `t${id}`,
    active: false,
    discarded: false,
    ...opts,
  };
}

function g(id: number, windowId: number, opts: Partial<LiveGroup> = {}): LiveGroup {
  return { id, windowId, title: `g${id}`, color: 'blue', collapsed: false, ...opts };
}

function snap(s: { windows: Record<number, TabSpec[]>; groups?: LiveGroup[] }): ChromeSnapshot {
  const windowIds = Object.keys(s.windows).map(Number);
  return {
    windowIds,
    tabs: windowIds.flatMap((windowId) =>
      s.windows[windowId]!.map((spec, index) => ({ ...spec, windowId, index })),
    ),
    groups: s.groups ?? [],
  };
}

/** A live tab record in step with `t(chromeTabId)`. */
function live(id: string, chromeTabId: number, opts: Partial<TabRec> = {}): TabRec {
  return tab(id, {
    chromeTabId,
    url: `https://e.test/${chromeTabId}`,
    title: `t${chromeTabId}`,
    ...opts,
  });
}

function input(snapshot: ChromeSnapshot, closing: number[] = []): ReconcileInput {
  let n = 0;
  return {
    snapshot,
    closingWindowIds: new Set(closing),
    now: NOW,
    newId: () => `n${++n}`,
    installId: INSTALL,
  };
}

const ids = (tabs: TabRec[]) => tabs.map((x) => x.id);

describe('reconcile', () => {
  it('worker restart: known windows and tabs re-attach by Chrome ID, keeping record IDs', () => {
    const o: Outline = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          groups: [group('G', { chromeGroupId: 5, title: 'g5' })],
          tabs: [live('a', 11), live('b', 12, { groupId: 'G' })],
        }),
      ],
    };
    const same = reconcile(
      o,
      input(snap({ windows: { 1: [t(11), t(12, { groupId: 5 })] }, groups: [g(5, 1)] })),
    );
    expect(same.outline).toBe(o);
    expect(same.newProvisional).toEqual([]);

    const { outline } = reconcile(
      o,
      input(
        snap({
          windows: { 1: [t(11, { title: 'now' }), t(12, { groupId: 5 })] },
          groups: [g(5, 1)],
        }),
      ),
    );
    const w = outline.windows[0]!;
    expect(w.id).toBe('w');
    expect(w.tabs.map((x) => [x.id, x.chromeTabId, x.title])).toEqual([
      ['a', 11, 'now'],
      ['b', 12, 't12'],
    ]);
    expect(w.groups.map((x) => [x.id, x.chromeGroupId])).toEqual([['G', 5]]);
    expect(w.tabs[1]!.groupId).toBe('G');
  });

  it('live tab order follows Chrome; a hibernated tab stays after the neighbour it had', () => {
    const o = {
      windows: [win('w', { chromeWindowId: 1, tabs: [live('a', 11), tab('h'), live('b', 12)] })],
    };
    const { outline } = reconcile(o, input(snap({ windows: { 1: [t(12), t(11)] } })));
    expect(ids(outline.windows[0]!.tabs)).toEqual(['b', 'a', 'h']);
  });

  it('a hibernated tab whose preceding neighbour closed moves up to the next surviving one', () => {
    const o = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          tabs: [live('a', 11), live('b', 12), tab('h'), live('c', 13)],
        }),
      ],
    };
    const { outline } = reconcile(o, input(snap({ windows: { 1: [t(11), t(13)] } })));
    expect(ids(outline.windows[0]!.tabs)).toEqual(['a', 'h', 'c']);

    // With no surviving neighbour before them, a run of hibernated tabs goes first, in order.
    const old = [tab('h1'), tab('h2'), live('a', 11), live('b', 12)];
    expect(ids(mergeHibernated(old, [live('b', 12), live('n', 13)]))).toEqual([
      'h1',
      'h2',
      'b',
      'n',
    ]);
  });

  it('a closed tab is removed; a missed window close sends the window to the trash', () => {
    const o = {
      windows: [
        win('w1', { chromeWindowId: 1, tabs: [live('a', 11), live('b', 12)] }),
        win('w2', { chromeWindowId: 2, tabs: [live('c', 21)] }),
      ],
    };
    const { outline } = reconcile(o, input(snap({ windows: { 1: [t(11)] } })));
    const [w1, w2] = outline.windows;
    expect(ids(w1!.tabs)).toEqual(['a']);
    expect(w2).toMatchObject({ id: 'w2', state: 'trashed', closedAt: NOW });
    expect(w2!.chromeWindowId).toBeUndefined();
    expect(w2!.tabs.map((x) => [x.id, x.chromeTabId, x.liveAtClose])).toEqual([
      ['c', undefined, true],
    ]);
  });

  it('a window that is closing keeps its tabs', () => {
    const w1 = win('w1', {
      chromeWindowId: 1,
      tabs: [live('a', 11), live('b', 12), live('c', 13)],
    });
    const o = { windows: [w1] };
    const r = reconcile(o, input(snap({ windows: { 1: [t(11)] } }), [1]));
    expect(r.outline.windows[0]).toBe(w1);

    // Once Chrome has finished closing it, it goes to the trash with every tab.
    const gone = reconcile(o, input(snap({ windows: {} }), [1])).outline.windows[0]!;
    expect(gone.state).toBe('trashed');
    expect(ids(gone.tabs)).toEqual(['a', 'b', 'c']);
  });

  it('a new window holding a known tab is not provisional', () => {
    const o = { windows: [win('w1', { chromeWindowId: 1, tabs: [live('a', 11), live('b', 12)] })] };
    const r = reconcile(o, input(snap({ windows: { 1: [t(11)], 2: [t(12)] } })));
    expect(r.newProvisional).toEqual([]);
    expect(r.outline.windows).toHaveLength(2);
    const [w1, w2] = r.outline.windows;
    expect(ids(w1!.tabs)).toEqual(['a']);
    expect(w2).toMatchObject({
      state: 'live',
      chromeWindowId: 2,
      originInstallId: INSTALL,
      modifiedAt: NOW,
      lastLiveAt: NOW,
    });
    expect(w2!.provisional).toBeUndefined();
    expect(w2!.tabs.map((x) => [x.id, x.chromeTabId])).toEqual([['b', 12]]);
  });

  it('a window whose last tab was dragged into another window leaves no trash entry', () => {
    const o = {
      windows: [
        win('w1', { chromeWindowId: 1, tabs: [live('a', 11)] }),
        win('w2', { chromeWindowId: 2, tabs: [live('b', 21)] }),
      ],
    };
    const { outline } = reconcile(o, input(snap({ windows: { 2: [t(21), t(11)] } })));
    expect(outline.windows.map((w) => w.id)).toEqual(['w2']);
    expect(ids(outline.windows[0]!.tabs)).toEqual(['b', 'a']);
  });

  it('an unknown window becomes a provisional row at the bottom', () => {
    const o = {
      windows: [
        win('w1', { chromeWindowId: 1, tabs: [live('a', 11)] }),
        win('h', { tabs: [tab('x')] }),
      ],
    };
    const r = reconcile(
      o,
      input(
        snap({
          windows: { 1: [t(11)], 3: [t(31, { launchUrl: 'https://e.test/launch' })], 4: [] },
        }),
      ),
    );
    expect(r.newProvisional).toEqual([3]);
    expect(r.outline.windows.map((w) => w.id)).toEqual(['w1', 'h', 'n2']);
    const w = r.outline.windows[2]!;
    expect(w).toMatchObject({
      state: 'live',
      chromeWindowId: 3,
      provisional: true,
      originInstallId: INSTALL,
      modifiedAt: NOW,
      lastLiveAt: NOW,
      groups: [],
    });
    expect(w.tabs).toEqual([
      {
        id: 'n1',
        chromeTabId: 31,
        url: 'https://e.test/31',
        title: 't31',
        launchUrl: 'https://e.test/launch',
        modifiedAt: NOW,
      },
    ]);
  });

  it('stamps modifiedAt only on records that changed', () => {
    const o = {
      windows: [
        win('w1', {
          chromeWindowId: 1,
          tabs: [live('a', 11, { launchUrl: 'https://e.test/old' }), live('b', 12)],
        }),
        win('w2', { chromeWindowId: 2, tabs: [live('c', 21)] }),
      ],
    };
    const { outline } = reconcile(
      o,
      input(
        snap({
          windows: {
            1: [t(11, { launchUrl: 'https://e.test/new' }), t(12, { title: 'retitled' })],
            2: [t(21, { launchUrl: 'https://e.test/launch' })],
          },
        }),
      ),
    );
    const [w1, w2] = outline.windows;
    expect(w1!.modifiedAt).toBe(NOW);
    expect(w1!.tabs.map((x) => [x.id, x.modifiedAt, x.launchUrl])).toEqual([
      ['a', 0, 'https://e.test/old'], // launchUrl is only filled in, never overwritten
      ['b', NOW, undefined],
    ]);
    // Filling in launchUrl (machine-local) is not a persisted change.
    expect(w2!.modifiedAt).toBe(0);
    expect(w2!.tabs[0]).toMatchObject({ modifiedAt: 0, launchUrl: 'https://e.test/launch' });
  });

  it('groups follow Chrome for live tabs and keep hibernated members', () => {
    const o = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          groups: [
            group('G', { chromeGroupId: 5, title: 'old' }),
            group('H', { chromeGroupId: 6 }),
            group('K', { chromeGroupId: 8 }),
          ],
          tabs: [
            live('a', 11, { groupId: 'G' }),
            tab('h', { groupId: 'G' }),
            live('c', 13, { groupId: 'G' }),
            live('b', 12, { groupId: 'H' }),
            tab('k', { groupId: 'K' }),
            live('d', 14, { groupId: 'K' }),
          ],
        }),
      ],
    };
    const { outline } = reconcile(
      o,
      input(
        snap({
          windows: {
            1: [t(11, { groupId: 7 }), t(13, { groupId: 5 }), t(12), t(14)],
          },
          groups: [g(5, 1, { title: 'new', color: 'red' }), g(7, 1)],
        }),
      ),
    );
    const w = outline.windows[0]!;
    expect(w.tabs.map((x) => [x.id, x.groupId])).toEqual([
      ['a', 'n1'],
      ['h', 'G'],
      ['c', 'G'],
      ['b', undefined],
      ['k', 'K'],
      ['d', undefined],
    ]);
    const byId = new Map(w.groups.map((x) => [x.id, x]));
    expect([...byId.keys()].sort()).toEqual(['G', 'K', 'n1']); // H had no members left
    expect(byId.get('G')).toMatchObject({
      chromeGroupId: 5,
      title: 'new',
      color: 'red',
      modifiedAt: NOW,
    });
    expect(byId.get('K')!.chromeGroupId).toBeUndefined(); // Chrome group gone, hibernated member keeps it
    expect(byId.get('K')!.modifiedAt).toBe(0);
    expect(byId.get('n1')).toMatchObject({ chromeGroupId: 7, title: 'g7', modifiedAt: NOW });
  });

  it('a group moved to another window takes its record with it', () => {
    const o = {
      windows: [
        win('w1', {
          chromeWindowId: 1,
          groups: [group('G', { chromeGroupId: 5, title: 'g5' })],
          tabs: [live('a', 11, { groupId: 'G' }), tab('h', { groupId: 'G' }), live('b', 12)],
        }),
        win('w2', { chromeWindowId: 2, tabs: [live('c', 21)] }),
      ],
    };
    const { outline } = reconcile(
      o,
      input(
        snap({ windows: { 1: [t(12)], 2: [t(21), t(11, { groupId: 5 })] }, groups: [g(5, 2)] }),
      ),
    );
    const [w1, w2] = outline.windows;
    expect(w2!.tabs.map((x) => [x.id, x.groupId])).toEqual([
      ['c', undefined],
      ['a', 'G'],
    ]);
    expect(w2!.groups.map((x) => [x.id, x.chromeGroupId])).toEqual([['G', 5]]);
    expect(w2!.modifiedAt).toBe(NOW);
    // The hibernated member left behind keeps its grouping in a copy of the group.
    expect(w1!.tabs.map((x) => [x.id, x.groupId])).toEqual([
      ['h', 'n1'],
      ['b', undefined],
    ]);
    expect(w1!.groups).toEqual([
      { id: 'n1', title: 'g5', color: 'blue', collapsed: false, modifiedAt: NOW },
    ]);
  });

  it('unchanged windows come back by reference', () => {
    const w2 = win('w2', { chromeWindowId: 2, tabs: [live('c', 21)] });
    const hib = win('h', { tabs: [tab('x')] });
    const trashed = win('t', { state: 'trashed', closedAt: 1, tabs: [tab('y')] });
    const o = {
      windows: [win('w1', { chromeWindowId: 1, tabs: [live('a', 11)] }), w2, hib, trashed],
    };
    const { outline } = reconcile(
      o,
      input(snap({ windows: { 1: [t(11, { title: 'x' })], 2: [t(21)] } })),
    );
    expect(outline.windows[0]).not.toBe(o.windows[0]);
    expect(outline.windows[1]).toBe(w2);
    expect(outline.windows[2]).toBe(hib);
    expect(outline.windows[3]).toBe(trashed);
  });
});

describe('replaceTabId', () => {
  it('replaceTabId swaps a prerendered or discarded tab ID in place', () => {
    const w2 = win('w2', { chromeWindowId: 2, tabs: [live('c', 21)] });
    const o = {
      windows: [win('w1', { chromeWindowId: 1, tabs: [live('a', 11), live('b', 12)] }), w2],
    };
    const next = replaceTabId(o, 99, 12);
    expect(next.windows[0]!.tabs.map((x) => [x.id, x.chromeTabId, x.modifiedAt])).toEqual([
      ['a', 11, 0],
      ['b', 99, 0],
    ]);
    expect(next.windows[0]!.modifiedAt).toBe(0);
    expect(next.windows[1]).toBe(w2);
    expect(replaceTabId(o, 99, 404)).toBe(o);
  });
});
