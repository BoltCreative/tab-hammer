import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import { findDuplicates, normalizeUrl } from '../duplicates';
import type { TabRec } from '../outline/types';
import { state, tab, win } from './outlineState';

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
  interface T {
    id: number;
    windowId: number;
    url: string;
    active?: boolean;
    lastAccessed?: number;
  }
  // Windows 1 and 2, live; each tab's record ID is its Chrome ID.
  const tree = (tabs: T[], focusedWindowId: number | null = null, extra: TabRec[] = []) =>
    buildTree(
      state({
        windows: [
          ...[1, 2].map((w) =>
            win(`${w}`, {
              chromeWindowId: w,
              tabs: tabs
                .filter((t) => t.windowId === w)
                .map((t) => tab(`${t.id}`, { chromeTabId: t.id, url: t.url })),
            }),
          ),
          win('h', { tabs: extra }),
        ],
        live: {
          focusedWindowId,
          tabs: Object.fromEntries(
            tabs.map((t) => [t.id, { active: !!t.active, lastAccessed: t.lastAccessed }]),
          ),
        },
      }),
    ).windows;
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

  it('hibernated tabs are never duplicates', () => {
    const d = findDuplicates(
      tree([{ id: 1, windowId: 1, url: 'https://a.test/' }], null, [
        tab('x', { url: 'https://a.test/' }),
        tab('y', { url: 'https://a.test/' }),
      ]),
    );
    expect(d.toClose).toEqual([]);
    expect(d.keys.size).toBe(0);
  });
});
