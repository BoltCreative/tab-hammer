import { describe, expect, it } from 'vitest';
import {
  alignWindows,
  assignMatches,
  isBlankPage,
  normalizeForMatch,
  tabMatch,
  type MatchCandidate,
  type MatchRestored,
} from '../matching';

const u = (p: string) => 'https://e.test/' + p;
const r = (p: string) => ({ url: u(p) });
const R = (id: string, paths: string[]): MatchRestored => ({ id, tabs: paths.map(r) });
const C = (id: string, paths: string[], opts: Partial<MatchCandidate> = {}): MatchCandidate => ({
  id,
  tabs: paths.map(u),
  openAtShutdown: false,
  lastLiveAt: 0,
  ...opts,
});

describe('normalizeForMatch', () => {
  it('ignores scheme http/https, www, fragment and trailing slash', () => {
    expect(normalizeForMatch('http://www.Example.com/a/#top')).toBe(
      normalizeForMatch('https://example.com/a'),
    );
    expect(normalizeForMatch('https://e.test/')).toBe(normalizeForMatch('https://e.test'));
    expect(normalizeForMatch('chrome://settings/#x')).toBe('chrome://settings/');
  });
});

describe('isBlankPage', () => {
  it('recognizes empty and new-tab pages', () => {
    for (const x of ['', 'about:blank', 'chrome://newtab/', 'chrome://new-tab-page/']) {
      expect(isBlankPage(x)).toBe(true);
    }
    expect(isBlankPage(u('a'))).toBe(false);
  });
});

describe('tabMatch', () => {
  it('exact on launch or current URL, loose when only the query differs', () => {
    expect(
      tabMatch({ url: 'https://login.e.test/?next=1', launchUrl: u('inbox') }, u('inbox')),
    ).toBe(1);
    expect(tabMatch({ url: u('p?a=1') }, u('p?cf_chl=2'))).toBe(0.75);
    expect(tabMatch({ url: u('p') }, u('q'))).toBe(0);
  });
});

describe('alignWindows', () => {
  it('scores identical windows 1 and reordered ones by their longest common run', () => {
    expect(alignWindows(['a', 'b', 'c'].map(r), ['a', 'b', 'c'].map(u)).score).toBe(1);
    const a = alignWindows(['c', 'a', 'b'].map(r), ['a', 'b', 'c'].map(u));
    expect(a.score).toBeCloseTo(2 / 3);
    expect(a.pairs).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it('added tabs cost only their share; removed tabs too', () => {
    expect(alignWindows(['a', 'b', 'c', 'd'].map(r), ['a', 'b', 'c'].map(u)).score).toBe(0.75);
    expect(alignWindows(['a', 'b'].map(r), ['a', 'b', 'c', 'd'].map(u)).score).toBe(0.5);
    expect(alignWindows([], []).score).toBe(0);
  });
});

describe('assignMatches', () => {
  it('rejects a window that is mostly different', () => {
    expect(assignMatches([R('r', ['a', 'b'])], [C('c', ['a', 'b', 'c', 'd', 'e'])])).toEqual([]);
  });

  it('a single-tab window must match exactly', () => {
    expect(assignMatches([R('r', ['p?q=1'])], [C('c', ['p?q=2'])])).toEqual([]);
    expect(assignMatches([R('r', ['p'])], [C('c', ['p'])])).toHaveLength(1);
  });

  it('loose matches count in multi-tab windows', () => {
    const out = assignMatches([R('r', ['a?x=1', 'b?x=1'])], [C('c', ['a?x=2', 'b?x=2'])]);
    expect(out).toHaveLength(1);
    expect(out[0].alignment.score).toBe(0.75);
  });

  it('windows of only new-tab pages are never matched', () => {
    const blank = { id: 'r', tabs: [{ url: 'chrome://newtab/' }] };
    const cand: MatchCandidate = {
      id: 'c',
      tabs: ['chrome://newtab/'],
      openAtShutdown: true,
      lastLiveAt: 1,
    };
    expect(assignMatches([blank], [cand])).toEqual([]);
  });

  it('assigns globally best pairs first', () => {
    const A = R('A', ['p', 'q', 'z']);
    const B = R('B', ['p', 'q', 'r', 'z']);
    const X = C('X', ['p', 'q', 'r', 'z']);
    const Y = C('Y', ['p', 'q', 'w']);
    const out = assignMatches([A, B], [X, Y]);
    expect(out.map((m) => [m.restoredId, m.candidateId])).toEqual([
      ['B', 'X'],
      ['A', 'Y'],
    ]);
  });

  it('ties prefer open-at-shutdown candidates, then the most recently live', () => {
    const win = R('r', ['a', 'b']);
    const open = assignMatches(
      [win],
      [
        C('old', ['a', 'b'], { lastLiveAt: 9 }),
        C('open', ['a', 'b'], { openAtShutdown: true, lastLiveAt: 1 }),
      ],
    );
    expect(open.map((m) => m.candidateId)).toEqual(['open']);
    const recent = assignMatches(
      [win],
      [C('older', ['a', 'b'], { lastLiveAt: 1 }), C('newer', ['a', 'b'], { lastLiveAt: 2 })],
    );
    expect(recent.map((m) => m.candidateId)).toEqual(['newer']);
  });

  it('each restored window and candidate is used at most once', () => {
    const out = assignMatches([R('r1', ['a', 'b']), R('r2', ['a', 'b'])], [C('c1', ['a', 'b'])]);
    expect(out).toHaveLength(1);
    const two = assignMatches(
      [R('r1', ['a', 'b']), R('r2', ['a', 'b'])],
      [C('c1', ['a', 'b']), C('c2', ['a', 'b'])],
    );
    expect(new Set(two.map((m) => m.restoredId)).size).toBe(2);
    expect(new Set(two.map((m) => m.candidateId)).size).toBe(2);
  });
});
