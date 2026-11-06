import { describe, expect, it } from 'vitest';
import {
  describeNoPreview,
  friendlyCaptureOutcome,
  withOutcome,
  type CaptureOutcome,
} from '../captureOutcomes';

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

describe('friendlyCaptureOutcome', () => {
  it.each([
    // saved, but no image found for the current URL (rare: pruned or evicted meanwhile).
    ['saved', 'A preview was captured but isn’t available for this page'],

    // Every skip reason the code can record.
    ['skipped:no-permission', "Preview permissions haven't been granted yet"],
    ['skipped:incognito', 'Incognito tabs are never captured'],
    ['skipped:not-normal-window', "This kind of window can't be previewed"],
    ['skipped:minimized', 'Preview paused while the window is minimized'],
    ['skipped:own-window', "Tab Hammer doesn't preview its own window"],
    ['skipped:no-tab', "Couldn't find the tab to capture"],
    ['skipped:not-loaded-yet', 'Page had not finished loading yet'],
    ['skipped:not-capturable-url', 'Chrome doesn’t allow previews of this page'],
    ['skipped:changed-during-capture', 'Page changed while it was being captured'],
    ['skipped:discarded', 'Tab is asleep — Capture missing (in the ⋯ menu) wakes and captures it'],
    ['skipped:swap-pending', "Already refreshing this tab's preview"],
    ['skipped:superseded', 'Skipped to keep up with your cursor — hover again'],

    // An unrecognized skip reason falls back like an unrecognized error would.
    ['skipped:some-future-reason', "Couldn't capture a preview"],

    // Attach errors (on-demand capture of a background tab).
    [
      'error:attach: Cannot access a chrome-extension:// URL of different extension',
      "Another extension's content on this page blocks previews",
    ],
    [
      'error:attach: Another debugger is already attached to the tab with given id.',
      'DevTools or another tool is inspecting this tab',
    ],
    ['error:attach: gave up waiting', 'Page took too long to draw'],

    // CDP screenshot failures.
    ['error:capture: {"code":-32603,"message":"Internal error"}', "Chrome couldn't draw this page"],
    ['error:capture: timed out after 5000ms', 'Page took too long to draw'],
    ['error:capture: gave up waiting', 'Page took too long to draw'],
    ['error:capture failed', "Couldn't capture a preview"],

    // captureVisibleTab quota.
    [
      'error:capture: MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND',
      'Chrome is limiting captures right now — try again shortly',
    ],

    // Other pipeline stages and the queue's own timeout.
    ['error:downscale: out of memory', "Couldn't capture a preview"],
    ['error:save: the operation failed for reasons unknown.', "Couldn't capture a preview"],
    ['error:gave up after 20000ms', 'Page took too long to draw'],
    ['error:no reply from the service worker', 'Lost touch with the extension — try again'],

    // Wholly unknown error text still gets a safe, generic sentence.
    ['error:something nobody has seen before', "Couldn't capture a preview"],
  ] satisfies [CaptureOutcome, string][])('%s → %s', (outcome, text) => {
    expect(friendlyCaptureOutcome(outcome)).toBe(text);
  });
});

describe('describeNoPreview', () => {
  it('has no friendly text (and no detail) when no capture was ever attempted', () => {
    expect(describeNoPreview(undefined)).toEqual({ text: 'No preview yet' });
  });

  it('pairs the friendly text with the raw outcome, for a tooltip', () => {
    expect(
      describeNoPreview({ at: 0, outcome: 'error:capture: {"code":-32603,"message":"boom"}' }),
    ).toEqual({
      text: "Chrome couldn't draw this page",
      detail: 'error:capture: {"code":-32603,"message":"boom"}',
    });
  });
});
