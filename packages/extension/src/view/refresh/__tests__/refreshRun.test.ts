import { describe, expect, it } from 'vitest';
import type { CaptureOutcome } from '../../../shared/captureOutcomes';
import { STALE_PREVIEW_MS } from '../../../shared/previewPolicy';
import {
  backgroundTabNote,
  pickRefreshTargets,
  runRefresh,
  type RefreshProgress,
  type RefreshTab,
} from '../refreshRun';

const NOW = 10 * STALE_PREVIEW_MS;
const tab = (id: number, url: string, over: Partial<RefreshTab> = {}): RefreshTab => ({
  id,
  windowId: 1,
  url,
  discarded: false,
  status: 'complete',
  incognito: false,
  ...over,
});

describe('pickRefreshTargets', () => {
  const fresh = NOW - 1000;
  const stale = NOW - STALE_PREVIEW_MS - 1;
  const shots: Record<string, number> = {
    'https://a.test/': fresh,
    'https://b.test/': stale,
  };
  const tabs = [
    tab(1, 'https://a.test/'), // fresh preview
    tab(2, 'https://b.test/'), // stale preview
    tab(3, 'https://c.test/'), // none
    tab(4, 'https://c.test/#more'), // same page as 3
    tab(5, 'https://d.test/', { discarded: true }), // asleep
    tab(6, 'https://e.test/', { status: 'unloaded' }), // asleep (lazily restored)
    tab(7, 'chrome://settings/'), // Chrome won't let extensions capture it
    tab(8, 'https://f.test/', { incognito: true }),
    tab(9, 'https://g.test/', { windowId: 99 }), // Tab Hammer's own window
  ];
  const pick = (mode: 'stale' | 'all') =>
    pickRefreshTargets(tabs, (u) => shots[u], mode, NOW, 99).map((t) => t.id);

  it('stale mode takes missing and stale previews, once per page, skipping sleeping tabs', () => {
    expect(pick('stale')).toEqual([2, 3]);
  });

  it('all mode also retakes fresh previews', () => {
    expect(pick('all')).toEqual([1, 2, 3]);
  });
});

describe('backgroundTabNote', () => {
  // The panel's note for a background tab with no preview must agree with Refresh stale: it points
  // at Refresh stale for exactly the tabs a run would take, and says why for the rest.
  const tabs = [
    tab(1, 'https://a.test/'),
    tab(2, 'https://b.test/', { discarded: true }),
    tab(3, 'https://c.test/', { status: 'unloaded' }), // not loaded since a restart
    tab(4, 'https://d.test/', { incognito: true }),
    tab(5, 'chrome://settings/'),
  ];

  it('says Refresh stale only for tabs a Refresh stale run would capture', () => {
    const picked = new Set(pickRefreshTargets(tabs, () => undefined, 'stale', NOW, null));
    for (const t of tabs) {
      expect(backgroundTabNote(t) === 'skipped:background-tab').toBe(picked.has(t));
    }
  });

  it('calls both kinds of sleeping tab asleep', () => {
    expect(tabs.map(backgroundTabNote)).toEqual([
      'skipped:background-tab',
      'skipped:discarded',
      'skipped:discarded',
      'skipped:incognito',
      'skipped:not-capturable-url',
    ]);
    expect(backgroundTabNote(undefined)).toBe('skipped:no-tab');
  });
});

function fakeChrome(tabs: RefreshTab[], shots: Record<string, number> = {}) {
  const live = new Map(tabs.map((t) => [t.id, { ...t }]));
  const captured: number[] = [];
  const progress: RefreshProgress[] = [];
  let onCapture: (id: number) => void = () => {};
  const outcomes: Record<number, CaptureOutcome> = {};
  return {
    live,
    shots,
    captured,
    progress,
    outcomes,
    set onCapture(fn: (id: number) => void) {
      onCapture = fn;
    },
    deps: {
      getTab: async (id: number) => live.get(id),
      capturedAt: async (url: string) => shots[url],
      capture: async (id: number): Promise<CaptureOutcome> => {
        captured.push(id);
        onCapture(id);
        const outcome = outcomes[id] ?? 'saved';
        if (outcome === 'saved') shots[live.get(id)!.url!] = NOW;
        return outcome;
      },
      onProgress: (p: RefreshProgress) => progress.push(p),
      now: () => NOW,
    },
  };
}

describe('runRefresh', () => {
  it('captures each target in turn and counts saved, failed, and skipped', async () => {
    const tabs = [tab(1, 'https://a.test/'), tab(2, 'https://b.test/'), tab(3, 'https://c.test/')];
    const c = fakeChrome(tabs);
    c.outcomes[2] = 'error:attach: DevTools is attached';
    c.outcomes[3] = 'skipped:superseded';
    const result = await runRefresh(tabs, 'stale', c.deps, new AbortController().signal);
    expect(c.captured).toEqual([1, 2, 3]);
    expect(result).toEqual({ done: 3, total: 3, saved: 1, failed: 1, skipped: 1 });
    expect(c.progress.map((p) => p.done)).toEqual([0, 1, 2, 3]);
  });

  it('skips tabs that closed, fell asleep, or got a fresh preview since the run started', async () => {
    const tabs = [
      tab(1, 'https://a.test/'),
      tab(2, 'https://b.test/'),
      tab(3, 'https://c.test/'),
      tab(4, 'https://d.test/'),
    ];
    const c = fakeChrome(tabs);
    c.onCapture = (id) => {
      if (id !== 1) return;
      c.live.delete(2);
      c.live.get(3)!.discarded = true;
      c.shots['https://d.test/'] = NOW; // the user looked at it meanwhile
    };
    const result = await runRefresh(tabs, 'stale', c.deps, new AbortController().signal);
    expect(c.captured).toEqual([1]);
    expect(result).toMatchObject({ done: 4, saved: 1, skipped: 3 });
  });

  it('stops before the next capture once aborted', async () => {
    const tabs = [tab(1, 'https://a.test/'), tab(2, 'https://b.test/'), tab(3, 'https://c.test/')];
    const c = fakeChrome(tabs);
    const stop = new AbortController();
    c.onCapture = (id) => {
      if (id === 1) stop.abort();
    };
    const result = await runRefresh(tabs, 'stale', c.deps, stop.signal);
    expect(c.captured).toEqual([1]);
    expect(result).toMatchObject({ done: 1, total: 3, saved: 1 });
  });
});
