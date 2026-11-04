import { describe, expect, it } from 'vitest';
import type { ChromeSnapshot, LiveTab } from '../../../model/outline/types';
import { createSelfClosing } from '../selfClosing';

const tab = (id: number, windowId: number, groupId = -1): LiveTab => ({
  id,
  windowId,
  index: 0,
  groupId,
  url: `https://example.com/${id}`,
  title: '',
  active: false,
  discarded: false,
});

const snapshot: ChromeSnapshot = {
  windowIds: [1, 2],
  tabs: [tab(10, 1), tab(11, 1, 5), tab(20, 2, 6), tab(21, 2)],
  groups: [
    { id: 5, windowId: 1, title: '', color: 'red', collapsed: false },
    { id: 6, windowId: 2, title: '', color: 'blue', collapsed: false },
  ],
};

describe('createSelfClosing', () => {
  it('hides the windows and tabs Tab Hammer is closing until Chrome reports them gone', () => {
    const closing = createSelfClosing();
    closing.add({ closeWindows: [2], closeTabs: [11] });
    const seen = closing.filter(snapshot);
    expect(seen.windowIds).toEqual([1]);
    expect(seen.tabs.map((t) => t.id)).toEqual([10]);
    expect(seen.groups.map((g) => g.id)).toEqual([5]);

    closing.windowRemoved(2);
    closing.tabRemoved(11);
    expect(closing.filter(snapshot)).toEqual(snapshot);
  });

  it('shows them again when the close fails (a page cancelled it)', () => {
    const closing = createSelfClosing();
    const effects = { closeWindows: [2], closeTabs: [10, 11] };
    closing.add(effects);
    closing.release(effects);
    expect(closing.filter(snapshot)).toEqual(snapshot);
  });

  it('passes the snapshot through untouched when nothing is closing', () => {
    expect(createSelfClosing().filter(snapshot)).toBe(snapshot);
  });
});
