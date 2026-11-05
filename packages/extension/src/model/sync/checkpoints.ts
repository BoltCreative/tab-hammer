// Checkpoints: dated snapshots of this computer's outline. Which to take, and which to keep. Pure;
// days and weeks are the local calendar's, so "one a day" means the user's day.
import type { SyncWindow } from './export';

export interface CheckpointMeta {
  checkpointAt: number;
  drastic?: boolean; // taken before something drastic (a big drop, Restore all, self-restore)
}

export const DAILY_KEPT = 14;
export const WEEKLY_KEPT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The local calendar day of `t` as a day count (from 1970-01-01), immune to DST-length days. */
export function dayKey(t: number): number {
  const d = new Date(t);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** The Monday-to-Sunday week holding `t`'s local day, as a week count. */
export function weekKey(t: number): number {
  // Day 0 (1970-01-01) was a Thursday: shift so Mondays fall on multiples of 7.
  return Math.floor((dayKey(t) + 3) / 7);
}

/**
 * Retention: for each of the 14 most recent days that have a checkpoint, the newest of the day and
 * every pre-drastic one; then, among older checkpoints, the newest of each of the 8 most recent
 * weeks. Counted in days and weeks that have checkpoints, so a computer left unused for a month
 * keeps its history rather than aging it all out.
 */
export function pruneCheckpoints<T extends CheckpointMeta>(list: T[]): { keep: T[]; drop: T[] } {
  const sorted = [...list].sort((a, b) => b.checkpointAt - a.checkpointAt);
  const days = new Set<number>(); // the daily days, filled newest first
  const weeks = new Set<number>(); // the weekly weeks, likewise
  const keep = new Set<T>();
  for (const c of sorted) {
    const day = dayKey(c.checkpointAt);
    if (days.has(day)) {
      if (c.drastic) keep.add(c);
      continue;
    }
    if (days.size < DAILY_KEPT && weeks.size === 0) {
      days.add(day);
      keep.add(c); // the newest of its day
      continue;
    }
    const week = weekKey(c.checkpointAt);
    if (weeks.has(week) || weeks.size === WEEKLY_KEPT) continue;
    weeks.add(week);
    keep.add(c); // the newest of its week, past the daily days
  }
  return {
    keep: sorted.filter((c) => keep.has(c)),
    drop: sorted.filter((c) => !keep.has(c)),
  };
}

/** No everyday (non-drastic) checkpoint has been taken today yet. */
export function dailyCheckpointDue(list: CheckpointMeta[], now: number): boolean {
  const today = dayKey(now);
  return !list.some((c) => !c.drastic && dayKey(c.checkpointAt) === today);
}

const openIds = (ws: SyncWindow[]) => ws.filter((w) => w.state !== 'trashed').map((w) => w.id);

/**
 * A push that would drop more than half of the previously pushed open (not trashed) windows, at
 * least two of them: deleted, trashed, or gone some other way.
 */
export function isDrasticDrop(prev: SyncWindow[], next: SyncWindow[]): boolean {
  const before = openIds(prev);
  const after = new Set(openIds(next));
  const dropped = before.filter((id) => !after.has(id)).length;
  return dropped >= 2 && dropped * 2 > before.length;
}
