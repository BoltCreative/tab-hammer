import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SwapRecord } from '../../shared/captureSwap';
import {
  FAILURE_COOLDOWN_MS,
  LOAD_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  SWAP_RECOVERY_MAX_AGE_MS,
  createTabCapturer,
  type OffscreenDeps,
} from '../debuggerCapture';

const WINDOW = 7;
const NOW = 1_000_000;
const SESSION = 'session-1';
const TARGET = {
  id: 70,
  windowId: WINDOW,
  index: 2,
  groupId: -1,
  url: 'https://example.com/a',
  status: 'complete' as chrome.tabs.Tab['status'],
  incognito: false,
  discarded: false,
  active: false,
};
type Tab = typeof TARGET;
const tab = (id: number, index: number, over: Partial<Tab> = {}): Tab => ({
  ...TARGET,
  id,
  index,
  url: `https://example.com/${id}`,
  ...over,
});

/**
 * A fake window whose tabs really change as the capturer activates, creates, and removes them,
 * and a log of every call in order, so tests can assert what happened when (the debugger must
 * detach before the shot is decoded or saved, and the swap must be undone without fighting the
 * user).
 */
function setup(
  opts: {
    target?: Partial<Tab>;
    win?: object;
    others?: Tab[];
    collapsed?: number[];
    /** A swap record left in storage, e.g. by a service worker that died. */
    stored?: SwapRecord;
    over?: Partial<OffscreenDeps>;
  } = {},
) {
  const calls: string[] = [];
  const log =
    <A extends unknown[], R>(name: string, impl: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(`${name}(${args.join(',')})`);
      return impl(...args);
    };
  let tabs: Tab[] = [{ ...TARGET, ...opts.target }, ...(opts.others ?? [])];
  const activate = (id: number) => {
    if (!tabs.some((t) => t.id === id)) throw new Error(`No tab with id: ${id}`);
    tabs = tabs.map((t) => ({ ...t, active: t.id === id }));
  };
  const swaps: (SwapRecord | undefined)[] = [];
  let stored = opts.stored;
  const record = vi.fn<OffscreenDeps['record']>(async () => {});
  const save = vi.fn<OffscreenDeps['save']>(async () => {});
  const deps: OffscreenDeps = {
    hasPermission: async () => true,
    getTab: async (id) => {
      const t = tabs.find((x) => x.id === id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      return { ...t };
    },
    getWindow: async () => ({
      type: 'normal' as const,
      state: 'normal' as const,
      incognito: false,
      ...opts.win,
    }),
    viewWindowId: async () => 99,
    tabsInWindow: async () => tabs.map((t) => ({ ...t })),
    collapsedGroups: async () => opts.collapsed ?? [],
    activate: log('activate', async (id: number) => activate(id)),
    createBlankTab: log('createBlankTab', async () => {
      tabs = [...tabs.map((t) => ({ ...t, active: false })), tab(500, 9, { url: 'about:blank' })];
      activate(500);
      return 500;
    }),
    removeTab: log('removeTab', async (id: number) => {
      tabs = tabs.filter((t) => t.id !== id);
    }),
    saveSwap: async (rec) => {
      stored = rec && { ...rec };
      swaps.push(stored);
      calls.push(rec ? 'saveSwap' : 'clearSwap');
    },
    loadSwap: async () => stored,
    sessionId: async () => SESSION,
    attach: log('attach', async () => {}),
    detach: log('detach', async () => {}),
    screenshot: log('screenshot', async () => 'AAAA'),
    waitForComplete: log('waitForComplete', async () => true),
    reload: log('reload', async () => {}),
    captureVisible: log('captureVisible', async () => 'saved' as const),
    downscale: log('downscale', async () => ({ image: new Blob(['x']), width: 640, height: 360 })),
    save: log('save', save),
    previousOutcome: async () => undefined,
    record,
    now: () => NOW,
    ...opts.over,
  };
  const outcome = () => record.mock.lastCall?.[1];
  const capturer = createTabCapturer(deps);
  return {
    deps,
    calls,
    swaps,
    save,
    record,
    outcome,
    tabs: () => tabs,
    userActivates: activate,
    addTab: (t: Tab) => {
      tabs = [...tabs, t];
    },
    removeTab: (id: number) => {
      tabs = tabs.filter((t) => t.id !== id);
    },
    userNavigates: (id: number, url: string) => {
      tabs = tabs.map((t) => (t.id === id ? { ...t, url } : t));
    },
    capture: (id = TARGET.id, signal?: AbortSignal) => capturer.capture(id, signal),
    recover: capturer.recover,
  };
}

const DATA_URL = 'data:image/jpeg;base64,AAAA';
const leftover: SwapRecord = {
  session: SESSION,
  windowId: WINDOW,
  targetId: 70,
  knownTabIds: [70],
  at: NOW - 1000,
};

afterEach(() => vi.useRealTimers());

describe('createTabCapturer', () => {
  it('attaches, screenshots, and detaches before decoding and saving under the tab’s URL', async () => {
    const { capture, calls, save, outcome } = setup();
    await expect(capture()).resolves.toBe('saved');
    expect(outcome()).toBe('saved');
    expect(calls).toEqual([
      'attach(70)',
      'screenshot(70)',
      'detach(70)',
      `downscale(${DATA_URL})`,
      `save(${TARGET.url},[object Object])`,
    ]);
    expect(save).toHaveBeenCalledWith(TARGET.url, {
      capturedAt: NOW,
      image: expect.any(Blob),
      width: 640,
      height: 360,
    });
  });

  it('detaches when the screenshot fails (e.g. a frozen tab’s CDP internal error)', async () => {
    const { capture, calls, outcome } = setup({
      over: { screenshot: vi.fn().mockRejectedValue(new Error('Internal error')) },
    });
    await capture();
    expect(outcome()).toBe('error:capture: Internal error');
    expect(calls).toEqual(['attach(70)', 'detach(70)']);
  });

  it('gives up on a screenshot that never arrives, and detaches', async () => {
    vi.useFakeTimers();
    const { capture, calls, outcome } = setup({
      over: { screenshot: () => new Promise<string>(() => {}) },
    });
    const done = capture();
    await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS);
    await done;
    expect(outcome()).toBe(`error:capture: timed out after ${SCREENSHOT_TIMEOUT_MS}ms`);
    expect(calls).toEqual(['attach(70)', 'detach(70)']);
  });

  it('detaches at once if attach resolves after the queue gave up on the run', async () => {
    const abort = new AbortController();
    const { capture, calls, outcome } = setup({
      over: {
        attach: async () => {
          calls.push('attach(70)');
          abort.abort();
        },
      },
    });
    await capture(TARGET.id, abort.signal);
    expect(outcome()).toBe('error:attach: gave up waiting');
    expect(calls).toEqual(['attach(70)', 'detach(70)']);
  });

  it.each([
    [
      'an unloaded tab (lazily restored after a browser restart), reloading it',
      'unloaded',
      ['reload(70)'],
    ],
    ['a loading tab', 'loading', []],
  ] as const)(
    'loads %s before attaching, so the infobar is up only for the screenshot',
    async (_name, status, loadStart) => {
      const { capture, calls, outcome } = setup({ target: { status } });
      await expect(capture()).resolves.toBe('saved');
      expect(outcome()).toBe('saved');
      expect(calls).toEqual([
        ...loadStart,
        `waitForComplete(70,${LOAD_TIMEOUT_MS})`,
        'attach(70)',
        'screenshot(70)',
        'detach(70)',
        `downscale(${DATA_URL})`,
        `save(${TARGET.url},[object Object])`,
      ]);
    },
  );

  it('still attaches and tries one screenshot when the tab doesn’t finish loading in time', async () => {
    const env = setup({ target: { status: 'unloaded' } });
    const { capture, calls, outcome } = env;
    env.deps.waitForComplete = async (id, ms) => {
      calls.push(`waitForComplete(${id},${ms})`);
      return false; // timed out (or the tab closed)
    };
    env.deps.screenshot = async (id) => {
      calls.push(`screenshot(${id})`);
      throw new Error('Internal error');
    };
    await capture();
    expect(outcome()).toBe('error:capture: Internal error');
    expect(calls).toEqual([
      'reload(70)',
      `waitForComplete(70,${LOAD_TIMEOUT_MS})`,
      'attach(70)',
      'screenshot(70)',
      'detach(70)',
    ]);
  });

  it('records an attach failure (another debugger is attached) without detaching', async () => {
    const { capture, calls, outcome } = setup({
      over: {
        attach: vi.fn().mockRejectedValue(new Error('Another debugger is already attached')),
      },
    });
    await capture();
    expect(outcome()).toBe('error:attach: Another debugger is already attached');
    expect(calls).toEqual([]);
  });

  it('drops the shot if the tab navigated while it was captured', async () => {
    const env = setup();
    env.deps.screenshot = async () => {
      env.userNavigates(TARGET.id, 'https://example.com/b');
      return 'AAAA';
    };
    await env.capture();
    expect(env.outcome()).toBe('skipped:changed-during-capture');
    expect(env.save).not.toHaveBeenCalled();
  });

  it.each([
    [
      'without the debugger or all-sites permission',
      { over: { hasPermission: async () => false } },
      'skipped:no-permission',
    ],
    [
      'a discarded (sleeping) tab, which attaching would reload',
      { target: { discarded: true } },
      'skipped:discarded',
    ],
    ['an incognito tab', { target: { incognito: true } }, 'skipped:incognito'],
    ['a tab in an incognito window', { win: { incognito: true } }, 'skipped:incognito'],
    ['a chrome:// page', { target: { url: 'chrome://settings' } }, 'skipped:not-capturable-url'],
    [
      'a Web Store page',
      { target: { url: 'https://chromewebstore.google.com/detail/x' } },
      'skipped:not-capturable-url',
    ],
    ['a tab in a popup window', { win: { type: 'popup' } }, 'skipped:not-normal-window'],
    [
      'a tab in Tab Hammer’s own window',
      { over: { viewWindowId: async () => WINDOW } },
      'skipped:own-window',
    ],
  ])('never attaches to %s', async (_name, opts, reason) => {
    const { capture, calls, outcome } = setup(opts);
    await capture();
    expect(outcome()).toBe(reason);
    expect(calls).toEqual([]);
  });

  it('captures the visible tab of a normal window the usual way, without the debugger', async () => {
    const { capture, calls, outcome } = setup({ target: { active: true } });
    await expect(capture()).resolves.toBe('saved');
    expect(outcome()).toBe('saved');
    expect(calls).toEqual([`captureVisible(${WINDOW})`]);
  });

  it('captures a background tab of a minimized window without swapping', async () => {
    const { capture, calls } = setup({
      win: { state: 'minimized' },
      others: [tab(71, 3, { active: true })],
    });
    await capture();
    expect(calls.slice(0, 3)).toEqual(['attach(70)', 'screenshot(70)', 'detach(70)']);
    expect(calls).not.toContain('activate(71)');
  });

  describe('after a failed capture', () => {
    const failed = (at: number, url = TARGET.url) => ({
      over: {
        previousOutcome: async () => ({
          at,
          url,
          outcome: 'error:attach: Another debugger' as const,
        }),
      },
    });

    it('reuses the failure for a minute instead of attaching again', async () => {
      const { capture, calls, record } = setup(failed(NOW - FAILURE_COOLDOWN_MS + 1));
      await expect(capture()).resolves.toBe('error:attach: Another debugger');
      expect(calls).toEqual([]);
      expect(record).not.toHaveBeenCalled();
    });

    it('tries again if the tab has navigated since', async () => {
      const { capture, calls } = setup(failed(NOW, 'https://example.com/before'));
      await expect(capture()).resolves.toBe('saved');
      expect(calls[0]).toBe('attach(70)');
    });

    it('records the URL each outcome was for', async () => {
      const { capture, record } = setup();
      await capture();
      expect(record).toHaveBeenCalledWith(TARGET.id, 'saved', TARGET.url);
    });

    it('tries again once the minute is up', async () => {
      const { capture, calls } = setup(failed(NOW - FAILURE_COOLDOWN_MS - 1));
      await expect(capture()).resolves.toBe('saved');
      expect(calls[0]).toBe('attach(70)');
    });
  });

  describe('the active tab of a minimized window (never drawn)', () => {
    const minimized = { win: { state: 'minimized' }, target: { active: true } };

    it('shows the nearest awake, uncollapsed neighbour while capturing, then reactivates the tab', async () => {
      const others = [
        tab(71, 3, { discarded: true }), // activating would reload it
        tab(72, 1, { groupId: 5 }), // activating would expand its collapsed group
        tab(75, 2, { status: 'unloaded' }), // activating would load a second page
        tab(73, 0),
        tab(74, 6),
      ];
      const { capture, calls, swaps, outcome } = setup({ ...minimized, others, collapsed: [5] });
      await capture();
      expect(outcome()).toBe('saved');
      expect(calls).toEqual([
        'saveSwap',
        'activate(73)',
        'attach(70)',
        'screenshot(70)',
        'detach(70)',
        'activate(70)',
        'clearSwap',
        `downscale(${DATA_URL})`,
        `save(${TARGET.url},[object Object])`,
      ]);
      expect(swaps[0]).toEqual({
        session: SESSION,
        windowId: WINDOW,
        targetId: 70,
        standInId: 73,
        knownTabIds: [70, 71, 72, 75, 73, 74],
        at: NOW,
      });
    });

    it('opens a temporary blank tab when it is the window’s only tab, and removes it after', async () => {
      const { capture, calls, swaps, tabs } = setup(minimized);
      await capture();
      expect(calls).toEqual([
        'saveSwap',
        `createBlankTab(${WINDOW})`,
        'saveSwap',
        'attach(70)',
        'screenshot(70)',
        'detach(70)',
        'activate(70)',
        'removeTab(500)',
        'clearSwap',
        `downscale(${DATA_URL})`,
        `save(${TARGET.url},[object Object])`,
      ]);
      expect(swaps[1]).toMatchObject({ blankId: 500, knownTabIds: [70] });
      expect(tabs().map((t) => [t.id, t.active])).toEqual([[70, true]]);
    });

    it('uses a temporary tab when every neighbour is asleep, unloaded, or in a collapsed group', async () => {
      const others = [
        tab(71, 3, { discarded: true }),
        tab(72, 1, { groupId: 5 }),
        tab(73, 0, { status: 'unloaded' }),
      ];
      const { capture, calls } = setup({ ...minimized, others, collapsed: [5] });
      await capture();
      expect(calls).toEqual([
        'saveSwap',
        `createBlankTab(${WINDOW})`,
        'saveSwap',
        'attach(70)',
        'screenshot(70)',
        'detach(70)',
        'activate(70)',
        'removeTab(500)',
        'clearSwap',
        `downscale(${DATA_URL})`,
        `save(${TARGET.url},[object Object])`,
      ]);
    });

    it('removes nothing when undoing a stand-in swap, even a blank tab that appeared meanwhile', async () => {
      const env = setup({ ...minimized, others: [tab(71, 1)] });
      env.deps.screenshot = async () => {
        env.addTab(tab(600, 5, { url: 'about:blank' })); // e.g. the user opened one
        return 'AAAA';
      };
      await env.capture();
      expect(env.calls).toEqual([
        'saveSwap',
        'activate(71)',
        'attach(70)',
        'detach(70)',
        'activate(70)',
        'clearSwap',
        `downscale(${DATA_URL})`,
        `save(${TARGET.url},[object Object])`,
      ]);
      expect(env.tabs().map((t) => t.id)).toEqual([70, 71, 600]);
    });

    it('never starts a swap while an earlier one is still pending undo', async () => {
      const pending = { ...leftover, at: NOW - 1000 };
      const { capture, calls, outcome } = setup({
        ...minimized,
        others: [tab(71, 1)],
        stored: pending,
      });
      await expect(capture()).resolves.toBe('skipped:swap-pending');
      expect(outcome()).toBe('skipped:swap-pending');
      expect(calls).toEqual([]);
    });

    it('treats a long-abandoned swap record as not pending', async () => {
      const old = { ...leftover, at: NOW - SWAP_RECOVERY_MAX_AGE_MS - 1 };
      const { capture } = setup({ ...minimized, others: [tab(71, 1)], stored: old });
      await expect(capture()).resolves.toBe('saved');
    });

    it('undoes the swap even when the capture fails', async () => {
      const { capture, calls } = setup({
        ...minimized,
        over: { screenshot: vi.fn().mockRejectedValue(new Error('Internal error')) },
      });
      await capture();
      expect(calls).toEqual([
        'saveSwap',
        `createBlankTab(${WINDOW})`,
        'saveSwap',
        'attach(70)',
        'detach(70)',
        'activate(70)',
        'removeTab(500)',
        'clearSwap',
      ]);
    });

    it('undoes the swap even when attaching fails', async () => {
      const { capture, calls } = setup({
        ...minimized,
        others: [tab(71, 1)],
        over: { attach: vi.fn().mockRejectedValue(new Error('Another debugger')) },
      });
      await capture();
      expect(calls).toEqual(['saveSwap', 'activate(71)', 'activate(70)', 'clearSwap']);
    });

    it('leaves the user’s choice alone if they switched tabs mid-capture', async () => {
      const env = setup({ ...minimized, others: [tab(71, 1), tab(72, 4)] });
      env.deps.screenshot = async () => {
        env.userActivates(72);
        return 'AAAA';
      };
      await env.capture();
      expect(env.calls).toEqual([
        'saveSwap',
        'activate(71)',
        'attach(70)',
        'detach(70)',
        'clearSwap',
        `downscale(${DATA_URL})`,
        `save(${TARGET.url},[object Object])`,
      ]);
      expect(env.tabs().find((t) => t.active)?.id).toBe(72);
    });

    it('keeps the temporary tab if the user navigated it mid-capture', async () => {
      const env = setup(minimized);
      env.deps.screenshot = async () => {
        env.userNavigates(500, 'https://example.com/typed');
        return 'AAAA';
      };
      await env.capture();
      expect(env.calls).toEqual([
        'saveSwap',
        `createBlankTab(${WINDOW})`,
        'saveSwap',
        'attach(70)',
        'detach(70)',
        'clearSwap',
        `downscale(${DATA_URL})`,
        `save(${TARGET.url},[object Object])`,
      ]);
      expect(env.tabs().map((t) => [t.id, t.active])).toEqual([
        [70, false],
        [500, true],
      ]);
    });
  });

  describe('recover (a service worker died mid-swap)', () => {
    const blankSwap = { ...leftover, blankId: 500 };

    it('reactivates the target and removes the temporary tab it left behind', async () => {
      const env = setup({
        others: [tab(500, 3, { url: 'about:blank', active: true })],
        stored: blankSwap,
      });
      await env.recover();
      expect(env.calls).toEqual(['activate(70)', 'removeTab(500)', 'clearSwap']);
    });

    it('reactivates the target after a stand-in swap, and removes nothing', async () => {
      const env = setup({
        others: [tab(71, 1, { active: true }), tab(600, 3, { url: 'about:blank' })],
        stored: { ...leftover, standInId: 71, knownTabIds: [70, 71] },
      });
      await env.recover();
      expect(env.calls).toEqual(['activate(70)', 'clearSwap']);
    });

    it('leaves the active tab alone if the user has since moved on, but removes the unused blank', async () => {
      const env = setup({
        others: [tab(71, 1, { active: true }), tab(500, 3, { url: 'about:blank' })],
        stored: { ...blankSwap, knownTabIds: [70, 71] },
      });
      await env.recover();
      expect(env.calls).toEqual(['removeTab(500)', 'clearSwap']);
    });

    type Env = ReturnType<typeof setup>;
    it.each<[string, Partial<SwapRecord>, (env: Env) => void]>([
      ['older than two minutes', { at: NOW - SWAP_RECOVERY_MAX_AGE_MS - 1 }, () => {}],
      [
        'from another browser session (IDs are reused after a restart)',
        { session: 'old' },
        () => {},
      ],
      ['whose target is gone', {}, (env) => env.removeTab(70)],
      ['whose temporary tab is gone', {}, (env) => env.removeTab(500)],
    ])('drops a record %s without touching any tab', async (_name, change, prepare) => {
      const env = setup({
        others: [tab(500, 3, { url: 'about:blank', active: true })],
        stored: { ...blankSwap, ...change },
      });
      prepare(env);
      await env.recover();
      expect(env.calls).toEqual(['clearSwap']);
    });

    it('does nothing without a leftover swap', async () => {
      const { recover, calls } = setup();
      await recover();
      expect(calls).toEqual([]);
    });
  });
});
