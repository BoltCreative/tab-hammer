// Decides which saved window a window Chrome restored corresponds to.
// Pure strings in, assignments out; no chrome.* access.

export const MATCH_THRESHOLD = 0.6;
export const LOOSE_SCORE = 0.75;

const BLANK_PAGES = new Set(['', 'about:blank', 'chrome://newtab/', 'chrome://new-tab-page/']);

export function isBlankPage(url: string): boolean {
  return BLANK_PAGES.has(url);
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isWeb(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:';
}

function webHost(u: URL): string {
  const host = u.hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

function webPath(u: URL): string {
  return u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
}

export function normalizeForMatch(url: string): string {
  const u = parse(url);
  if (!u) return url;
  if (isWeb(u)) {
    const port = u.port ? `:${u.port}` : '';
    return `https://${webHost(u)}${port}${webPath(u)}${u.search}`;
  }
  u.hash = '';
  return u.href;
}

/** Host + path with no query, or null for non-web or unparseable URLs. */
function looseKey(url: string): string | null {
  const u = parse(url);
  if (!u || !isWeb(u)) return null;
  return `${webHost(u)}${u.port ? `:${u.port}` : ''}${webPath(u)}`;
}

export interface RestoredTab {
  url: string;
  launchUrl?: string;
}

interface TabKeys {
  exact: string[];
  loose: (string | null)[];
}

function restoredKeys(tab: RestoredTab): TabKeys {
  const urls = tab.launchUrl === undefined ? [tab.url] : [tab.launchUrl, tab.url];
  return { exact: urls.map(normalizeForMatch), loose: urls.map(looseKey) };
}

interface SavedKeys {
  blank: boolean;
  exact: string;
  loose: string | null;
}

function savedKeys(url: string): SavedKeys {
  return { blank: isBlankPage(url), exact: normalizeForMatch(url), loose: looseKey(url) };
}

// Blank saved pages never match: two new-tab pages say nothing about identity.
function keyedMatch(r: TabKeys, s: SavedKeys): 0 | 0.75 | 1 {
  if (s.blank) return 0;
  if (r.exact.includes(s.exact)) return 1;
  if (s.loose !== null && r.loose.includes(s.loose)) return LOOSE_SCORE;
  return 0;
}

export function tabMatch(restored: RestoredTab, savedUrl: string): 0 | 0.75 | 1 {
  return keyedMatch(restoredKeys(restored), savedKeys(savedUrl));
}

export interface Alignment {
  score: number;
  pairs: [restoredIndex: number, savedIndex: number][];
}

export function alignWindows(restored: RestoredTab[], saved: string[]): Alignment {
  const n = restored.length;
  const m = saved.length;
  if (n === 0 && m === 0) return { score: 0, pairs: [] };
  const singleTab = n === 1 || m === 1;
  const rKeys = restored.map(restoredKeys);
  const sKeys = saved.map(savedKeys);
  const weight = (i: number, j: number): number => {
    const w = keyedMatch(rKeys[i], sKeys[j]);
    return singleTab && w < 1 ? 0 : w;
  };
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const w = weight(i - 1, j - 1);
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], w > 0 ? dp[i - 1][j - 1] + w : 0);
    }
  }
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const w = weight(i - 1, j - 1);
    if (w > 0 && dp[i][j] === dp[i - 1][j - 1] + w) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j]) {
      i--;
    } else {
      j--;
    }
  }
  pairs.reverse();
  return { score: dp[n][m] / Math.max(n, m), pairs };
}

export interface MatchRestored {
  id: string;
  tabs: RestoredTab[];
}

export interface MatchCandidate {
  id: string;
  tabs: string[];
  openAtShutdown: boolean;
  lastLiveAt: number;
}

export interface Assignment {
  restoredId: string;
  candidateId: string;
  alignment: Alignment;
}

export function assignMatches(
  restored: MatchRestored[],
  candidates: MatchCandidate[],
): Assignment[] {
  const scored: { ri: number; ci: number; alignment: Alignment }[] = [];
  restored.forEach((rw, ri) => {
    if (
      rw.tabs.every(
        (t) => isBlankPage(t.url) && (t.launchUrl === undefined || isBlankPage(t.launchUrl)),
      )
    )
      return;
    candidates.forEach((cand, ci) => {
      if (cand.tabs.every(isBlankPage)) return;
      const alignment = alignWindows(rw.tabs, cand.tabs);
      if (alignment.score >= MATCH_THRESHOLD) scored.push({ ri, ci, alignment });
    });
  });
  scored.sort((a, b) => {
    const ca = candidates[a.ci];
    const cb = candidates[b.ci];
    return (
      b.alignment.score - a.alignment.score ||
      Number(cb.openAtShutdown) - Number(ca.openAtShutdown) ||
      cb.lastLiveAt - ca.lastLiveAt ||
      a.ci - b.ci ||
      a.ri - b.ri
    );
  });
  const usedR = new Set<number>();
  const usedC = new Set<number>();
  const out: Assignment[] = [];
  for (const s of scored) {
    if (usedR.has(s.ri) || usedC.has(s.ci)) continue;
    usedR.add(s.ri);
    usedC.add(s.ci);
    out.push({
      restoredId: restored[s.ri].id,
      candidateId: candidates[s.ci].id,
      alignment: s.alignment,
    });
  }
  return out;
}
