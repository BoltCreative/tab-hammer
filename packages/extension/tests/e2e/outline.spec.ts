import type { Page, Worker } from '@playwright/test';
import type { WindowRec } from '../../src/model/outline/types';
import { expect, outlineCommand, readOutline, test } from './fixtures';

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

/** Chrome's normal windows other than `except`, each as its tabs' titles and group titles. */
function chromeWindows(sw: Worker, except: number[] = []) {
  return sw.evaluate(async (skip) => {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
    const groups = await chrome.tabGroups.query({});
    const groupTitle = new Map(groups.map((g) => [g.id, g.title ?? '']));
    return windows
      .filter((w) => !skip.includes(w.id!))
      .map((w) => ({
        id: w.id!,
        tabs: (w.tabs ?? []).map((t) => ({
          title: t.title,
          group: t.groupId === -1 ? null : (groupTitle.get(t.groupId) ?? null),
        })),
      }));
  }, except);
}

/** Opens window A and waits for its record. Returns the Chrome window ID and the record. */
async function windowARecord(sw: Worker): Promise<{ a: number; rec: WindowRec }> {
  const a = await buildWindowA(sw);
  await expect
    .poll(async () => {
      const rec = await liveRecord(sw, a);
      return rec?.tabs.map((t) => t.title).join(',') + `|${rec?.groups[0]?.title}`;
    })
    .toBe('Alpha,Bravo,Charlie|Research');
  return { a, rec: (await liveRecord(sw, a))! };
}

test('hibernating a window closes it and keeps its rows; opening it restores order and groups', async ({
  sw,
}) => {
  const others = (await chromeWindows(sw)).map((w) => w.id);
  const { a, rec } = await windowARecord(sw);
  const tabIds = rec.tabs.map((t) => t.id);

  await outlineCommand(sw, { cmd: 'hibernate', ids: [rec.id] });

  expect((await chromeWindows(sw)).some((w) => w.id === a)).toBe(false);
  const hibernated = await recordById(sw, rec.id);
  expect({
    state: hibernated?.state,
    tabIds: hibernated?.tabs.map((t) => t.id),
    chromeTabIds: hibernated?.tabs.filter((t) => t.chromeTabId !== undefined).length,
  }).toEqual({ state: 'hibernated', tabIds, chromeTabIds: 0 });

  await outlineCommand(sw, { cmd: 'open', id: rec.id });

  await expect
    .poll(async () => (await chromeWindows(sw, others)).map((w) => w.tabs))
    .toEqual([
      [
        { title: 'Alpha', group: 'Research' },
        { title: 'Bravo', group: 'Research' },
        { title: 'Charlie', group: null },
      ],
    ]);
  const [reopened] = await chromeWindows(sw, others);
  await expect
    .poll(async () => {
      const r = await recordById(sw, rec.id);
      return {
        state: r?.state,
        chromeWindowId: r?.chromeWindowId,
        tabIds: r?.tabs.map((t) => t.id),
        live: r?.tabs.every((t) => t.chromeTabId !== undefined),
        holders: (await readOutline(sw)).windows.filter((w) => w.chromeWindowId === reopened!.id)
          .length,
      };
    })
    .toEqual({ state: 'live', chromeWindowId: reopened!.id, tabIds, live: true, holders: 1 });
});

test('hibernating one tab keeps its row in place; opening it puts it back at its position', async ({
  sw,
}) => {
  const { a, rec } = await windowARecord(sw);
  const bravo = rec.tabs[1]!;

  await outlineCommand(sw, { cmd: 'hibernate', ids: [bravo.id] });

  const windowTitles = async () =>
    (await chromeWindows(sw)).find((w) => w.id === a)?.tabs.map((t) => t.title);
  expect(await windowTitles()).toEqual(['Alpha', 'Charlie']);
  const after = await recordById(sw, rec.id);
  expect({
    state: after?.state,
    tabs: after?.tabs.map((t) => [t.title, t.chromeTabId !== undefined]),
  }).toEqual({
    state: 'live',
    tabs: [
      ['Alpha', true],
      ['Bravo', false],
      ['Charlie', true],
    ],
  });

  await outlineCommand(sw, { cmd: 'open', id: bravo.id });

  await expect
    .poll(async () => (await chromeWindows(sw)).find((w) => w.id === a)?.tabs)
    .toEqual([
      { title: 'Alpha', group: 'Research' },
      { title: 'Bravo', group: 'Research' },
      { title: 'Charlie', group: null },
    ]);
  await expect
    .poll(async () => {
      const r = await recordById(sw, rec.id);
      return r?.tabs.map((t) => [t.id, t.chromeTabId !== undefined]);
    })
    .toEqual(rec.tabs.map((t) => [t.id, true]));
});

test('rename and delete forever', async ({ sw }) => {
  const { rec } = await windowARecord(sw);

  await outlineCommand(sw, { cmd: 'rename', windowId: rec.id, name: '  Reading list ' });
  expect((await recordById(sw, rec.id))?.name).toBe('Reading list');

  await outlineCommand(sw, { cmd: 'trash', ids: [rec.id] });
  expect((await recordById(sw, rec.id))?.state).toBe('trashed');

  await outlineCommand(sw, { cmd: 'deleteForever', windowId: rec.id });
  expect(await recordById(sw, rec.id)).toBeUndefined();
});

/** An outline row by its Tab Hammer record ID (works for hibernated rows, which have no Chrome ID). */
function recordRow(view: Page, kind: 't' | 'w', id: string) {
  return view.locator(`[data-key="${kind}:${id}"]`);
}

/** Hovers a row and clicks one of its toolbar buttons. */
async function toolbar(row: ReturnType<typeof recordRow>, label: string) {
  await row.hover();
  await row.getByRole('button', { name: label, exact: true }).click();
}

const titlesOf = (w: { tabs: { title?: string }[] } | undefined) => w?.tabs.map((t) => t.title);

test('hover toolbar hibernates a window; it stays dimmed; double-click reopens it', async ({
  sw,
  view,
}) => {
  const others = (await chromeWindows(sw)).map((w) => w.id);
  const { a, rec } = await windowARecord(sw);
  const header = recordRow(view, 'w', rec.id);
  const rows = [header, ...rec.tabs.map((t) => recordRow(view, 't', t.id))];

  await toolbar(header, 'Hibernate');

  await expect.poll(async () => (await chromeWindows(sw)).some((w) => w.id === a)).toBe(false);
  for (const row of rows) await expect(row).toHaveClass(/\bhibernated\b/);
  await header.hover();
  await expect(header.getByRole('button', { name: 'Hibernate', exact: true })).toHaveCount(0);

  await header.dblclick();

  await expect
    .poll(async () => (await chromeWindows(sw, others)).map(titlesOf))
    .toEqual([['Alpha', 'Bravo', 'Charlie']]);
  for (const row of rows) await expect(row).not.toHaveClass(/\bhibernated\b/);
});

test('hibernate one tab, open just it, then open the rest of its window', async ({ sw, view }) => {
  const others = (await chromeWindows(sw)).map((w) => w.id);
  const a = await sw.evaluate(
    async (urls) => (await chrome.windows.create({ url: urls }))!.id!,
    [page('A'), page('B'), page('C')],
  );
  await expect.poll(async () => titlesOf(await liveRecord(sw, a))).toEqual(['A', 'B', 'C']);
  const rec = (await liveRecord(sw, a))!;
  const header = recordRow(view, 'w', rec.id);
  const [rowA, rowB, rowC] = rec.tabs.map((t) => recordRow(view, 't', t.id)) as [
    ReturnType<typeof recordRow>,
    ReturnType<typeof recordRow>,
    ReturnType<typeof recordRow>,
  ];

  await toolbar(rowB, 'Hibernate');
  await expect(rowB).toHaveClass(/\bhibernated\b/);
  await expect
    .poll(async () => titlesOf((await chromeWindows(sw)).find((w) => w.id === a)))
    .toEqual(['A', 'C']);

  await toolbar(header, 'Hibernate');
  for (const row of [header, rowA, rowB, rowC]) await expect(row).toHaveClass(/\bhibernated\b/);

  await rowB.dblclick();
  await expect.poll(async () => (await chromeWindows(sw, others)).map(titlesOf)).toEqual([['B']]);
  await expect(rowB).not.toHaveClass(/\bhibernated\b/);
  // A and C stay dimmed rows of the same window.
  const card = header.locator('..');
  await expect(card.locator('[data-kind="tab"] .title')).toHaveText(['A', 'B', 'C']);
  await expect(rowA).toHaveClass(/\bhibernated\b/);
  await expect(rowC).toHaveClass(/\bhibernated\b/);

  await header.dblclick();
  await expect
    .poll(async () => (await chromeWindows(sw, others)).map(titlesOf))
    .toEqual([['A', 'B', 'C']]);
});

test('rename field: Enter saves, Escape cancels, empty clears to Window N', async ({
  sw,
  view,
}) => {
  const { rec } = await windowARecord(sw);
  const header = recordRow(view, 'w', rec.id);
  const label = header.locator('.title');
  const field = header.getByRole('textbox');
  await expect(label).toHaveText(/^Window \d+$/);
  const defaultLabel = await label.textContent();

  await toolbar(header, 'Rename window');
  await expect(field).toBeFocused();
  await field.fill('Reading');
  await field.press('Enter');
  await expect(label).toHaveText('Reading');
  await expect.poll(async () => (await recordById(sw, rec.id))?.name).toBe('Reading');

  await toolbar(header, 'Rename window');
  await expect(field).toHaveValue('Reading');
  await field.fill('Other');
  await field.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(label).toHaveText('Reading');

  await toolbar(header, 'Rename window');
  await field.fill('');
  await field.press('Enter');
  await expect(label).toHaveText(defaultLabel!);
  await expect.poll(async () => (await recordById(sw, rec.id))?.name).toBeUndefined();
});

test('rename field keystrokes stay in the field', async ({ sw, view }) => {
  const { a, rec } = await windowARecord(sw);
  const header = recordRow(view, 'w', rec.id);
  await recordRow(view, 't', rec.tabs[2]!.id).click();

  await toolbar(header, 'Rename window');
  await expect(header.getByRole('textbox')).toBeFocused();
  await view.keyboard.type('ab');
  for (const key of ['Backspace', 'Delete', 'Enter']) await view.keyboard.press(key);

  await expect(header.locator('.title')).toHaveText('a');
  await expect.poll(async () => (await recordById(sw, rec.id))?.name).toBe('a');
  expect(titlesOf((await chromeWindows(sw)).find((w) => w.id === a))).toEqual([
    'Alpha',
    'Bravo',
    'Charlie',
  ]);
});

test('Delete trashes the selected tabs', async ({ sw, view }) => {
  const { a, rec } = await windowARecord(sw);
  const [alpha, , charlie] = rec.tabs;
  await recordRow(view, 't', alpha!.id).click();
  await recordRow(view, 't', charlie!.id).click({ modifiers: ['ControlOrMeta'] });

  await view.keyboard.press('Delete');

  await expect
    .poll(async () => titlesOf((await chromeWindows(sw)).find((w) => w.id === a)))
    .toEqual(['Bravo']);
  await expect.poll(async () => titlesOf(await recordById(sw, rec.id))).toEqual(['Bravo']);
  await expect(recordRow(view, 't', alpha!.id)).toHaveCount(0);
});
