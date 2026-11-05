import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { sfile, swin } from '../../../model/sync/__tests__/files';
import { createSyncStore } from '../syncStore';

function fakeArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key: string) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items: Record<string, unknown>) => void Object.assign(data, structuredClone(items)),
  } as unknown as Pick<chrome.storage.StorageArea, 'get' | 'set'>;
}

describe('sync store', () => {
  it('merges flags and round-trips files, computers, and checkpoints', async () => {
    const store = createSyncStore(fakeArea());
    await store.setFlags({ dirty: true });
    await store.setFlags({ computerName: 'Desk' });
    expect(await store.flags()).toEqual({ dirty: true, computerName: 'Desk' });

    const file = sfile([swin('w')]);
    await store.setLastPushed(file);
    expect(await store.lastPushed()).toEqual(file);

    await store.putComputer({ name: 'outline-x.json', installId: 'x', modifiedTime: 3, file });
    await store.putComputer({
      name: 'outline-y.json',
      installId: 'y',
      modifiedTime: 4,
      problem: 'newer',
    });
    await store.deleteComputer('outline-y.json');
    expect((await store.computers()).map((c) => c.installId)).toEqual(['x']);

    await store.putCheckpoint({ id: 'c1', checkpointAt: 1, drastic: false, file });
    await store.putCheckpoint({ id: 'c2', checkpointAt: 2, drastic: true, file });
    await store.deleteCheckpoint('c1');
    expect((await store.checkpoints()).map((c) => [c.id, c.drastic])).toEqual([['c2', true]]);
  });
});
