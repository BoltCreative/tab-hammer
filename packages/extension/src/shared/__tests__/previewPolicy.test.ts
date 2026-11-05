import { describe, expect, it } from 'vitest';
import {
  STALE_PREVIEW_MS,
  isCapturableUrl,
  pickEvictions,
  previewKey,
  wantsOnDemandCapture,
} from '../previewPolicy';

describe('previewKey', () => {
  it('drops the fragment and keeps the query', () => {
    expect(previewKey('https://a.test/p?q=1#section')).toBe('https://a.test/p?q=1');
    expect(previewKey('https://a.test/p?q=1')).toBe('https://a.test/p?q=1');
    expect(previewKey('https://a.test/p#')).toBe('https://a.test/p');
  });
});

describe('pickEvictions', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const limits = { maxEntries: 3, maxAgeMs: 30 * DAY };
  const e = (key: string, ageDays: number) => ({ key, capturedAt: now - ageDays * DAY });

  it('evicts nothing when under the cap and all fresh', () => {
    expect(pickEvictions([e('a', 1), e('b', 29)], now, limits)).toEqual([]);
  });

  it('evicts entries older than the max age', () => {
    expect(pickEvictions([e('a', 1), e('old', 31), e('b', 2)], now, limits)).toEqual(['old']);
  });

  it('evicts the least recently captured entries beyond the cap', () => {
    const entries = [e('c', 3), e('a', 1), e('e', 5), e('b', 2), e('d', 4)];
    expect(pickEvictions(entries, now, limits).sort()).toEqual(['d', 'e']);
  });

  it('counts only fresh entries against the cap', () => {
    const entries = [e('a', 1), e('b', 2), e('c', 3), e('old1', 40), e('old2', 50)];
    expect(pickEvictions(entries, now, limits).sort()).toEqual(['old1', 'old2']);
  });
});

describe('isCapturableUrl', () => {
  it.each([
    'https://example.com/a',
    'http://localhost:3000/',
    'file:///Users/me/notes.html',
    'https://chrome.google.com/search',
  ])('allows %s', (url) => expect(isCapturableUrl(url)).toBe(true));

  it.each([
    undefined,
    '',
    'not a url',
    'chrome://settings',
    'chrome-extension://abc/src/view/index.html',
    'chrome-untrusted://new-tab-page/',
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
    'view-source:https://example.com',
    'data:text/html,<title>x</title>',
    'https://chromewebstore.google.com/detail/abc',
    'https://chrome.google.com/webstore/detail/abc',
  ])('skips %s', (url) => expect(isCapturableUrl(url)).toBe(false));
});

describe('wantsOnDemandCapture', () => {
  const NOW = 1_000_000_000;
  const tab = { url: 'https://example.com/a', discarded: false, active: true };
  it.each([
    ['no preview', tab, undefined, true],
    ['a fresh preview', tab, NOW - STALE_PREVIEW_MS, false],
    ['a stale preview', tab, NOW - STALE_PREVIEW_MS - 1, true],
    [
      'a background tab (only a Refresh run may attach the debugger)',
      { ...tab, active: false },
      undefined,
      false,
    ],
    ['a discarded tab (attaching would reload it)', { ...tab, discarded: true }, undefined, false],
    ['a page Chrome will not capture', { ...tab, url: 'chrome://settings' }, undefined, false],
  ])('%s', (_name, t, capturedAt, want) => {
    expect(wantsOnDemandCapture(t, capturedAt, NOW)).toBe(want);
  });
});
