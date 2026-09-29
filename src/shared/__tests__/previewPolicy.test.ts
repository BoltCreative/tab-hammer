import { describe, expect, it } from 'vitest';
import { pickEvictions, previewKey } from '../previewPolicy';

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
