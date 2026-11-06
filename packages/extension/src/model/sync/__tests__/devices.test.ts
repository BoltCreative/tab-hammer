import { describe, expect, it } from 'vitest';
import {
  assembleDevices,
  sessionIdOfRow,
  sessionWindows,
  type ComputerEntry,
  type SessionDeviceLike,
} from '../devices';

const computer = (installId: string, name: string, updatedAt: number): ComputerEntry => ({
  installId,
  name,
  updatedAt,
  windowCount: 1,
  tabCount: 1,
});

const device = (deviceName: string, lastModified: number, urls = ['https://a.test/']) =>
  ({
    deviceName,
    sessions: [
      {
        lastModified,
        window: {
          sessionId: `${deviceName}-w`,
          tabs: urls.map((url, i) => ({ sessionId: `${deviceName}-t${i}`, url, title: `T${i}` })),
        },
      },
    ],
  }) satisfies SessionDeviceLike;

describe('assembleDevices', () => {
  it('sorts Tab Hammer computers and Chrome Sync devices newest first', () => {
    const r = assembleDevices(
      'Desk',
      [computer('a', 'Old', 1), computer('b', 'New', 5)],
      [device('iPad', 1), device('iPhone', 9)],
    );
    expect(r.computers.map((c) => c.name)).toEqual(['New', 'Old']);
    expect(r.devices.map((d) => [d.name, d.updatedAt])).toEqual([
      ['iPhone', 9000],
      ['iPad', 1000],
    ]);
  });

  it('prefers the Tab Hammer computer over a same-named Chrome Sync device', () => {
    const r = assembleDevices(
      'Desk',
      [computer('a', "Dave's MacBook", 1)],
      [device("dave's macbook ", 1), device('iPhone', 1)],
    );
    expect(r.devices.map((d) => d.name)).toEqual(['iPhone']);
  });

  it('leaves out a Chrome Sync device named like this computer', () => {
    const r = assembleDevices('Desk', [], [device('desk', 1)]);
    expect(r.devices).toEqual([]);
  });

  it('counts windows and tabs', () => {
    const r = assembleDevices(
      'Desk',
      [],
      [device('iPhone', 1, ['https://a.test/', 'https://b.test/'])],
    );
    expect(r.devices[0]).toMatchObject({ windowCount: 1, tabCount: 2 });
  });
});

describe('sessionWindows', () => {
  it('turns sessions into live windows with session row IDs', () => {
    const [w] = sessionWindows(device('iPhone', 3, ['https://a.test/']));
    expect(w).toMatchObject({
      id: 'session:iPhone-w',
      state: 'live',
      lastLiveAt: 3000,
      groups: [],
    });
    expect(w!.tabs).toEqual([
      { id: 'session:iPhone-t0', url: 'https://a.test/', title: 'T0', modifiedAt: 3000 },
    ]);
    expect(sessionIdOfRow(w!.id)).toBe('iPhone-w');
    expect(sessionIdOfRow('plain-id')).toBeUndefined();
  });

  it('makes a lone tab session its own window, skips empty ones and tabs without URLs', () => {
    const ws = sessionWindows({
      deviceName: 'x',
      sessions: [
        { lastModified: 1, tab: { sessionId: 's1', url: 'https://t.test/' } },
        { lastModified: 1, window: { sessionId: 's2', tabs: [{ sessionId: 's3' }] } },
        { lastModified: 1 },
      ],
    });
    expect(ws.map((w) => w.tabs.map((t) => t.title))).toEqual([['https://t.test/']]);
  });
});
