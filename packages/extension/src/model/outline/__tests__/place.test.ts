import { describe, expect, it } from 'vitest';
import { attachGroup, placeTabs } from '../place';
import type { Outline } from '../types';
import { group, tab, win } from './recs';

const NOW = 1_000_000;

function ids(): () => string {
  let n = 0;
  return () => `new${++n}`;
}

const tabIds = (o: Outline, windowId: string): string[] =>
  o.windows.find((w) => w.id === windowId)!.tabs.map((t) => t.id);

describe('placeTabs', () => {
  it('moves hibernated tabs between windows without effects', () => {
    const o: Outline = {
      windows: [win('a', { tabs: [tab('a1'), tab('a2')] }), win('b', { tabs: [tab('b1')] })],
    };
    const r = placeTabs(
      o,
      { windowId: 'b', beforeTabId: 'b1', tabs: [{ id: 'a2', groupId: null }] },
      NOW,
      ids(),
    );
    expect(tabIds(r.outline, 'a')).toEqual(['a1']);
    expect(tabIds(r.outline, 'b')).toEqual(['a2', 'b1']);
    expect(r.effects).toEqual({ closeWindows: [], closeTabs: [] });
    expect(r.regroup).toEqual([]);
  });

  it('deletes a hibernated source window left with no tabs', () => {
    const o: Outline = {
      windows: [win('a', { tabs: [tab('a1')] }), win('b', { tabs: [tab('b1')] })],
    };
    const r = placeTabs(
      o,
      { windowId: 'b', beforeTabId: null, tabs: [{ id: 'a1', groupId: null }] },
      NOW,
      ids(),
    );
    expect(r.outline.windows.map((w) => w.id)).toEqual(['b']);
    expect(tabIds(r.outline, 'b')).toEqual(['b1', 'a1']);
  });

  it('live tabs dropped into a hibernated window are hibernated there', () => {
    const o: Outline = {
      windows: [
        win('a', {
          chromeWindowId: 1,
          tabs: [tab('a1', { chromeTabId: 11 }), tab('a2', { chromeTabId: 12 }), tab('ah')],
        }),
        win('b', { tabs: [tab('b1')] }),
      ],
    };
    const r = placeTabs(
      o,
      { windowId: 'b', beforeTabId: null, tabs: [{ id: 'a2', groupId: null }] },
      NOW,
      ids(),
    );
    expect(r.effects).toEqual({ closeWindows: [], closeTabs: [12] });
    const b = r.outline.windows[1]!;
    expect(b.tabs.map((t) => [t.id, t.chromeTabId])).toEqual([
      ['b1', undefined],
      ['a2', undefined],
    ]);
    const a = r.outline.windows[0]!;
    expect(a.state).toBe('live');
    expect(a.tabs.map((t) => t.id)).toEqual(['a1', 'ah']);
  });

  it('a live source window left with only hibernated tabs becomes hibernated', () => {
    const o: Outline = {
      windows: [
        win('a', { chromeWindowId: 1, tabs: [tab('a1', { chromeTabId: 11 }), tab('ah')] }),
        win('b', { tabs: [tab('b1')] }),
      ],
    };
    const r = placeTabs(
      o,
      { windowId: 'b', beforeTabId: null, tabs: [{ id: 'a1', groupId: null }] },
      NOW,
      ids(),
    );
    expect(r.effects.closeTabs).toEqual([11]);
    const a = r.outline.windows[0]!;
    expect(a.state).toBe('hibernated');
    expect(a.chromeWindowId).toBeUndefined();
    expect(a.tabs.map((t) => t.id)).toEqual(['ah']);
  });

  it('keeps live and hibernated moved tabs in their relative order', () => {
    const o: Outline = {
      windows: [
        win('a', {
          chromeWindowId: 1,
          tabs: [tab('l1', { chromeTabId: 11 }), tab('h1'), tab('l2', { chromeTabId: 12 })],
        }),
        win('b', {
          chromeWindowId: 2,
          tabs: [tab('b1', { chromeTabId: 21 }), tab('b2', { chromeTabId: 22 })],
        }),
      ],
    };
    const r = placeTabs(
      o,
      {
        windowId: 'b',
        beforeTabId: 'b2',
        tabs: [
          { id: 'l1', groupId: null },
          { id: 'h1', groupId: null },
          { id: 'l2', groupId: null },
        ],
      },
      NOW,
      ids(),
    );
    expect(r.outline.windows.map((w) => w.id)).toEqual(['b']);
    expect(tabIds(r.outline, 'b')).toEqual(['b1', 'l1', 'h1', 'l2', 'b2']);
    expect(r.effects).toEqual({ closeWindows: [], closeTabs: [] });
    expect(r.outline.windows[0]!.tabs.find((t) => t.id === 'l1')!.chromeTabId).toBe(11);
  });

  it('a hibernated tab joining a group takes the group; a live one does not', () => {
    const o: Outline = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          groups: [group('g', { chromeGroupId: 50 })],
          tabs: [
            tab('x', { chromeTabId: 10, groupId: 'g' }),
            tab('l', { chromeTabId: 11 }),
            tab('h'),
          ],
        }),
      ],
    };
    const r = placeTabs(
      o,
      {
        windowId: 'w',
        beforeTabId: null,
        tabs: [
          { id: 'l', groupId: 'g' },
          { id: 'h', groupId: 'g' },
        ],
      },
      NOW,
      ids(),
    );
    const w = r.outline.windows[0]!;
    expect(w.tabs.map((t) => [t.id, t.groupId])).toEqual([
      ['x', 'g'],
      ['l', undefined],
      ['h', 'g'],
    ]);
    expect(r.regroup).toEqual([]);
  });

  it('live tabs placed into a group with no live tabs ask to regroup', () => {
    const o: Outline = {
      windows: [
        win('w', {
          chromeWindowId: 1,
          groups: [group('g')],
          tabs: [tab('h', { groupId: 'g' }), tab('l1', { chromeTabId: 11 })],
        }),
        win('v', {
          chromeWindowId: 2,
          tabs: [tab('l2', { chromeTabId: 12 }), tab('v1', { chromeTabId: 13 })],
        }),
      ],
    };
    const r = placeTabs(
      o,
      {
        windowId: 'w',
        beforeTabId: null,
        tabs: [
          { id: 'l1', groupId: 'g' },
          { id: 'l2', groupId: 'g' },
        ],
      },
      NOW,
      ids(),
    );
    expect(r.regroup).toEqual([{ groupId: 'g', chromeWindowId: 1, chromeTabIds: [11, 12] }]);
    expect(r.outline.windows[0]!.groups.map((g) => g.id)).toEqual(['g']);
  });

  it('moves a group record whose tabs all left, and copies one still in use', () => {
    const o: Outline = {
      windows: [
        win('a', {
          groups: [group('g'), group('k')],
          tabs: [
            tab('g1', { groupId: 'g' }),
            tab('k1', { groupId: 'k' }),
            tab('k2', { groupId: 'k' }),
          ],
        }),
        win('b', { tabs: [tab('b1')] }),
      ],
    };
    const r = placeTabs(
      o,
      {
        windowId: 'b',
        beforeTabId: null,
        tabs: [
          { id: 'g1', groupId: 'g' },
          { id: 'k1', groupId: 'k' },
        ],
      },
      NOW,
      ids(),
    );
    const [a, b] = r.outline.windows;
    expect(a!.groups.map((g) => g.id)).toEqual(['k']);
    expect(b!.groups.map((g) => g.id)).toEqual(['g', 'new1']);
    expect(b!.groups[1]).toMatchObject({ title: 'k', color: 'blue' });
    expect(b!.tabs.map((t) => [t.id, t.groupId])).toEqual([
      ['b1', undefined],
      ['g1', 'g'],
      ['k1', 'new1'],
    ]);
  });

  it('stamps modifiedAt on the windows and regrouped tabs it changed, nothing else', () => {
    const o: Outline = {
      windows: [
        win('a', {
          groups: [group('g')],
          tabs: [tab('a1', { groupId: 'g' }), tab('a2'), tab('a3')],
        }),
        win('b', { tabs: [tab('b1')] }),
        win('c', { tabs: [tab('c1')] }),
      ],
    };
    const r = placeTabs(
      o,
      {
        windowId: 'b',
        beforeTabId: null,
        tabs: [
          { id: 'a1', groupId: 'g' }, // group unchanged
          { id: 'a2', groupId: 'g' }, // joins the group
        ],
      },
      NOW,
      ids(),
    );
    const [a, b, c] = r.outline.windows;
    expect(a!.modifiedAt).toBe(NOW);
    expect(b!.modifiedAt).toBe(NOW);
    expect(c).toBe(o.windows[2]);
    expect(b!.tabs.map((t) => [t.id, t.modifiedAt])).toEqual([
      ['b1', 0],
      ['a1', 0],
      ['a2', NOW],
    ]);
    expect(a!.tabs[0]).toBe(o.windows[0]!.tabs[2]);
    expect(b!.groups[0]!.modifiedAt).toBe(0);
  });

  it('ignores a trashed target', () => {
    const o: Outline = {
      windows: [
        win('a', { tabs: [tab('a1')] }),
        win('t', { state: 'trashed', closedAt: 1, tabs: [tab('t1')] }),
      ],
    };
    const r = placeTabs(
      o,
      { windowId: 't', beforeTabId: null, tabs: [{ id: 'a1', groupId: null }] },
      NOW,
      ids(),
    );
    expect(r.outline).toBe(o);
  });
});

describe('attachGroup', () => {
  it('gives the group record its Chrome ID', () => {
    const o: Outline = {
      windows: [
        win('x', { tabs: [tab('x1')] }),
        win('w', { chromeWindowId: 1, groups: [group('g')], tabs: [] }),
      ],
    };
    const next = attachGroup(o, 'g', 50);
    expect(next.windows[1]!.groups[0]).toEqual(group('g', { chromeGroupId: 50 }));
    expect(next.windows[0]).toBe(o.windows[0]);
    expect(attachGroup(o, 'missing', 50)).toBe(o);
  });
});
