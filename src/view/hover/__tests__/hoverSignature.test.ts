import { describe, expect, it } from 'vitest';
import { buildTree } from '../../../model/buildTree';
import { visibleRowKeys } from '../../../model/visibleRows';
import type { RawTab } from '../../../model/types';
import { hoverSignature } from '../hoverSignature';

const tab = (id: number, windowId: number, index: number, extra: Partial<RawTab> = {}): RawTab => ({
  id,
  windowId,
  index,
  groupId: -1,
  title: `Tab ${id}`,
  url: `https://example.com/${id}`,
  active: false,
  discarded: false,
  ...extra,
});

const tree = (tabs: RawTab[]) =>
  buildTree({
    windows: [{ id: 1 }, { id: 2 }, { id: 3 }],
    tabs,
    groups: [],
    selfWindowId: null,
    lastFocusedWindowId: null,
  });

const base = [tab(5, 1, 0), tab(10, 2, 0), tab(11, 2, 1), tab(30, 3, 0)];
const expanded = { collapsedWindows: new Set<string>(), groupOverrides: new Map() };
const sig = (tabs: RawTab[], collapse = expanded) => {
  const t = tree(tabs);
  return hoverSignature(t, visibleRowKeys(t, collapse), 't:10');
};

describe('hoverSignature', () => {
  it('is stable when nothing moves the row, including title-only changes', () => {
    expect(sig(base)).toBe(
      sig([...base.slice(0, 1), tab(10, 2, 0, { title: '(3) Inbox' }), ...base.slice(2)]),
    );
    expect(sig(base)).toBe(sig([...base.slice(0, 3), tab(30, 3, 0, { title: 'New' })]));
  });

  it('changes when any row order changes, including in another window', () => {
    expect(sig(base)).not.toBe(sig([...base, tab(12, 2, 2)])); // hovered window
    expect(sig(base)).not.toBe(sig([...base, tab(6, 1, 1)])); // window above
    expect(sig(base)).not.toBe(sig(base.slice(1).concat(tab(7, 1, 0)))); // tab replaced above
    const collapsedAbove = { ...expanded, collapsedWindows: new Set(['w:1']) };
    expect(sig(base)).not.toBe(sig(base, collapsedAbove));
  });

  it("changes when the hovered tab's URL changes", () => {
    expect(sig(base)).not.toBe(
      sig([base[0]!, tab(10, 2, 0, { url: 'https://example.com/moved' }), ...base.slice(2)]),
    );
  });

  it('is undefined once the tab is gone or hidden', () => {
    expect(sig(base.filter((t) => t.id !== 10))).toBeUndefined();
    expect(sig(base, { ...expanded, collapsedWindows: new Set(['w:2']) })).toBeUndefined();
  });
});
