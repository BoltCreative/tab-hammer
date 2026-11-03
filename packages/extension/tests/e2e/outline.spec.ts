import type { Worker } from '@playwright/test';
import type { WindowRec } from '../../src/model/outline/types';
import { expect, readOutline, test } from './fixtures';

const page = (title: string) => `data:text/html,<title>${title}</title>`;

/** Window A: [Alpha, Bravo] grouped 'Research', then Charlie. Returns A's Chrome window ID. */
function buildWindowA(sw: Worker): Promise<number> {
  return sw.evaluate(
    async (urls) => {
      const a = await chrome.windows.create({ url: urls });
      const tabs = await chrome.tabs.query({ windowId: a!.id });
      const groupId = await chrome.tabs.group({
        tabIds: [tabs[0]!.id!, tabs[1]!.id!],
        createProperties: { windowId: a!.id },
      });
      await chrome.tabGroups.update(groupId, { title: 'Research', color: 'red' });
      return a!.id!;
    },
    [page('Alpha'), page('Bravo'), page('Charlie')],
  );
}

async function liveRecord(sw: Worker, chromeWindowId: number): Promise<WindowRec | undefined> {
  const { windows } = await readOutline(sw);
  return windows.find((w) => w.state === 'live' && w.chromeWindowId === chromeWindowId);
}

async function recordById(sw: Worker, id: string): Promise<WindowRec | undefined> {
  return (await readOutline(sw)).windows.find((w) => w.id === id);
}

const isUuidLike = (id: string) => typeof id === 'string' && !/^\d+$/.test(id) && id.length > 0;

test('the worker mirrors Chrome: windows, tabs in order, and groups get Tab Hammer IDs', async ({
  sw,
}) => {
  const a = await buildWindowA(sw);
  await expect
    .poll(async () => {
      const rec = await liveRecord(sw, a);
      if (!rec) return null;
      const [alpha, bravo, charlie] = rec.tabs;
      const group = rec.groups.find((g) => g.id === alpha?.groupId);
      return {
        titles: rec.tabs.map((t) => t.title),
        sameGroup: alpha?.groupId !== undefined && alpha.groupId === bravo?.groupId,
        charlieUngrouped: charlie?.groupId === undefined,
        groupTitle: group?.title,
        stringIds: [rec.id, ...rec.tabs.map((t) => t.id), ...rec.groups.map((g) => g.id)].every(
          isUuidLike,
        ),
      };
    })
    .toEqual({
      titles: ['Alpha', 'Bravo', 'Charlie'],
      sameGroup: true,
      charlieUngrouped: true,
      groupTitle: 'Research',
      stringIds: true,
    });
});

test('closing a window in Chrome moves it to the trash with all its tabs', async ({ sw }) => {
  const a = await buildWindowA(sw);
  await expect.poll(async () => (await liveRecord(sw, a))?.tabs.length).toBe(3);
  const id = (await liveRecord(sw, a))!.id;

  await sw.evaluate((windowId) => chrome.windows.remove(windowId), a);

  await expect
    .poll(async () => {
      const rec = await recordById(sw, id);
      return rec && { state: rec.state, tabs: rec.tabs.length, closed: rec.closedAt !== undefined };
    })
    .toEqual({ state: 'trashed', tabs: 3, closed: true });
});

test('a window opened with the same tabs as a trash entry is re-linked to it', async ({ sw }) => {
  const urls = [page('One'), page('Two')];
  const first = await sw.evaluate(
    async (u) => (await chrome.windows.create({ url: u }))!.id!,
    urls,
  );
  await expect.poll(async () => (await liveRecord(sw, first))?.tabs.length).toBe(2);
  const id = (await liveRecord(sw, first))!.id;
  await sw.evaluate((windowId) => chrome.windows.remove(windowId), first);
  await expect.poll(async () => (await recordById(sw, id))?.state).toBe('trashed');

  const second = await sw.evaluate(
    async (u) => (await chrome.windows.create({ url: u }))!.id!,
    urls,
  );

  // The new window settles (1.5s of quiet), then matches the trash entry.
  await expect
    .poll(async () => {
      const { windows } = await readOutline(sw);
      const rec = windows.find((w) => w.id === id);
      return {
        state: rec?.state,
        chromeWindowId: rec?.chromeWindowId,
        holders: windows.filter((w) => w.chromeWindowId === second).length,
      };
    })
    .toEqual({ state: 'live', chromeWindowId: second, holders: 1 });
});
