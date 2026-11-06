import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Outline, WindowRec } from '../../../model/outline/types';
import { exportOutline, loadOutline, saveOutline } from '../outlineStore';

function win(id: string, extra: Partial<WindowRec> = {}): WindowRec {
  return {
    id,
    state: 'hibernated',
    lastLiveAt: 1,
    originInstallId: 'install-1',
    modifiedAt: 2,
    tabs: [{ id: `${id}-t`, url: 'https://a.test/', title: 'A', modifiedAt: 3 }],
    groups: [],
    ...extra,
  };
}

async function reset() {
  await saveOutline((await loadOutline()).outline, { windows: [] }, 's');
}

describe('outline store', () => {
  it('round-trips windows in outline order with the meta', async () => {
    await reset();
    const next: Outline = { windows: [win('b'), win('a'), win('c')] };
    await saveOutline({ windows: [] }, next, 'session-1');
    const loaded = await loadOutline();
    expect(loaded.outline).toEqual(next);
    expect(loaded.meta).toEqual({
      schemaVersion: 1,
      sessionId: 'session-1',
      order: ['b', 'a', 'c'],
    });
  });

  it('persists a reorder that changes no window record', async () => {
    await reset();
    const [a, b, c] = [win('a'), win('b'), win('c')];
    const first: Outline = { windows: [a, b, c] };
    await saveOutline({ windows: [] }, first, 's');
    await saveOutline(first, { windows: [c, a, b] }, 's');
    expect((await loadOutline()).outline.windows.map((w) => w.id)).toEqual(['c', 'a', 'b']);
  });

  it('persists changes and deletions', async () => {
    await reset();
    const a = win('a');
    const b = win('b');
    const c = win('c');
    const first: Outline = { windows: [a, b, c] };
    await saveOutline({ windows: [] }, first, 's');
    const b2 = { ...b, name: 'renamed', modifiedAt: 9 };
    const next: Outline = { windows: [a, b2] };
    await saveOutline(first, next, 's');
    expect((await loadOutline()).outline).toEqual(next);
  });

  it('exportOutline returns plain JSON', async () => {
    await reset();
    await saveOutline({ windows: [] }, { windows: [win('a')] }, 's');
    const x = await exportOutline();
    expect(JSON.parse(JSON.stringify(x))).toEqual(x);
  });

  it('exportOutline strips machine-local fields', async () => {
    await reset();
    const seeded = win('a', {
      state: 'live',
      chromeWindowId: 11,
      provisional: true,
      openAtShutdown: true,
      bounds: { left: 1, top: 2, width: 3, height: 4, state: 'maximized' },
      tabs: [
        {
          id: 't1',
          chromeTabId: 22,
          launchUrl: 'https://launch.test/',
          liveAtClose: true,
          url: 'https://a.test/',
          title: 'A',
          groupId: 'g1',
          modifiedAt: 5,
        },
      ],
      groups: [
        { id: 'g1', chromeGroupId: 33, title: 'G', color: 'blue', collapsed: false, modifiedAt: 6 },
      ],
    });
    await saveOutline({ windows: [] }, { windows: [seeded] }, 's');
    const out = await exportOutline();
    const json = JSON.stringify(out);
    for (const k of [
      'chromeWindowId',
      'provisional',
      'openAtShutdown',
      'bounds',
      'chromeTabId',
      'launchUrl',
      'liveAtClose',
      'chromeGroupId',
    ]) {
      expect(json).not.toContain(`"${k}"`);
    }
    expect(out.schemaVersion).toBe(1);
    expect(out.windows[0]).toMatchObject({ originInstallId: 'install-1', modifiedAt: 2 });
    expect(out.windows[0]?.tabs[0]).toMatchObject({ id: 't1', groupId: 'g1', modifiedAt: 5 });
    expect(out.windows[0]?.groups[0]).toMatchObject({ id: 'g1', modifiedAt: 6 });
  });
});
