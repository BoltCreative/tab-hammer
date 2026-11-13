import { describe, expect, it } from 'vitest';
import { attachOpened, planOpen } from '../open';
import type { Outline } from '../types';
import { group, tab, win } from './recs';

const NOW = 1_000_000;

describe('planOpen', () => {
  it('plans a hibernated window as a new Chrome window with every tab in order', () => {
    const o: Outline = {
      windows: [
        win('w', {
          groups: [group('g')],
          tabs: [tab('a', { groupId: 'g' }), tab('b'), tab('c', { groupId: 'g' })],
        }),
      ],
    };
    expect(planOpen(o, 'w')).toEqual({
      windowId: 'w',
      chromeWindowId: null,
      tabs: [
        { tabId: 'a', url: 'https://e.test/a', index: 0, groupId: 'g' },
        { tabId: 'b', url: 'https://e.test/b', index: 1 },
        { tabId: 'c', url: 'https://e.test/c', index: 2, groupId: 'g' },
      ],
      groups: [group('g')],
    });
  });

  it('plans a trash entry as a new Chrome window with every tab', () => {
    const o: Outline = {
      windows: [win('w', { state: 'trashed', closedAt: 1, tabs: [tab('a'), tab('b')] })],
    };
    const plan = planOpen(o, 'w')!;
    expect(plan.chromeWindowId).toBeNull();
    expect(plan.tabs.map((t) => [t.tabId, t.index])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('reopens a closed window with the tabs that were live when it closed, keeping the others hibernated', () => {
    for (const state of ['trashed', 'hibernated'] as const) {
      const o: Outline = {
        windows: [
          win('w', {
            state,
            closedAt: state === 'trashed' ? 1 : undefined,
            groups: [group('g')],
            tabs: [
              tab('a', { liveAtClose: true }),
              tab('h1', { liveAtClose: false }),
              tab('b', { liveAtClose: true, groupId: 'g' }),
              tab('h2', { liveAtClose: false, groupId: 'g' }),
              tab('h3'),
            ],
          }),
        ],
      };
      const plan = planOpen(o, 'w')!;
      expect(plan.tabs.map((t) => [t.tabId, t.index])).toEqual([
        ['a', 0],
        ['b', 1],
      ]);
      expect(plan.groups).toEqual([group('g')]);
    }
  });

  it('opens every tab of a closed window none of whose tabs is marked live at close', () => {
    // A window restored from a sync file, or made hibernated from the start, has no such marks.
    const o: Outline = {
      windows: [win('w', { tabs: [tab('a'), tab('b', { liveAtClose: false })] })],
    };
    expect(planOpen(o, 'w')!.tabs.map((t) => t.tabId)).toEqual(['a', 'b']);
  });

  it('opens a hibernated group or tab of a closed window whatever it was at close', () => {
    const o: Outline = {
      windows: [
        win('w', {
          groups: [group('g')],
          tabs: [tab('a', { liveAtClose: true }), tab('h', { liveAtClose: false, groupId: 'g' })],
        }),
      ],
    };
    expect(planOpen(o, 'h')!.tabs.map((t) => t.tabId)).toEqual(['h']);
    expect(planOpen(o, 'g')!.tabs.map((t) => t.tabId)).toEqual(['h']);
  });

  it('plans one hibernated tab of a live window at its live index', () => {
    const o: Outline = {
      windows: [
        win('w', {
          chromeWindowId: 7,
          tabs: [tab('a', { chromeTabId: 1 }), tab('h1'), tab('b', { chromeTabId: 2 }), tab('h2')],
        }),
      ],
    };
    expect(planOpen(o, 'h2')).toEqual({
      windowId: 'w',
      chromeWindowId: 7,
      tabs: [{ tabId: 'h2', url: 'https://e.test/h2', index: 2 }],
      groups: [],
    });
  });

  it('plans a hibernated tab of a hibernated window as a new window with just that tab', () => {
    const o: Outline = { windows: [win('w', { tabs: [tab('a'), tab('b'), tab('c')] })] };
    expect(planOpen(o, 'b')).toEqual({
      windowId: 'w',
      chromeWindowId: null,
      tabs: [{ tabId: 'b', url: 'https://e.test/b', index: 0 }],
      groups: [],
    });
  });

  it('plans a partly live window as all its hibernated tabs into that window', () => {
    const o: Outline = {
      windows: [
        win('w', {
          chromeWindowId: 7,
          tabs: [tab('h1'), tab('a', { chromeTabId: 1 }), tab('h2'), tab('h3')],
        }),
      ],
    };
    const plan = planOpen(o, 'w')!;
    expect(plan.chromeWindowId).toBe(7);
    // Each index counts the live tabs and the earlier opened ones before it.
    expect(plan.tabs.map((t) => [t.tabId, t.index])).toEqual([
      ['h1', 0],
      ['h2', 2],
      ['h3', 3],
    ]);
  });

  it('plans a hibernated group as just its tabs, carrying the group record', () => {
    const live = group('lg', { chromeGroupId: 50 });
    const o: Outline = {
      windows: [
        win('w', {
          chromeWindowId: 7,
          groups: [live, group('g')],
          tabs: [
            tab('a', { chromeTabId: 1, groupId: 'lg' }),
            tab('h1', { groupId: 'lg' }),
            tab('h2', { groupId: 'g' }),
            tab('h3', { groupId: 'g' }),
          ],
        }),
      ],
    };
    const plan = planOpen(o, 'g')!;
    expect(plan.tabs.map((t) => [t.tabId, t.index])).toEqual([
      ['h2', 1],
      ['h3', 2],
    ]);
    expect(plan.groups).toEqual([group('g')]);
    // Opening the whole window carries the live group with its Chrome ID.
    expect(planOpen(o, 'w')!.groups).toEqual([live, group('g')]);
  });

  it('carries a closed window’s last bounds into the plan for a new window', () => {
    const bounds = { left: 5, top: 6, width: 700, height: 500, state: 'normal' as const };
    const o: Outline = {
      windows: [
        win('w', { bounds, tabs: [tab('a'), tab('b')] }),
        win('t', { state: 'trashed', closedAt: 1, bounds, tabs: [tab('c')] }),
        win('l', { chromeWindowId: 3, bounds, tabs: [tab('d', { chromeTabId: 1 }), tab('e')] }),
      ],
    };
    expect(planOpen(o, 'w')?.bounds).toEqual(bounds);
    expect(planOpen(o, 'b')?.bounds).toEqual(bounds); // one tab of a hibernated window
    expect(planOpen(o, 't')?.bounds).toEqual(bounds);
    expect(planOpen(o, 'e')).not.toHaveProperty('bounds'); // into a live window
  });

  it('returns null when there is nothing to open', () => {
    const o: Outline = {
      windows: [win('w', { chromeWindowId: 7, tabs: [tab('a', { chromeTabId: 1 })] })],
    };
    expect(planOpen(o, 'w')).toBeNull();
    expect(planOpen(o, 'a')).toBeNull();
    expect(planOpen(o, 'missing')).toBeNull();
  });
});

describe('attachOpened', () => {
  it('makes a hibernated window live with the Chrome IDs it got', () => {
    const o: Outline = {
      windows: [
        win('w', {
          openAtShutdown: true,
          groups: [group('g')],
          tabs: [tab('a', { groupId: 'g' }), tab('b')],
        }),
      ],
    };
    const next = attachOpened(
      o,
      'w',
      {
        chromeWindowId: 7,
        tabs: [
          { tabId: 'a', chromeTabId: 11 },
          { tabId: 'b', chromeTabId: 12 },
        ],
        groups: [{ groupId: 'g', chromeGroupId: 50 }],
      },
      NOW,
    );
    const w = next.windows[0]!;
    expect(w).toMatchObject({ state: 'live', chromeWindowId: 7, modifiedAt: NOW, lastLiveAt: NOW });
    expect(w.openAtShutdown).toBeUndefined();
    expect(w.tabs.map((t) => t.chromeTabId)).toEqual([11, 12]);
    expect(w.groups[0]!.chromeGroupId).toBe(50);
    expect(w.tabs.map((t) => t.modifiedAt)).toEqual([0, 0]);
  });

  it('attaching an opened trash entry moves it to the bottom and makes it live', () => {
    const o: Outline = {
      windows: [
        win('t', { state: 'trashed', closedAt: 5, tabs: [tab('a')] }),
        win('x', { chromeWindowId: 1, tabs: [tab('b', { chromeTabId: 21 })] }),
      ],
    };
    const next = attachOpened(
      o,
      't',
      { chromeWindowId: 7, tabs: [{ tabId: 'a', chromeTabId: 11 }], groups: [] },
      NOW,
    );
    expect(next.windows.map((w) => w.id)).toEqual(['x', 't']);
    expect(next.windows[0]).toBe(o.windows[1]);
    const t = next.windows[1]!;
    expect(t).toMatchObject({ state: 'live', chromeWindowId: 7 });
    expect(t.closedAt).toBeUndefined();
    expect(t.tabs[0]!.chromeTabId).toBe(11);
  });

  it('attachOpened leaves tabs that failed to open hibernated', () => {
    const o: Outline = {
      windows: [win('w', { groups: [group('g')], tabs: [tab('a'), tab('b', { groupId: 'g' })] })],
    };
    const next = attachOpened(
      o,
      'w',
      { chromeWindowId: 7, tabs: [{ tabId: 'a', chromeTabId: 11 }], groups: [] },
      NOW,
    );
    const w = next.windows[0]!;
    expect(w.state).toBe('live');
    expect(w.tabs[0]!.chromeTabId).toBe(11);
    expect(w.tabs[1]).toBe(o.windows[0]!.tabs[1]);
    expect(w.groups[0]).toBe(o.windows[0]!.groups[0]);
  });

  it('opening into a live window attaches the tabs without restamping the window', () => {
    const o: Outline = {
      windows: [win('w', { chromeWindowId: 7, tabs: [tab('a', { chromeTabId: 1 }), tab('h')] })],
    };
    const next = attachOpened(
      o,
      'w',
      { chromeWindowId: 7, tabs: [{ tabId: 'h', chromeTabId: 2 }], groups: [] },
      NOW,
    );
    const w = next.windows[0]!;
    expect(w.tabs.map((t) => t.chromeTabId)).toEqual([1, 2]);
    expect(w.modifiedAt).toBe(0);
  });
});
