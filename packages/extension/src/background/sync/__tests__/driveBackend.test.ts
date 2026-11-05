import { describe, expect, it } from 'vitest';
import { createFakeDrive } from '../../../../tests/fakeDrive';
import {
  AuthError,
  NotFoundError,
  parseCheckpointName,
  parseOutlineName,
  checkpointFileName,
} from '../backend';
import { createDriveBackend } from '../driveBackend';

function setup(opts: { pageSize?: number } = {}) {
  const drive = createFakeDrive(opts);
  let current = 'test-token';
  const dropped: string[] = [];
  const backend = createDriveBackend({
    fetch: drive.fetch,
    token: async () => current,
    dropToken: async (t) => {
      dropped.push(t);
      current = 'test-token'; // Chrome hands out a fresh, valid token next
    },
    apiBase: 'http://fake.drive',
  });
  return { drive, backend, dropped, expire: () => (current = 'stale') };
}

describe('Drive backend', () => {
  it('creates, lists, reads, updates, and removes files by name', async () => {
    const { drive, backend } = setup();
    const created = await backend.write('outline-a.json', '{"v":1}');
    expect(created.name).toBe('outline-a.json');
    expect(await backend.read('outline-a.json')).toBe('{"v":1}');
    const updated = await backend.write('outline-a.json', '{"v":2}');
    expect(updated.modifiedTime).toBeGreaterThan(created.modifiedTime);
    expect(await backend.read('outline-a.json')).toBe('{"v":2}');
    expect([...drive.byName().keys()]).toEqual(['outline-a.json']); // updated, not duplicated
    expect(await backend.list()).toEqual([
      { name: 'outline-a.json', modifiedTime: updated.modifiedTime },
    ]);
    await backend.remove('outline-a.json');
    expect(await backend.list()).toEqual([]);
    await backend.remove('outline-a.json'); // already gone: fine
  });

  it('finds a file another client wrote, by name', async () => {
    const { drive, backend } = setup();
    drive.put("outline-o'b.json", 'x');
    expect(await backend.read("outline-o'b.json")).toBe('x');
    await backend.write("outline-o'b.json", 'y');
    expect(drive.byName().get("outline-o'b.json")).toBe('y');
    expect(drive.byName().size).toBe(1);
  });

  it('pages through long listings', async () => {
    const { drive, backend } = setup({ pageSize: 2 });
    for (const n of ['a', 'b', 'c', 'd', 'e']) drive.put(`outline-${n}.json`, n);
    expect((await backend.list()).map((f) => f.name).sort()).toHaveLength(5);
  });

  it('reading a missing file is NotFound', async () => {
    const { backend } = setup();
    await expect(backend.read('outline-none.json')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('re-creates a file deleted elsewhere', async () => {
    const { drive, backend } = setup();
    await backend.write('outline-a.json', '1');
    // Another computer's Forget deletes it (through a second client).
    const other = createDriveBackend({
      fetch: drive.fetch,
      token: async () => 'test-token',
      dropToken: async () => undefined,
      apiBase: 'http://fake.drive',
    });
    await other.remove('outline-a.json');
    await backend.write('outline-a.json', '2');
    expect(drive.byName().get('outline-a.json')).toBe('2');
  });

  it('on a 401 drops the cached token and retries once', async () => {
    const { backend, dropped, expire } = setup();
    expire();
    expect(await backend.list()).toEqual([]);
    expect(dropped).toEqual(['stale']);
  });

  it('a second 401 is an AuthError', async () => {
    const drive = createFakeDrive();
    const backend = createDriveBackend({
      fetch: drive.fetch,
      token: async () => 'revoked',
      dropToken: async () => undefined,
      apiBase: 'http://fake.drive',
    });
    await expect(backend.list()).rejects.toBeInstanceOf(AuthError);
  });
});

describe('file names', () => {
  it('round-trips outline and checkpoint names', () => {
    const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
    expect(parseOutlineName(`outline-${id}.json`)).toBe(id);
    const at = Date.UTC(2026, 10, 5, 14, 3, 9, 42);
    const name = checkpointFileName(id, at);
    expect(parseCheckpointName(name)).toEqual({ installId: id, at });
    expect(parseOutlineName(name)).toBeUndefined();
    expect(parseCheckpointName(`outline-${id}.json`)).toBeUndefined();
  });
});
