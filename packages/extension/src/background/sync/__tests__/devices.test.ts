import { describe, expect, it } from 'vitest';
import { sessionWindows } from '../../../model/sync/devices';
import { createDeviceSource, type DeviceChrome, type OpenWindow } from '../devices';

const device = {
  deviceName: 'iPhone',
  sessions: [
    {
      lastModified: 10,
      window: {
        sessionId: 'w1',
        tabs: [
          { sessionId: 't1', url: 'https://a.test/', title: 'A' },
          { sessionId: 't2', url: 'https://b.test/', title: 'B' },
        ],
      },
    },
  ],
};
const [win] = sessionWindows(device);

function stub(restoreWorks: boolean) {
  const calls: string[] = [];
  const c = {
    sessions: {
      getDevices: async (filter?: chrome.sessions.Filter) => {
        calls.push(`getDevices ${filter?.maxResults}`);
        return [device];
      },
      restore: async (id?: string) => {
        calls.push(`restore ${id}`);
        if (!restoreWorks) throw new Error('No session');
        return { lastModified: 0, window: { id: 77 } };
      },
    },
    windows: {
      create: async (data?: chrome.windows.CreateData) => {
        calls.push(`windows.create ${JSON.stringify(data?.url)}`);
        return { id: 88 };
      },
    },
    tabs: {
      create: async (p: chrome.tabs.CreateProperties) => {
        calls.push(`tabs.create ${p.url}`);
        return {};
      },
    },
  } as unknown as DeviceChrome;
  const opened: (number | undefined)[] = [];
  const openWindow: OpenWindow = async (create) => {
    const w = await create();
    opened.push(w?.id);
    return w;
  };
  return { source: createDeviceSource(c, openWindow), calls, opened };
}

describe('device source', () => {
  it('reads every device, up to 25 sessions each', async () => {
    const { source, calls } = stub(true);
    expect(await source.read()).toEqual([device]);
    expect(calls).toEqual(['getDevices 25']);
  });

  it('restores a window through chrome.sessions, recording it as opened here', async () => {
    const { source, calls, opened } = stub(true);
    await source.openHere(win!, win!.id);
    expect(calls).toEqual(['restore w1']);
    expect(opened).toEqual([77]);
  });

  it('restores a tab through chrome.sessions', async () => {
    const { source, calls } = stub(true);
    await source.openHere(win!, win!.tabs[1]!.id);
    expect(calls).toEqual(['restore t2']);
  });

  it("opens the addresses when Chrome can't restore the session", async () => {
    const { source, calls, opened } = stub(false);
    await source.openHere(win!, win!.id);
    expect(calls).toEqual(['restore w1', 'windows.create ["https://a.test/","https://b.test/"]']);
    expect(opened).toEqual([88]);
    calls.length = 0;
    await source.openHere(win!, win!.tabs[0]!.id);
    expect(calls).toEqual(['restore t1', 'tabs.create https://a.test/']);
  });

  it('rejects a row that is not in the window', async () => {
    const { source } = stub(true);
    await expect(source.openHere(win!, 'nope')).rejects.toThrow();
  });
});
