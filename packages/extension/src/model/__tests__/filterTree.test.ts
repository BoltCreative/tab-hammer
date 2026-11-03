import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import { countTabs, filterTree } from '../filterTree';
import type { RawTab, WindowNode } from '../types';

function layout(): WindowNode[] {
  const tab = (id: number, windowId: number, title: string, url: string, groupId = -1): RawTab => ({
    id,
    windowId,
    index: id,
    groupId,
    title,
    url,
    active: false,
    discarded: false,
  });
  return buildTree({
    windows: [{ id: 1 }, { id: 2 }],
    tabs: [
      tab(1, 1, 'Rust book', 'https://doc.rust-lang.org/book/', 10),
      tab(2, 1, 'Cargo guide', 'https://doc.rust-lang.org/cargo/', 10),
      tab(3, 1, 'Weather', 'https://weather.test/'),
      tab(4, 2, 'Inbox', 'https://mail.test/inbox'),
    ],
    groups: [{ id: 10, windowId: 1, title: 'Reading', color: 'blue', collapsed: true }],
    selfWindowId: null,
    lastFocusedWindowId: null,
  });
}

const keys = (tree: WindowNode[]) =>
  tree.flatMap((w) => [
    w.key,
    ...w.children.flatMap((c) =>
      c.kind === 'group' ? [c.key, ...c.tabs.map((t) => t.key)] : [c.key],
    ),
  ]);

describe('filterTree', () => {
  it('returns the tree itself for a blank query', () => {
    const tree = layout();
    expect(filterTree(tree, '   ')).toBe(tree);
  });

  it('keeps matching tabs with their window and group, case-insensitively, by title or URL', () => {
    const tree = layout();
    expect(keys(filterTree(tree, 'CARGO'))).toEqual(['w:1', 'g:10', 't:2']);
    expect(keys(filterTree(tree, 'mail.test'))).toEqual(['w:2', 't:4']);
  });

  it('requires every word to match', () => {
    const tree = layout();
    expect(keys(filterTree(tree, 'rust book'))).toEqual(['w:1', 'g:10', 't:1']);
    expect(filterTree(tree, 'rust weather')).toEqual([]);
  });

  it('keeps a group whole when its title matches', () => {
    const tree = layout();
    expect(keys(filterTree(tree, 'reading'))).toEqual(['w:1', 'g:10', 't:1', 't:2']);
  });

  it('counts the tabs left showing', () => {
    expect(countTabs(filterTree(layout(), 'doc.rust'))).toBe(2);
  });
});
