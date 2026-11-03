import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import { findDuplicates, normalizeUrl } from '../duplicates';
import type { RawTab } from '../types';

describe('normalizeUrl', () => {
  it('ignores the fragment, utm_ parameters, host case and a trailing slash', () => {
    const base = normalizeUrl('https://example.com/a?id=1');
    expect(normalizeUrl('https://EXAMPLE.com/a/?id=1#top')).toBe(base);
    expect(normalizeUrl('https://example.com/a?utm_source=x&id=1&UTM_medium=y')).toBe(base);
    expect(normalizeUrl('https://example.com/a?id=2')).not.toBe(base);
    expect(normalizeUrl('http://example.com/a?id=1')).not.toBe(base);
  });

  it('has nothing to compare for blank or unparseable URLs', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('findDuplicates', () => {
  type T = Partial<RawTab> & Pick<RawTab, 'id' | 'windowId' | 'url'>;
  const tree = (tabs: T[], lastFocusedWindowId: number | null = null) =>
    buildTree({
      windows: [{ id: 1 }, { id: 2 }],
      tabs: tabs.map((t, index) => ({
        index,
        groupId: -1,
        active: false,
        discarded: false,
        ...t,
      })),
      groups: [],
      selfWindowId: null,
      lastFocusedWindowId,
    });
  const ids = (d: ReturnType<typeof findDuplicates>) => d.toClose.map((t) => t.tabId).sort();

  it('finds copies across windows and keeps the most recently viewed', () => {
    const d = findDuplicates(
      tree([
        { id: 1, windowId: 1, url: 'https://a.test/', lastAccessed: 100 },
        { id: 2, windowId: 2, url: 'https://a.test/#x', lastAccessed: 300 },
        { id: 3, windowId: 2, url: 'https://a.test', lastAccessed: 200 },
        { id: 4, windowId: 1, url: 'https://b.test/' },
      ]),
    );
    expect(ids(d)).toEqual([1, 3]);
    expect([...d.keys].sort()).toEqual(['t:1', 't:2', 't:3']);
  });

  it("keeps the focused window's active tab over a more recent copy", () => {
    const d = findDuplicates(
      tree(
        [
          { id: 1, windowId: 1, url: 'https://a.test/', lastAccessed: 999, active: true },
          { id: 2, windowId: 2, url: 'https://a.test/', lastAccessed: 1, active: true },
          { id: 3, windowId: 2, url: 'https://a.test/', lastAccessed: 500 },
        ],
        2,
      ),
    );
    expect(ids(d)).toEqual([1, 3]);
  });

  it('keeps the first copy when nothing tells them apart, and finds nothing without copies', () => {
    const same = [
      { id: 1, windowId: 1, url: 'https://a.test/' },
      { id: 2, windowId: 1, url: 'https://a.test/' },
    ];
    expect(ids(findDuplicates(tree(same)))).toEqual([2]);
    const none = findDuplicates(tree([{ id: 1, windowId: 1, url: 'https://a.test/' }]));
    expect(none.toClose).toEqual([]);
    expect(none.keys.size).toBe(0);
  });
});
