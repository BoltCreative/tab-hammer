import { describe, expect, it, vi } from 'vitest';
import {
  createActivationGenerations,
  createWindowCapturer,
  type CaptureDeps,
} from '../captureWindow';

const WINDOW = 7;
const TAB = {
  id: 70,
  url: 'https://example.com/a',
  status: 'complete' as const,
  incognito: false,
};
const QUOTA = new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');

function setup(over: Partial<CaptureDeps> = {}, win: object = {}) {
  const generations = createActivationGenerations();
  const record = vi.fn<CaptureDeps['record']>(async () => {});
  const deps = {
    hasPermission: vi.fn(async () => true),
    getWindow: vi.fn(async () => ({
      type: 'normal' as const,
      state: 'normal' as const,
      incognito: false,
      ...win,
    })),
    viewWindowId: vi.fn(async () => 99),
    activeTab: vi.fn(async () => ({ ...TAB })),
    captureVisibleTab: vi.fn(async () => 'data:image/jpeg;base64,xx'),
    downscale: vi.fn(async () => ({ image: new Blob(['x']), width: 640, height: 360 })),
    save: vi.fn(async () => {}),
    retry: vi.fn(),
    generation: generations.get,
    record,
    now: () => 5000,
    ...over,
  } satisfies CaptureDeps;
  const outcome = () => record.mock.lastCall?.[1];
  return { deps, outcome, capture: createWindowCapturer(deps) };
}

describe('createWindowCapturer', () => {
  it('stores the visible tab under its URL', async () => {
    const { deps, capture, outcome } = setup();
    await capture(WINDOW);
    expect(outcome()).toBe('saved');
    expect(deps.captureVisibleTab).toHaveBeenCalledWith(WINDOW);
    expect(deps.save).toHaveBeenCalledWith(TAB.url, {
      capturedAt: 5000,
      image: expect.any(Blob),
      width: 640,
      height: 360,
    });
  });

  it('never captures without the all-urls permission, and skips before touching the window', async () => {
    const { deps, capture, outcome } = setup({ hasPermission: vi.fn(async () => false) });
    await capture(WINDOW);
    expect(outcome()).toBe('skipped:no-permission');
    expect(deps.getWindow).not.toHaveBeenCalled();
    expect(deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it.each([
    ['an incognito window', { incognito: true }, 'skipped:incognito'],
    ['a minimized window', { state: 'minimized' }, 'skipped:minimized'],
    ['a popup window (Tab Hammer itself)', { type: 'popup' }, 'skipped:not-normal-window'],
  ])('never captures %s', async (_name, win, reason) => {
    const { deps, capture, outcome } = setup({}, win);
    await capture(WINDOW);
    expect(outcome()).toBe(reason);
    expect(deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it('never captures an incognito tab', async () => {
    const { deps, capture } = setup({
      activeTab: vi.fn(async () => ({ ...TAB, incognito: true })),
    });
    await capture(WINDOW);
    expect(deps.captureVisibleTab).not.toHaveBeenCalled();
  });

  it.each([
    ['switched to another tab', { id: 71 }],
    ['navigated', { url: 'https://example.com/b' }],
  ])('drops the shot if the window %s during capture', async (_name, change) => {
    const activeTab = vi
      .fn()
      .mockResolvedValueOnce({ ...TAB })
      .mockResolvedValueOnce({ ...TAB, ...change });
    const { deps, capture, outcome } = setup({ activeTab });
    await capture(WINDOW);
    expect(deps.captureVisibleTab).toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(outcome()).toBe('skipped:changed-during-capture');
  });

  it('drops the shot if the window went to another tab and back (A→B→A) during capture', async () => {
    const generations = createActivationGenerations();
    const captureVisibleTab = vi.fn(async () => {
      generations.bump(WINDOW); // → B
      generations.bump(WINDOW); // → A again; the active tab looks unchanged afterwards
      return 'data:image/jpeg;base64,xx';
    });
    const { deps, capture, outcome } = setup({
      captureVisibleTab,
      generation: generations.get,
    });
    await capture(WINDOW);
    expect(deps.save).not.toHaveBeenCalled();
    expect(outcome()).toBe('skipped:changed-during-capture');
  });

  it('keeps the shot when only another window changed during capture', async () => {
    const generations = createActivationGenerations();
    const captureVisibleTab = vi.fn(async () => {
      generations.bump(WINDOW + 1);
      return 'data:image/jpeg;base64,xx';
    });
    const { deps, capture, outcome } = setup({
      captureVisibleTab,
      generation: generations.get,
    });
    await capture(WINDOW);
    expect(deps.save).toHaveBeenCalled();
    expect(outcome()).toBe('saved');
  });

  it.each([
    ['downscale', { downscale: vi.fn().mockRejectedValue(new Error('decode failed')) }],
    ['save', { save: vi.fn().mockRejectedValue(new Error('quota exceeded')) }],
  ])('records a %s failure instead of losing it', async (stage, over) => {
    const { capture, outcome } = setup(over);
    await expect(capture(WINDOW)).resolves.toMatch(new RegExp(`^error:${stage}: `));
    expect(outcome()).toMatch(new RegExp(`^error:${stage}: `));
  });

  it('retries once through the scheduler after a quota error, then gives up', async () => {
    const { deps, capture } = setup({ captureVisibleTab: vi.fn().mockRejectedValue(QUOTA) });
    await capture(WINDOW);
    expect(deps.retry).toHaveBeenCalledTimes(1);
    expect(deps.retry).toHaveBeenCalledWith(WINDOW);
    await capture(WINDOW); // the retry hits the quota again
    expect(deps.retry).toHaveBeenCalledTimes(1);
    await capture(WINDOW); // a fresh trigger later may retry again
    expect(deps.retry).toHaveBeenCalledTimes(2);
  });

  it('does not retry other capture errors', async () => {
    const { deps, capture, outcome } = setup({
      captureVisibleTab: vi.fn().mockRejectedValue(new Error('Cannot access contents')),
    });
    await capture(WINDOW);
    expect(outcome()).toBe('error:capture: Cannot access contents');
    expect(deps.retry).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });
});
