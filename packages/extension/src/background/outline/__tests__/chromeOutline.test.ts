import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenPlan } from '../../../model/outline/open';
import type { GroupRec } from '../../../model/outline/types';
import { createGroup, openPlanned } from '../chromeOutline';

const GROUP: GroupRec = {
  id: 'G',
  title: 'Research',
  color: 'red',
  collapsed: true,
  modifiedAt: 0,
};

/**
 * A stand-in for the chrome.* calls openPlanned makes. Tab IDs count up from 100; creates of a
 * url in `refuse` reject. Any other call (a discard, say) is recorded too, so tests see it.
 */
function fakeChrome(opts: { refuse?: string[] } = {}) {
  let next = 100;
  const calls: unknown[][] = [];
  const chrome = {
    windows: {
      create: vi.fn(async (p: { url: string }) => {
        calls.push(['windows.create', p]);
        return { id: 9, tabs: [{ id: next++ }] };
      }),
    },
    tabs: {
      create: vi.fn(async (p: { url: string }) => {
        calls.push(['tabs.create', p]);
        if (opts.refuse?.includes(p.url)) throw new Error('refused');
        return { id: next++ };
      }),
      group: vi.fn(async (p: { groupId?: number }) => {
        calls.push(['tabs.group', p]);
        return p.groupId ?? 50;
      }),
      discard: vi.fn(async (id: number) => {
        calls.push(['tabs.discard', id]);
        return { id };
      }),
    },
    tabGroups: {
      update: vi.fn(async (id: number, p: object) => {
        calls.push(['tabGroups.update', id, p]);
        return {};
      }),
    },
  };
  vi.stubGlobal('chrome', chrome);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openPlanned', () => {
  it('after a refused create, later tabs go to the next actual index', async () => {
    const calls = fakeChrome({ refuse: ['u2'] });
    const plan: OpenPlan = {
      windowId: 'W',
      chromeWindowId: 4,
      tabs: [
        { tabId: 'a', url: 'u1', index: 1 },
        { tabId: 'b', url: 'u2', index: 2 },
        { tabId: 'c', url: 'u3', index: 3 },
        { tabId: 'd', url: 'u4', index: 5 },
      ],
      groups: [],
    };
    const opened = await openPlanned(plan);
    expect(calls.filter((c) => c[0] === 'tabs.create').map((c) => c[1])).toEqual([
      { windowId: 4, index: 1, url: 'u1', active: false },
      { windowId: 4, index: 2, url: 'u2', active: false },
      { windowId: 4, index: 2, url: 'u3', active: false },
      { windowId: 4, index: 4, url: 'u4', active: false },
    ]);
    // The refused tab is left out (it stays hibernated).
    expect(opened).toEqual({
      chromeWindowId: 4,
      tabs: [
        { tabId: 'a', chromeTabId: 100 },
        { tabId: 'c', chromeTabId: 101 },
        { tabId: 'd', chromeTabId: 102 },
      ],
      groups: [],
    });
  });

  it('opens a new window, recreates its group, and loads every tab (none is discarded)', async () => {
    const calls = fakeChrome();
    const plan: OpenPlan = {
      windowId: 'W',
      chromeWindowId: null,
      tabs: [
        { tabId: 'a', url: 'u1', index: 0, groupId: 'G' },
        { tabId: 'b', url: 'u2', index: 1, groupId: 'G' },
        { tabId: 'c', url: 'u3', index: 2 },
      ],
      groups: [GROUP],
    };
    const opened = await openPlanned(plan);
    expect(calls).toEqual([
      ['windows.create', { url: 'u1', focused: true }],
      ['tabs.create', { windowId: 9, index: 1, url: 'u2', active: false }],
      ['tabs.create', { windowId: 9, index: 2, url: 'u3', active: false }],
      ['tabs.group', { tabIds: [100, 101], createProperties: { windowId: 9 } }],
      ['tabGroups.update', 50, { title: 'Research', color: 'red', collapsed: true }],
    ]);
    expect(opened).toEqual({
      chromeWindowId: 9,
      tabs: [
        { tabId: 'a', chromeTabId: 100 },
        { tabId: 'b', chromeTabId: 101 },
        { tabId: 'c', chromeTabId: 102 },
      ],
      groups: [{ groupId: 'G', chromeGroupId: 50 }],
    });
  });

  it('adds tabs to a group that is still live in Chrome', async () => {
    const calls = fakeChrome();
    const opened = await openPlanned({
      windowId: 'W',
      chromeWindowId: 4,
      tabs: [{ tabId: 'b', url: 'u2', index: 1, groupId: 'G' }],
      groups: [{ ...GROUP, chromeGroupId: 7 }],
    });
    expect(calls.filter((c) => c[0] === 'tabs.group')).toEqual([
      ['tabs.group', { groupId: 7, tabIds: [100] }],
    ]);
    expect(opened.groups).toEqual([{ groupId: 'G', chromeGroupId: 7 }]);
  });
});

describe('createGroup', () => {
  it('groups the tabs in the window and styles the group like its record', async () => {
    const calls = fakeChrome();
    expect(await createGroup(3, [11, 12], GROUP)).toBe(50);
    expect(calls).toEqual([
      ['tabs.group', { tabIds: [11, 12], createProperties: { windowId: 3 } }],
      ['tabGroups.update', 50, { title: 'Research', color: 'red', collapsed: true }],
    ]);
  });
});
