import { describe, expect, it } from 'vitest';
import { matchRestored } from '../applyMatch';
import { startFresh } from '../lifecycle';
import { moveWindows, placeWindowAfter, stepWindow } from '../order';
import type { Outline } from '../types';
import { tab, win } from './recs';

const ids = (o: Outline) => o.windows.map((w) => w.id);
const outline = (...names: string[]): Outline => ({ windows: names.map((n) => win(n)) });

describe('moveWindows', () => {
  it('moves a window before or after another', () => {
    const o = outline('a', 'b', 'c', 'd');
    expect(ids(moveWindows(o, ['d'], 'b', 'before'))).toEqual(['a', 'd', 'b', 'c']);
    expect(ids(moveWindows(o, ['a'], 'c', 'after'))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(moveWindows(o, ['a'], 'd', 'after'))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves several windows as a block, in their outline order', () => {
    const o = outline('a', 'b', 'c', 'd', 'e');
    expect(ids(moveWindows(o, ['d', 'a'], 'c', 'after'))).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('keeps the window records themselves (an order change stamps nothing)', () => {
    const o = outline('a', 'b');
    const next = moveWindows(o, ['b'], 'a', 'before');
    expect(next.windows[0]).toBe(o.windows[1]);
    expect(next.windows[1]).toBe(o.windows[0]);
  });

  it('is unchanged for an unknown or moved anchor, or a no-op move', () => {
    const o = outline('a', 'b', 'c');
    expect(moveWindows(o, ['a'], 'zz', 'after')).toBe(o);
    expect(moveWindows(o, ['a', 'b'], 'b', 'after')).toBe(o);
    expect(moveWindows(o, ['b'], 'a', 'after')).toBe(o);
    expect(moveWindows(o, ['zz'], 'a', 'before')).toBe(o);
  });

  it('moves hibernated windows and steps around trashed ones in place', () => {
    const o: Outline = {
      windows: [
        win('live', { chromeWindowId: 1 }),
        win('t', { state: 'trashed', closedAt: 1 }),
        win('h'),
      ],
    };
    expect(ids(moveWindows(o, ['h'], 'live', 'before'))).toEqual(['h', 'live', 't']);
  });
});

describe('placeWindowAfter (a new window)', () => {
  it('lands right after the given window', () => {
    expect(ids(placeWindowAfter(outline('a', 'b', 'c', 'n'), 'n', 'a'))).toEqual([
      'a',
      'n',
      'b',
      'c',
    ]);
  });

  it('goes to the end without an anchor, or with an unknown one', () => {
    expect(ids(placeWindowAfter(outline('n', 'a', 'b'), 'n', null))).toEqual(['a', 'b', 'n']);
    expect(ids(placeWindowAfter(outline('n', 'a'), 'n', 'gone'))).toEqual(['a', 'n']);
    const o = outline('a', 'n');
    expect(placeWindowAfter(o, 'n', null)).toBe(o);
  });
});

describe('stepWindow (keyboard)', () => {
  it('swaps with the shown neighbour, skipping trash', () => {
    const o: Outline = {
      windows: [win('a'), win('t', { state: 'trashed', closedAt: 1 }), win('b'), win('c')],
    };
    expect(ids(stepWindow(o, 'b', -1))).toEqual(['b', 'a', 't', 'c']);
    expect(ids(stepWindow(o, 'a', 1))).toEqual(['t', 'b', 'a', 'c']);
  });

  it('is unchanged at either end', () => {
    const o = outline('a', 'b');
    expect(stepWindow(o, 'a', -1)).toBe(o);
    expect(stepWindow(o, 'b', 1)).toBe(o);
  });
});

describe('order across a restart', () => {
  it('a re-linked window keeps the place it was moved to', () => {
    const url = (id: string) => `https://e.test/${id}`;
    // The user put B first; then Chrome restarted.
    let o: Outline = {
      windows: [
        win('A', { chromeWindowId: 1, tabs: [tab('a', { chromeTabId: 11 })] }),
        win('B', { chromeWindowId: 2, tabs: [tab('b', { chromeTabId: 12 })] }),
        win('C', { chromeWindowId: 3, tabs: [tab('c', { chromeTabId: 13 })] }),
      ],
    };
    o = moveWindows(o, ['B'], 'A', 'before');
    o = startFresh(o, 100);
    expect(ids(o)).toEqual(['B', 'A', 'C']);
    for (const w of o.windows) for (const t of w.tabs) t.liveAtClose = true;
    // Chrome restores them in its own order, as new provisional windows at the bottom.
    const restored = (id: string, chromeWindowId: number, tabId: string, n: number) =>
      win(id, {
        chromeWindowId,
        provisional: true,
        tabs: [tab(tabId, { chromeTabId: n, url: url(tabId.replace("'", '')) })],
      });
    o = {
      windows: [
        ...o.windows,
        restored('P1', 21, "a'", 31),
        restored('P2', 22, "c'", 33),
        restored('P3', 23, "b'", 32),
      ],
    };
    const r = matchRestored(o, ['P1', 'P2', 'P3'], 200);
    expect(ids(r)).toEqual(['B', 'A', 'C']);
    expect(r.windows.map((w) => w.chromeWindowId)).toEqual([23, 21, 22]);
  });
});
