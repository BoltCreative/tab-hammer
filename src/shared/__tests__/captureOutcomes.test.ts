import { describe, expect, it } from 'vitest';
import { describeNoPreview, withOutcome } from '../captureOutcomes';

describe('withOutcome', () => {
  it('replaces a window’s entry and keeps only the newest windows', () => {
    let map = {};
    for (let w = 1; w <= 4; w++) map = withOutcome(map, w, { at: w, outcome: 'saved' }, 3);
    map = withOutcome(map, 2, { at: 10, outcome: 'skipped:minimized' }, 3);
    expect(map).toEqual({
      2: { at: 10, outcome: 'skipped:minimized' },
      4: { at: 4, outcome: 'saved' },
      3: { at: 3, outcome: 'saved' },
    });
  });
});

describe('describeNoPreview', () => {
  it.each([
    [undefined, 'No preview yet · no capture attempted in this window'],
    ['saved', 'No preview yet · last capture: saved'],
    [
      'skipped:changed-during-capture',
      'No preview yet · last capture: skipped (changed during capture)',
    ],
    [
      'error:capture: Tabs cannot be edited',
      'No preview yet · last capture: failed (capture: Tabs cannot be edited)',
    ],
  ] as const)('%s', (outcome, text) => {
    expect(describeNoPreview(outcome && { at: 0, outcome })).toBe(text);
  });
});
