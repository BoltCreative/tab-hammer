import { describe, expect, it } from 'vitest';
import { copyForOpen } from '../copy';
import { sgroup, stab, swin } from './files';

const source = swin('w', {
  name: 'Research',
  state: 'live',
  groups: [sgroup('g', { title: 'Docs', color: 'red' })],
  tabs: [stab('t1', { groupId: 'g' }), stab('t2', { groupId: 'g' }), stab('t3')],
});

function opts() {
  let n = 0;
  return { now: 7, newId: () => `n${++n}`, installId: 'me' };
}

describe('copyForOpen', () => {
  it('copies a whole window with fresh IDs, its name, and its groups', () => {
    const rec = copyForOpen(source, 'w', opts())!;
    expect(rec).toMatchObject({ state: 'hibernated', name: 'Research', originInstallId: 'me' });
    const ids = [rec.id, ...rec.tabs.map((t) => t.id), ...rec.groups.map((g) => g.id)];
    expect(ids.some((id) => ['w', 'g', 't1', 't2', 't3'].includes(id))).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rec.tabs.map((t) => t.url)).toEqual(source.tabs.map((t) => t.url));
    expect(rec.groups).toMatchObject([{ title: 'Docs', color: 'red' }]);
    expect(rec.tabs.map((t) => t.groupId)).toEqual([
      rec.groups[0]!.id,
      rec.groups[0]!.id,
      undefined,
    ]);
  });

  it("copies a group's tabs only, in their group, without the window name", () => {
    const rec = copyForOpen(source, 'g', opts())!;
    expect(rec.name).toBeUndefined();
    expect(rec.tabs.map((t) => t.title)).toEqual(['t1', 't2']);
    expect(rec.groups).toHaveLength(1);
  });

  it('copies one tab, keeping its group', () => {
    const rec = copyForOpen(source, 't2', opts())!;
    expect(rec.tabs.map((t) => t.title)).toEqual(['t2']);
    expect(rec.tabs[0]!.groupId).toBe(rec.groups[0]!.id);
  });

  it('copies an ungrouped tab without groups', () => {
    expect(copyForOpen(source, 't3', opts())!.groups).toEqual([]);
  });

  it('is null for a row not in the window', () => {
    expect(copyForOpen(source, 'nope', opts())).toBeNull();
  });
});
