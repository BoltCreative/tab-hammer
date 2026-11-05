import { describe, expect, it } from 'vitest';
import { buildTree } from '../../../model/buildTree';
import { visibleRowKeys } from '../../../model/visibleRows';
import type { TabRec } from '../../../model/outline/types';
import { state, tab as rec, win } from '../../../model/__tests__/outlineState';
import { hoverSignature } from '../hoverSignature';

interface T {
  id: number;
  windowId: number;
  title?: string;
  url?: string;
}
const tab = (id: number, windowId: number, extra: Partial<T> = {}): T => ({
  id,
  windowId,
  ...extra,
});

const tree = (tabs: T[]) =>
  buildTree(
    state({
      windows: [1, 2, 3].map((w) =>
        win(`${w}`, {
          chromeWindowId: w,
          tabs: tabs
            .filter((t) => t.windowId === w)
            .map((t): TabRec =>
              rec(`${t.id}`, {
                chromeTabId: t.id,
                title: t.title ?? `Tab ${t.id}`,
                url: t.url ?? `https://example.com/${t.id}`,
              }),
            ),
        }),
      ),
    }),
  ).windows;

const base = [tab(5, 1), tab(10, 2), tab(11, 2), tab(30, 3)];
const expanded = { collapsedWindows: new Set<string>(), groupOverrides: new Map() };
const sig = (tabs: T[], collapse = expanded) => {
  const t = tree(tabs);
  return hoverSignature(t, visibleRowKeys(t, collapse), 't:10');
};

describe('hoverSignature', () => {
  it('is stable when nothing moves the row, including title-only changes', () => {
    expect(sig(base)).toBe(
      sig([...base.slice(0, 1), tab(10, 2, { title: '(3) Inbox' }), ...base.slice(2)]),
    );
    expect(sig(base)).toBe(sig([...base.slice(0, 3), tab(30, 3, { title: 'New' })]));
  });

  it('changes when any row order changes, including in another window', () => {
    expect(sig(base)).not.toBe(sig([...base, tab(12, 2)])); // hovered window
    expect(sig(base)).not.toBe(sig([...base, tab(6, 1)])); // window above
    expect(sig(base)).not.toBe(sig(base.slice(1).concat(tab(7, 1)))); // tab replaced above
    const collapsedAbove = { ...expanded, collapsedWindows: new Set(['w:1']) };
    expect(sig(base)).not.toBe(sig(base, collapsedAbove));
  });

  it("changes when the hovered tab's URL changes", () => {
    expect(sig(base)).not.toBe(
      sig([base[0]!, tab(10, 2, { url: 'https://example.com/moved' }), ...base.slice(2)]),
    );
  });

  it('is undefined once the tab is gone or hidden', () => {
    expect(sig(base.filter((t) => t.id !== 10))).toBeUndefined();
    expect(sig(base, { ...expanded, collapsedWindows: new Set(['w:2']) })).toBeUndefined();
  });
});
