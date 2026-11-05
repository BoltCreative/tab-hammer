import { describe, expect, it } from 'vitest';
import {
  dailyCheckpointDue,
  dayKey,
  isDrasticDrop,
  pruneCheckpoints,
  weekKey,
  type CheckpointMeta,
} from '../checkpoints';
import { swin } from './files';

/** Local time, like the user's calendar. Months are 1-based here. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const cp = (t: number, drastic = false): CheckpointMeta =>
  drastic ? { checkpointAt: t, drastic } : { checkpointAt: t };

/** One checkpoint a day at noon for `n` days ending on (y, m, d). */
function daily(n: number, y: number, m: number, d: number): CheckpointMeta[] {
  return Array.from({ length: n }, (_, i) => cp(new Date(y, m - 1, d - i, 12).getTime()));
}

describe('day and week keys', () => {
  it('a day is the local calendar day', () => {
    expect(dayKey(at(2026, 3, 1, 0))).toBe(dayKey(at(2026, 3, 1, 23)));
    expect(dayKey(at(2026, 3, 1))).toBe(dayKey(at(2026, 2, 28)) + 1);
    expect(dayKey(at(2025, 1, 1))).toBe(dayKey(at(2024, 12, 31)) + 1);
    expect(dayKey(at(2024, 3, 1))).toBe(dayKey(at(2024, 2, 29)) + 1); // leap day
  });

  it('a week runs Monday to Sunday, across a year edge', () => {
    // Mon 2024-12-30 .. Sun 2025-01-05 is one week.
    expect(weekKey(at(2024, 12, 30))).toBe(weekKey(at(2025, 1, 5)));
    expect(weekKey(at(2024, 12, 29))).toBe(weekKey(at(2024, 12, 30)) - 1); // Sunday before
    expect(weekKey(at(2025, 1, 6))).toBe(weekKey(at(2025, 1, 5)) + 1); // next Monday
  });
});

describe('pruneCheckpoints', () => {
  it('keeps everything while there are 14 days or fewer', () => {
    const list = daily(14, 2026, 11, 5);
    expect(pruneCheckpoints(list).drop).toEqual([]);
  });

  it('keeps only the newest of each day, except pre-drastic ones', () => {
    const list = [cp(at(2026, 11, 5, 9)), cp(at(2026, 11, 5, 10), true), cp(at(2026, 11, 5, 18))];
    const { keep, drop } = pruneCheckpoints(list);
    expect(keep.map((c) => c.checkpointAt)).toEqual([at(2026, 11, 5, 18), at(2026, 11, 5, 10)]);
    expect(drop.map((c) => c.checkpointAt)).toEqual([at(2026, 11, 5, 9)]);
  });

  it('past 14 days, keeps the newest of each of 8 weeks and drops the rest', () => {
    // 100 daily checkpoints ending Thu 2026-11-05.
    const list = daily(100, 2026, 11, 5);
    const { keep } = pruneCheckpoints(list);
    expect(keep).toHaveLength(14 + 8);
    const older = keep.slice(14);
    // The 14 daily days run back to Fri 2026-10-23; the rest of that week (Mon 19 - Thu 22)
    // is its own weekly bucket, newest first.
    expect(older.map((c) => new Date(c.checkpointAt).toDateString())).toEqual([
      'Thu Oct 22 2026',
      'Sun Oct 18 2026',
      'Sun Oct 11 2026',
      'Sun Oct 04 2026',
      'Sun Sep 27 2026',
      'Sun Sep 20 2026',
      'Sun Sep 13 2026',
      'Sun Sep 06 2026',
    ]);
    expect(new Set(older.map((c) => weekKey(c.checkpointAt))).size).toBe(8);
  });

  it('drops pre-drastic checkpoints once their day is past the daily window', () => {
    const list = [...daily(14, 2026, 11, 5), cp(at(2026, 10, 1, 9), true), cp(at(2026, 10, 1, 8))];
    const { keep } = pruneCheckpoints(list);
    expect(keep.filter((c) => dayKey(c.checkpointAt) === dayKey(at(2026, 10, 1)))).toEqual([
      cp(at(2026, 10, 1, 9), true),
    ]);
  });

  it('counts days that have checkpoints, so an idle month keeps its history', () => {
    // Five days in January, then nothing until November.
    const list = [...daily(5, 2026, 1, 20), cp(at(2026, 11, 5))];
    expect(pruneCheckpoints(list).drop).toEqual([]);
  });

  it('handles a daily window spanning month and year edges', () => {
    const list = daily(20, 2026, 1, 3); // Dec 15 2025 .. Jan 3 2026
    const { keep } = pruneCheckpoints(list);
    expect(keep.slice(0, 14).map((c) => new Date(c.checkpointAt).toDateString())).toEqual(
      daily(14, 2026, 1, 3).map((c) => new Date(c.checkpointAt).toDateString()),
    );
    // Dec 15-20 2025: Mon 15 .. Sat 20 is one week, so one weekly checkpoint (Sat 20).
    expect(keep.slice(14).map((c) => new Date(c.checkpointAt).toDateString())).toEqual([
      'Sat Dec 20 2025',
    ]);
  });

  it('accepts unsorted input', () => {
    const list = daily(16, 2026, 11, 5).reverse();
    expect(pruneCheckpoints(list).keep[0]!.checkpointAt).toBe(at(2026, 11, 5));
  });
});

describe('dailyCheckpointDue', () => {
  it('is due with no checkpoint today', () => {
    expect(dailyCheckpointDue([], at(2026, 11, 5))).toBe(true);
    expect(dailyCheckpointDue([cp(at(2026, 11, 4, 23))], at(2026, 11, 5, 0))).toBe(true);
  });

  it('is not due after one today; a pre-drastic one does not count', () => {
    expect(dailyCheckpointDue([cp(at(2026, 11, 5, 1))], at(2026, 11, 5, 23))).toBe(false);
    expect(dailyCheckpointDue([cp(at(2026, 11, 5, 1), true)], at(2026, 11, 5, 23))).toBe(true);
  });
});

describe('isDrasticDrop', () => {
  const four = ['a', 'b', 'c', 'd'].map((id) => swin(id));
  it('is drastic when more than half of the open windows go', () => {
    expect(isDrasticDrop(four, four.slice(0, 1))).toBe(true);
    expect(isDrasticDrop(four, [])).toBe(true);
  });

  it('is not drastic at half or less', () => {
    expect(isDrasticDrop(four, four.slice(0, 2))).toBe(false);
    expect(isDrasticDrop(four, four)).toBe(false);
  });

  it('counts a window moved to the trash as dropped', () => {
    const next = four.map((w, i) => (i < 3 ? { ...w, state: 'trashed' as const } : w));
    expect(isDrasticDrop(four, next)).toBe(true);
  });

  it('ignores windows that were already trashed, and needs at least two gone', () => {
    const prev = [swin('a'), swin('t1', { state: 'trashed' }), swin('t2', { state: 'trashed' })];
    expect(isDrasticDrop(prev, [])).toBe(false);
    expect(isDrasticDrop([swin('a'), swin('b')], [])).toBe(true);
    expect(isDrasticDrop([swin('a')], [])).toBe(false);
  });

  it('does not count new windows as making up for dropped ones', () => {
    expect(isDrasticDrop(four, [swin('x'), swin('y'), swin('z'), swin('a')])).toBe(true);
  });
});
