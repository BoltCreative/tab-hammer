import { describe, expect, it } from 'vitest';
import { buildTree } from '../buildTree';
import { countTabs, filterTree } from '../filterTree';
import type { WindowNode } from '../types';
import { group, state, tab, win } from './outlineState';

// Window 1 (live): [Reading (1, 2)] 3 ; Window 2 (live): 4 ; Window 3 (hibernated): [Trips (5)]
function layout(): WindowNode[] {
  const t = (id: number, title: string, url: string, groupId?: string) =>
    tab(`${id}`, { chromeTabId: id, title, url, groupId });
  return buildTree(
    state({
      windows: [
        win('1', {
          chromeWindowId: 1,
          groups: [group('10', { chromeGroupId: 10, title: 'Reading', collapsed: true })],
          tabs: [
            t(1, 'Rust book', 'https://doc.rust-lang.org/book/', '10'),
            t(2, 'Cargo guide', 'https://doc.rust-lang.org/cargo/', '10'),
            t(3, 'Weather', 'https://weather.test/'),
          ],
        }),
        win('2', { chromeWindowId: 2, tabs: [t(4, 'Inbox', 'https://mail.test/inbox')] }),
        win('3', {
          groups: [group('30', { title: 'Trips' })],
          tabs: [tab('5', { title: 'Lisbon flights', url: 'https://fly.test/', groupId: '30' })],
        }),
      ],
    }),
  ).windows;
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

  it('search covers hibernated rows', () => {
    const tree = layout();
    expect(keys(filterTree(tree, 'lisbon'))).toEqual(['w:3', 'g:30', 't:5']);
    expect(keys(filterTree(tree, 'trips'))).toEqual(['w:3', 'g:30', 't:5']);
  });
});
