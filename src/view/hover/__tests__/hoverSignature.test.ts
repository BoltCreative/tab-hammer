import { describe, expect, it } from 'vitest';
import { buildTree } from '../../../model/buildTree';
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
    windows: [{ id: 1 }, { id: 2 }],
    tabs,
    groups: [],
    selfWindowId: null,
    lastFocusedWindowId: null,
  });

const base = [tab(10, 1, 0), tab(11, 1, 1), tab(20, 2, 0)];
const sig = (tabs: RawTab[]) => hoverSignature(tree(tabs), 't:10');

describe('hoverSignature', () => {
  it('is stable when nothing under the card changes, including other windows', () => {
    expect(sig(base)).toBe(sig([...base.slice(0, 2), tab(20, 2, 0, { title: 'New' })]));
    expect(sig(base)).toBe(sig([...base, tab(21, 2, 1)]));
  });

  it("changes when the hovered window's rows change", () => {
    expect(sig(base)).not.toBe(sig([...base, tab(12, 1, 2)]));
    expect(sig(base)).not.toBe(sig([tab(10, 1, 0), tab(20, 2, 0)]));
  });

  it("changes when the hovered tab's title or URL changes", () => {
    expect(sig(base)).not.toBe(sig([tab(10, 1, 0, { title: 'Renamed' }), ...base.slice(1)]));
    expect(sig(base)).not.toBe(
      sig([tab(10, 1, 0, { url: 'https://example.com/moved' }), ...base.slice(1)]),
    );
  });

  it('is undefined once the tab is gone', () => {
    expect(sig(base.slice(1))).toBeUndefined();
  });
});
