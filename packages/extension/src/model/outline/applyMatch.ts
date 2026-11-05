// Folds a restored Chrome window into the saved row it matches. Pure: the caller
// passes the clock.

import { assignMatches, type Alignment } from './matching';
import type { MatchCandidate, MatchRestored } from './matching';
import { mergeHibernated } from './reconcile';
import type { GroupRec, Outline, TabRec, WindowRec } from './types';

function isCandidate(w: WindowRec): boolean {
  return w.state === 'trashed' || (w.state === 'hibernated' && w.openAtShutdown === true);
}

function applyOne(c: WindowRec, p: WindowRec, alignment: Alignment, now: number): WindowRec {
  const savedLive = c.tabs.filter((t) => t.liveAtClose === true);
  const savedFor = new Map<number, TabRec>(); // restored tab index -> saved record
  for (const [ri, si] of alignment.pairs) savedFor.set(ri, savedLive[si]!);

  // Each Chrome group in P re-attaches to the unclaimed saved group holding most of its aligned tabs.
  const groupMap = new Map<string, GroupRec>(); // P group id -> resulting group record
  const claimed = new Set<string>();
  for (const pg of p.groups) {
    const votes = new Map<string, number>();
    p.tabs.forEach((t, i) => {
      const gid = savedFor.get(i)?.groupId;
      if (t.groupId === pg.id && gid !== undefined && !claimed.has(gid)) {
        votes.set(gid, (votes.get(gid) ?? 0) + 1);
      }
    });
    let best: string | undefined;
    let bestVotes = 0;
    for (const g of c.groups) {
      const n = votes.get(g.id) ?? 0;
      if (n > bestVotes) {
        best = g.id;
        bestVotes = n;
      }
    }
    const saved = c.groups.find((g) => g.id === best);
    if (!saved) {
      groupMap.set(pg.id, pg);
      continue;
    }
    claimed.add(saved.id);
    const same =
      saved.title === pg.title && saved.color === pg.color && saved.collapsed === pg.collapsed;
    const rec: GroupRec = {
      ...saved,
      title: pg.title,
      color: pg.color,
      collapsed: pg.collapsed,
      modifiedAt: same ? saved.modifiedAt : now,
    };
    if (pg.chromeGroupId !== undefined) rec.chromeGroupId = pg.chromeGroupId;
    groupMap.set(pg.id, rec);
  }

  const live = p.tabs.map((t, i): TabRec => {
    const groupId =
      t.groupId === undefined ? undefined : (groupMap.get(t.groupId)?.id ?? t.groupId);
    const saved = savedFor.get(i);
    const rec: TabRec = { ...t, id: saved?.id ?? t.id };
    if (groupId === undefined) delete rec.groupId;
    else rec.groupId = groupId;
    if (saved) {
      const changed = saved.url !== t.url || saved.title !== t.title || saved.groupId !== groupId;
      rec.modifiedAt = changed ? now : saved.modifiedAt;
    }
    return rec;
  });

  const stripped = c.tabs.map((t) => {
    if (t.chromeTabId === undefined) return t;
    const next = { ...t };
    delete next.chromeTabId;
    return next;
  });
  const tabs = mergeHibernated(stripped, live);

  const used = new Set(tabs.map((t) => t.groupId));
  const savedGroups = c.groups.map((g) => {
    const rec = [...groupMap.values()].find((x) => x.id === g.id);
    if (rec) return rec;
    if (g.chromeGroupId === undefined) return g;
    const next = { ...g };
    delete next.chromeGroupId;
    return next;
  });
  const savedIds = new Set(savedGroups.map((g) => g.id));
  const added = [...groupMap.values()].filter((g) => !savedIds.has(g.id));
  const groups = [...savedGroups, ...added].filter((g) => used.has(g.id));

  const out: WindowRec = {
    ...c,
    state: 'live',
    lastLiveAt: now,
    modifiedAt: now,
    tabs,
    groups,
  };
  if (p.chromeWindowId !== undefined) out.chromeWindowId = p.chromeWindowId;
  if (p.bounds !== undefined) out.bounds = p.bounds; // where the restored window is now
  delete out.closedAt;
  delete out.openAtShutdown;
  delete out.provisional;
  return out;
}

/** Matches the given provisional windows against the outline's candidates and applies every
 *  assignment. Unmatched provisional windows just lose the flag. */
export function matchRestored(o: Outline, provisionalIds: string[], now: number): Outline {
  const wanted = new Set(provisionalIds);
  const provisional = o.windows.filter((w) => wanted.has(w.id) && w.state === 'live');
  if (provisional.length === 0) return o;

  const restored: MatchRestored[] = provisional.map((w) => ({
    id: w.id,
    tabs: w.tabs.map((t) =>
      t.launchUrl === undefined ? { url: t.url } : { url: t.url, launchUrl: t.launchUrl },
    ),
  }));
  const candidates: MatchCandidate[] = o.windows.filter(isCandidate).map((w) => ({
    id: w.id,
    tabs: w.tabs.filter((t) => t.liveAtClose === true).map((t) => t.url),
    openAtShutdown: w.openAtShutdown === true,
    lastLiveAt: w.lastLiveAt,
  }));
  const assignments = assignMatches(restored, candidates);

  const byId = new Map(o.windows.map((w) => [w.id, w]));
  const replace = new Map<string, WindowRec>();
  const drop = new Set<string>();
  for (const a of assignments) {
    replace.set(
      a.candidateId,
      applyOne(byId.get(a.candidateId)!, byId.get(a.restoredId)!, a.alignment, now),
    );
    drop.add(a.restoredId);
  }
  const windows: WindowRec[] = [];
  for (const w of o.windows) {
    if (drop.has(w.id)) continue;
    const next = replace.get(w.id);
    if (next) windows.push(next);
    else if (wanted.has(w.id) && w.provisional) {
      const rest = { ...w };
      delete rest.provisional;
      windows.push(rest);
    } else windows.push(w);
  }
  return { windows };
}
