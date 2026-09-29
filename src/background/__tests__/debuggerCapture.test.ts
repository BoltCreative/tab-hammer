import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCREENSHOT_TIMEOUT_MS, createTabCapturer, type OffscreenDeps } from '../debuggerCapture';

const WINDOW = 7;
const TARGET = {
  id: 70,
  windowId: WINDOW,
  index: 2,
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
 * Fake Chrome whose every call is logged in order, so tests can assert what happened when (the
 * debugger must detach before the shot is decoded or saved, and the swap must be undone).
 */
function setup(
  opts: {
    target?: Partial<Tab>;
    win?: object;
    others?: Tab[];
    over?: Partial<OffscreenDeps>;
  } = {},
) {
  const calls: string[] = [];
  const log =
    <A extends unknown[], R>(name: string, impl: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(args.length ? `${name}(${args.join(',')})` : name);
      return impl(...args);
    };
  const target = { ...TARGET, ...opts.target };
  const record = vi.fn<OffscreenDeps['record']>(async () => {});
  const deps: OffscreenDeps = {
    hasPermission: async () => true,
    getTab: async () => ({ ...target }),
    getWindow: async () => ({
      type: 'normal' as const,
      state: 'normal' as const,
      incognito: false,
      ...opts.win,
    }),
    viewWindowId: async () => 99,
    tabsInWindow: async () => [target, ...(opts.others ?? [])],
    activate: log('activate', async () => {}),
    createBlankTab: log('createBlankTab', async () => 500),
    removeTab: log('removeTab', async () => {}),
    attach: log('attach', async () => {}),
    detach: log('detach', async () => {}),
    screenshot: log('screenshot', async () => 'AAAA'),
    captureVisible: log('captureVisible', async () => 'saved' as const),
    downscale: log('downscale', async () => ({ image: new Blob(['x']), width: 640, height: 360 })),
    save: log('save', async () => {}),
    record,
    now: () => 5000,
    ...opts.over,
  };
  const outcome = () => record.mock.lastCall?.[1];
  return { deps, calls, outcome, capture: createTabCapturer(deps) };
}

afterEach(() => vi.useRealTimers());

describe('createTabCapturer', () => {
  it('attaches, screenshots, and detaches before decoding and saving under the tab’s URL', async () => {
    const save = vi.fn(async () => {});
    const { capture, calls, outcome } = setup({ over: { save } });
    await expect(capture(TARGET.id)).resolves.toBe('saved');
    expect(outcome()).toBe('saved');
    expect(calls).toEqual([
      'attach(70)',
      'screenshot(70)',
      'detach(70)',
      'downscale(data:image/jpeg;base64,AAAA)',
    ]);
    expect(save).toHaveBeenCalledWith(TARGET.url, {
      capturedAt: 5000,
      image: expect.any(Blob),
      width: 640,
      height: 360,
    });
  });

  it('detaches when the screenshot fails (e.g. a frozen tab’s CDP internal error)', async () => {
    const { capture, calls, outcome } = setup({
      over: { screenshot: vi.fn().mockRejectedValue(new Error('Internal error')) },
    });
    await capture(TARGET.id);
    expect(outcome()).toBe('error:capture: Internal error');
    expect(calls).toEqual(['attach(70)', 'detach(70)']);
  });

  it('gives up on a screenshot that never arrives, and detaches', async () => {
    vi.useFakeTimers();
    const { capture, calls, outcome } = setup({
      over: { screenshot: () => new Promise<string>(() => {}) },
    });
    const done = capture(TARGET.id);
    await vi.advanceTimersByTimeAsync(SCREENSHOT_TIMEOUT_MS);
    await done;
    expect(outcome()).toBe(`error:capture: timed out after ${SCREENSHOT_TIMEOUT_MS}ms`);
    expect(calls).toEqual(['attach(70)', 'detach(70)']);
  });

  it('records an attach failure (another debugger is attached) without detaching', async () => {
    const { capture, calls, outcome } = setup({
      over: {
        attach: vi.fn().mockRejectedValue(new Error('Another debugger is already attached')),
      },
    });
    await capture(TARGET.id);
    expect(outcome()).toBe('error:attach: Another debugger is already attached');
    expect(calls).toEqual([]);
  });

  it('drops the shot if the tab navigated while it was captured', async () => {
    const getTab = vi
      .fn()
      .mockResolvedValueOnce({ ...TARGET })
      .mockResolvedValueOnce({ ...TARGET, url: 'https://example.com/b' });
    const { capture, calls, outcome } = setup({ over: { getTab } });
    await capture(TARGET.id);
    expect(outcome()).toBe('skipped:changed-during-capture');
    expect(calls).not.toContain('save');
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
    ['a tab still loading', { target: { status: 'loading' as const } }, 'skipped:not-complete'],
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
    await capture(TARGET.id);
    expect(outcome()).toBe(reason);
    expect(calls).toEqual([]);
  });

  it('captures the visible tab of a normal window the usual way, without the debugger', async () => {
    const { capture, calls, outcome } = setup({ target: { active: true } });
    await expect(capture(TARGET.id)).resolves.toBe('saved');
    expect(outcome()).toBe('saved');
    expect(calls).toEqual([`captureVisible(${WINDOW})`]);
  });

  it('captures a background tab of a minimized window without swapping', async () => {
    const { capture, calls } = setup({ win: { state: 'minimized' } });
    await capture(TARGET.id);
    expect(calls.slice(0, 3)).toEqual(['attach(70)', 'screenshot(70)', 'detach(70)']);
  });

  describe('the active tab of a minimized window (never drawn)', () => {
    const minimized = { win: { state: 'minimized' }, target: { active: true } };

    it('shows the nearest awake neighbour while capturing, then reactivates the tab', async () => {
      const others = [
        tab(71, 3, { discarded: true }), // nearest, but activating would reload it
        tab(72, 0),
        tab(73, 5),
      ];
      const { capture, calls, outcome } = setup({ ...minimized, others });
      await capture(TARGET.id);
      expect(outcome()).toBe('saved');
      expect(calls.slice(0, 5)).toEqual([
        'activate(72)',
        'attach(70)',
        'screenshot(70)',
        'detach(70)',
        'activate(70)',
      ]);
    });

    it('opens a temporary blank tab when it is the window’s only tab, and removes it after', async () => {
      const { capture, calls } = setup(minimized);
      await capture(TARGET.id);
      expect(calls.slice(0, 6)).toEqual([
        `createBlankTab(${WINDOW})`,
        'attach(70)',
        'screenshot(70)',
        'detach(70)',
        'activate(70)',
        'removeTab(500)',
      ]);
    });

    it('undoes the swap even when the capture fails', async () => {
      const { capture, calls } = setup({
        ...minimized,
        over: { screenshot: vi.fn().mockRejectedValue(new Error('Internal error')) },
      });
      await capture(TARGET.id);
      expect(calls).toEqual([
        `createBlankTab(${WINDOW})`,
        'attach(70)',
        'detach(70)',
        'activate(70)',
        'removeTab(500)',
      ]);
    });

    it('undoes the swap even when attaching fails', async () => {
      const { capture, calls } = setup({
        ...minimized,
        others: [tab(71, 1)],
        over: { attach: vi.fn().mockRejectedValue(new Error('Another debugger')) },
      });
      await capture(TARGET.id);
      expect(calls).toEqual(['activate(71)', 'activate(70)']);
    });
  });
});
