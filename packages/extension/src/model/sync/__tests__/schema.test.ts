import { describe, expect, it } from 'vitest';
import { validateSyncFile } from '../schema';
import { sfile, sgroup, stab, swin } from './files';

const good = () =>
  sfile([
    swin('w1', {
      name: 'Work',
      groups: [sgroup('g1', { color: 'red' })],
      tabs: [stab('t1', { groupId: 'g1' }), stab('t2')],
    }),
    swin('w2', { state: 'trashed', closedAt: 5 }),
  ]);

/** A copy of the good file with `edit` applied to its JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form edits of parsed JSON
function bad(edit: (f: any) => void) {
  const f = JSON.parse(JSON.stringify(good()));
  edit(f);
  return validateSyncFile(f);
}

describe('validateSyncFile', () => {
  it('accepts a good file and returns an equal copy', () => {
    const r = validateSyncFile(good());
    expect(r).toEqual({ ok: true, file: good() });
  });

  it('keeps checkpointAt and drops fields it does not know', () => {
    const r = validateSyncFile({ ...good(), checkpointAt: 7, extra: 1 });
    expect(r.ok && r.file.checkpointAt).toBe(7);
    expect(r.ok && 'extra' in r.file).toBe(false);
  });

  it('drops unknown fields on windows and tabs', () => {
    const f = JSON.parse(JSON.stringify(good()));
    f.windows[0].chromeWindowId = 4;
    f.windows[0].tabs[0].chromeTabId = 9;
    const r = validateSyncFile(f);
    expect(r.ok && r.file).toEqual(good());
  });

  it('reports a newer schema version as newer, whatever else is in it', () => {
    expect(validateSyncFile({ schemaVersion: 2 })).toMatchObject({ ok: false, problem: 'newer' });
  });

  it.each([
    ['not an object', () => validateSyncFile('x')],
    ['an array', () => validateSyncFile([])],
    ['no version', () => bad((f) => delete f.schemaVersion)],
    ['version 0', () => bad((f) => (f.schemaVersion = 0))],
    ['fractional version', () => bad((f) => (f.schemaVersion = 1.5))],
    ['empty installId', () => bad((f) => (f.installId = ''))],
    ['updatedAt a string', () => bad((f) => (f.updatedAt = '1'))],
    ['updatedAt NaN', () => bad((f) => (f.updatedAt = NaN))],
    ['windows not an array', () => bad((f) => (f.windows = {}))],
    ['unknown window state', () => bad((f) => (f.windows[0].state = 'crashed'))],
    ['window without tabs array', () => bad((f) => delete f.windows[0].tabs)],
    ['tab url missing', () => bad((f) => delete f.windows[0].tabs[1].url)],
    ['tab in a group its window lacks', () => bad((f) => (f.windows[0].tabs[1].groupId = 'nope'))],
    ['unknown group color', () => bad((f) => (f.windows[0].groups[0].color = 'black'))],
    ['collapsed not boolean', () => bad((f) => (f.windows[0].groups[0].collapsed = 'no'))],
    ['name a number', () => bad((f) => (f.windows[0].name = 3))],
    ['duplicate window IDs', () => bad((f) => (f.windows[1].id = 'w1'))],
    ['a tab ID reused in another window', () => bad((f) => (f.windows[1].tabs[0].id = 't1'))],
  ])('rejects %s as malformed', (_name, run) => {
    expect(run()).toMatchObject({ ok: false, problem: 'malformed' });
  });
});
