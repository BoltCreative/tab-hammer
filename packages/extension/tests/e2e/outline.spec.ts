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

// A new window is matched only after its tabs have been quiet for 1.5s, once they've loaded:
// allow for that on top of the default poll timeout.
const MATCH_TIMEOUT = 10_000;

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
    .poll(
      async () => {
        const { windows } = await readOutline(sw);
        const rec = windows.find((w) => w.id === id);
        return {
          state: rec?.state,
          chromeWindowId: rec?.chromeWindowId,
          holders: windows.filter((w) => w.chromeWindowId === second).length,
        };
      },
      { timeout: MATCH_TIMEOUT },
    )
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

/**
 * How many window records the outline holds, and how many are in the trash. A window Tab Hammer
 * closes itself must not come back as a second record (a provisional one Chrome's removal trashes).
 */
async function recordCounts(sw: Worker): Promise<{ records: number; trashed: number }> {
  const { windows } = await readOutline(sw);
  return { records: windows.length, trashed: windows.filter((w) => w.state === 'trashed').length };
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
  const counts = await recordCounts(sw);

  await outlineCommand(sw, { cmd: 'hibernate', ids: [rec.id] });

  await expect.poll(async () => (await chromeWindows(sw)).some((w) => w.id === a)).toBe(false);
  expect(await recordCounts(sw)).toEqual({ records: counts.records, trashed: 0 });
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
  // By now Chrome has long reported the hibernated window removed.
  expect(await recordCounts(sw)).toEqual({ records: counts.records, trashed: 0 });
});

test('a hibernated window reopens at its last position and size', async ({ sw }) => {
  const { a, rec } = await windowARecord(sw);
  const target = { left: 70, top: 40, width: 640, height: 520 };
  await sw.evaluate(async ([id, b]) => void (await chrome.windows.update(id, b)), [
    a,
    target,
  ] as const);
  await expect
    .poll(async () => (await liveRecord(sw, a))?.bounds)
    .toEqual({ ...target, state: 'normal' });

  await outlineCommand(sw, { cmd: 'hibernate', ids: [rec.id] });
  await expect.poll(async () => (await chromeWindows(sw)).some((w) => w.id === a)).toBe(false);
  // Playwright resizes every page it attaches to to its default viewport, so the reopened
  // window's size is read from what Chrome created, before Playwright gets to it.
  await sw.evaluate(() => {
    const g = globalThis as unknown as { created?: chrome.windows.Window };
    const original = chrome.windows.create.bind(chrome.windows);
    chrome.windows.create = (async (d: chrome.windows.CreateData) => {
      chrome.windows.create = original;
      return (g.created = await original(d));
    }) as typeof chrome.windows.create;
  });
  await outlineCommand(sw, { cmd: 'open', id: rec.id });

  const created = await sw.evaluate(() => {
    const w = (globalThis as unknown as { created?: chrome.windows.Window }).created;
    return w && { left: w.left, top: w.top, width: w.width, height: w.height };
  });
  expect(created).toEqual(target);
  expect((await recordById(sw, rec.id))?.state).toBe('live');
});

for (const [how, closeCmd] of [
  ['deleted (Recently closed)', 'trash'],
  ['hibernated', 'hibernate'],
] as const) {
  test(`reopening a ${how} window opens the tabs that were live and keeps the hibernated ones as rows`, async ({
    sw,
  }) => {
    const others = (await chromeWindows(sw)).map((w) => w.id);
    const { a, rec } = await windowARecord(sw);
    const bravo = rec.tabs[1]!;
    await outlineCommand(sw, { cmd: 'hibernate', ids: [bravo.id] });
    await outlineCommand(sw, { cmd: closeCmd, ids: [rec.id] });
    await expect.poll(async () => (await chromeWindows(sw)).some((w) => w.id === a)).toBe(false);
    expect((await recordById(sw, rec.id))?.state).toBe(
      closeCmd === 'trash' ? 'trashed' : 'hibernated',
    );

    await outlineCommand(sw, { cmd: 'open', id: rec.id });

    await expect
      .poll(async () => (await chromeWindows(sw, others)).map((w) => w.tabs))
      .toEqual([
        [
          { title: 'Alpha', group: 'Research' },
          { title: 'Charlie', group: null },
        ],
      ]);
    await expect
      .poll(async () => {
        const r = await recordById(sw, rec.id);
        return {
          state: r?.state,
          tabs: r?.tabs.map((t) => [t.title, t.chromeTabId !== undefined]),
        };
      })
      .toEqual({
        state: 'live',
        tabs: [
          ['Alpha', true],
          ['Bravo', false],
          ['Charlie', true],
        ],
      });
  });
}

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
  const counts = await recordCounts(sw);

  await toolbar(header, 'Hibernate');

  await expect.poll(async () => (await chromeWindows(sw)).some((w) => w.id === a)).toBe(false);
  expect(await recordCounts(sw)).toEqual({ records: counts.records, trashed: 0 });
  for (const row of rows) await expect(row).toHaveClass(/\bhibernated\b/);
  await header.hover();
  await expect(header.getByRole('button', { name: 'Hibernate', exact: true })).toHaveCount(0);

  await header.dblclick();

  await expect
    .poll(async () => (await chromeWindows(sw, others)).map(titlesOf))
    .toEqual([['Alpha', 'Bravo', 'Charlie']]);
  for (const row of rows) await expect(row).not.toHaveClass(/\bhibernated\b/);
  expect(await recordCounts(sw)).toEqual({ records: counts.records, trashed: 0 });
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

/** Asserts which of `rows` are dimmed as hibernated. */
async function expectDimmed(rows: ReturnType<typeof recordRow>[], dimmed: boolean[]) {
  for (const [i, row] of rows.entries()) {
    if (dimmed[i]) await expect(row).toHaveClass(/\bhibernated\b/);
    else await expect(row).not.toHaveClass(/\bhibernated\b/);
  }
}

test('a renamed window, driven like the user does: hibernate, open one tab, hibernate it, open the rest, then all', async ({
  sw,
  view,
  pages,
}) => {
  const others = (await chromeWindows(sw)).map((w) => w.id);
  const names = ['P1', 'P2', 'P3', 'P4', 'P5'];
  const a = await sw.evaluate(
    async (urls) => (await chrome.windows.create({ url: urls }))!.id!,
    names.map((n) => pages.url(n)),
  );
  await expect.poll(async () => titlesOf(await liveRecord(sw, a))).toEqual(names);
  const rec = (await liveRecord(sw, a))!;
  const header = recordRow(view, 'w', rec.id);
  const tabRows = rec.tabs.map((t) => recordRow(view, 't', t.id));
  const rows = [header, ...tabRows];
  const p2 = tabRows[1]!;
  // Chrome's windows besides the ones open before the test, as tab titles.
  const opened = async () => (await chromeWindows(sw, others)).map(titlesOf);
  // The record: its state, and which tabs are open in Chrome (with their saved addresses).
  const record = async () => {
    const r = await recordById(sw, rec.id);
    const { windows } = await readOutline(sw);
    return {
      state: r?.state,
      name: r?.name,
      live: r?.tabs.map((t) => t.chromeTabId !== undefined),
      urls: r?.tabs.map((t) => t.url),
      records: windows.length,
    };
  };
  const urls = names.map((n) => pages.url(n));
  const records = (await readOutline(sw)).windows.length;
  const expected = (state: string, live: boolean[]) => ({
    state,
    name: 'Linkedin',
    live,
    urls,
    records,
  });
  const all = (v: boolean) => names.map(() => v);
  const onlyP2 = names.map((n) => n === 'P2');

  // 1. Rename the window, then hibernate it.
  await toolbar(header, 'Rename window');
  await header.getByRole('textbox').fill('Linkedin');
  await header.getByRole('textbox').press('Enter');
  await expect(header.locator('.title')).toHaveText('Linkedin');
  await toolbar(header, 'Hibernate');
  await expect.poll(opened).toEqual([]);
  await expect.poll(record).toEqual(expected('hibernated', all(false)));
  await expectDimmed(rows, [true, ...all(true)]);

  // 2. Double-click one tab: it opens alone in a new window, which is live.
  await p2.dblclick();
  await expect.poll(opened).toEqual([['P2']]);
  await expect.poll(record).toEqual(expected('live', onlyP2));
  await expectDimmed(rows, [false, ...names.map((n) => n !== 'P2')]);

  // 4. Hibernate that one tab: it was the window's last live tab, so the window hibernates.
  await toolbar(p2, 'Hibernate');
  await expect.poll(opened).toEqual([]);
  await expect.poll(record).toEqual(expected('hibernated', all(false)));
  await expectDimmed(rows, [true, ...all(true)]);
  await expect(view.locator('.card.focused')).toHaveCount(0);

  // 3. Open one tab again, then double-click the header: the rest open into its window, in order.
  await p2.dblclick();
  await expect.poll(opened).toEqual([['P2']]);
  await expect.poll(record).toEqual(expected('live', onlyP2));
  await header.dblclick();
  await expect.poll(opened).toEqual([names]);
  await expect.poll(record).toEqual(expected('live', all(true)));
  await expectDimmed(rows, [false, ...all(false)]);
  await expect(view.locator('.tab.discarded')).toHaveCount(0); // loaded, not left asleep

  // 5. Hibernate the window, then double-click the header: every tab opens, loaded, and is live.
  await toolbar(header, 'Hibernate');
  await expect.poll(opened).toEqual([]);
  await expect.poll(record).toEqual(expected('hibernated', all(false)));
  await expectDimmed(rows, [true, ...all(true)]);
  await header.dblclick();
  await expect.poll(opened).toEqual([names]);
  await expect.poll(record).toEqual(expected('live', all(true)));
  await expectDimmed(rows, [false, ...all(false)]);
  await expect(view.locator('.tab.discarded')).toHaveCount(0); // loaded, not left asleep
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

/** Closes a two-tab window [Echo, Foxtrot] and returns its record ID, once it is in the trash. */
async function closedEchoWindow(sw: Worker): Promise<string> {
  const w = await sw.evaluate(
    async (urls) => (await chrome.windows.create({ url: urls }))!.id!,
    [page('Echo'), page('Foxtrot')],
  );
  await expect.poll(async () => titlesOf(await liveRecord(sw, w))).toEqual(['Echo', 'Foxtrot']);
  const id = (await liveRecord(sw, w))!.id;
  await sw.evaluate((windowId) => chrome.windows.remove(windowId), w);
  await expect.poll(async () => (await recordById(sw, id))?.state).toBe('trashed');
  return id;
}

test('a closed window lands in Recently closed and Restore brings it back at the bottom', async ({
  sw,
  view,
}) => {
  const others = (await chromeWindows(sw)).map((w) => w.id);
  await closedEchoWindow(sw);

  const section = view.getByRole('button', { name: /^Recently closed \(1\)/ });
  await expect(view.getByTestId('trash-entry')).toHaveCount(0); // collapsed by default
  await section.click();
  const entry = view.getByTestId('trash-entry');
  await expect(entry).toContainText('Echo');
  await expect(entry).toContainText('2 tabs');
  // Trash rows are plain: no drag, not in the outline tree.
  await expect(entry).not.toHaveAttribute('draggable', 'true');
  await expect(entry).not.toHaveAttribute('role', 'treeitem');

  await entry.hover();
  await entry.getByRole('button', { name: 'Restore', exact: true }).click();

  await expect
    .poll(async () => (await chromeWindows(sw, others)).map(titlesOf))
    .toEqual([['Echo', 'Foxtrot']]);
  const lastCard = view.getByTestId('window-card').last();
  await expect(lastCard.locator('[data-kind="tab"] .title')).toHaveText(['Echo', 'Foxtrot']);
  await expect(section).toHaveCount(0);
});

test('Delete forever removes a trash entry', async ({ sw, view }) => {
  const id = await closedEchoWindow(sw);

  await view.getByRole('button', { name: /^Recently closed \(1\)/ }).click();
  const entry = view.getByTestId('trash-entry');
  await entry.hover();
  await entry.getByRole('button', { name: 'Delete forever', exact: true }).click();

  await expect.poll(async () => await recordById(sw, id)).toBeUndefined();
  await expect(view.getByTestId('trash-entry')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /^Recently closed/ })).toHaveCount(0);
});

test('a trash entry expands to its tabs, which are plain rows', async ({ sw, view }) => {
  await closedEchoWindow(sw);
  await view.getByRole('button', { name: /^Recently closed \(1\)/ }).click();
  const entry = view.getByTestId('trash-entry');

  await entry.getByRole('button', { name: 'Expand' }).click();
  await expect(view.locator('.trash-tab .title')).toHaveText(['Echo', 'Foxtrot']);
  await expect(view.locator('.trash-tab').first()).not.toHaveAttribute('role', 'treeitem');
  await expect(view.locator('.trash-tab .row-toolbar')).toHaveCount(0);
});

test('keys on the Recently closed header do not act on the outline selection', async ({
  sw,
  view,
}) => {
  const { a, rec } = await windowARecord(sw);
  await closedEchoWindow(sw);
  await recordRow(view, 't', rec.tabs[2]!.id).click();
  const header = view.getByRole('button', { name: /^Recently closed \(1\)/ });
  await header.focus();

  await view.keyboard.press('Delete');
  await header.press('Enter'); // toggles the section, nothing else
  await expect(view.getByTestId('trash-entry')).toHaveCount(1);

  expect(titlesOf(await recordById(sw, rec.id))).toEqual(['Alpha', 'Bravo', 'Charlie']);
  expect(titlesOf((await chromeWindows(sw)).find((w) => w.id === a))).toEqual([
    'Alpha',
    'Bravo',
    'Charlie',
  ]);
});

test("a trash entry's hover actions stay inside it, in place of its tab count", async ({
  sw,
  view,
}) => {
  for (let i = 0; i < 3; i++) await closedEchoWindow(sw);
  await view.getByRole('button', { name: /^Recently closed \(3\)/ }).click();
  const entries = view.getByTestId('trash-entry');
  await expect(entries).toHaveCount(3);

  const first = entries.nth(0);
  await first.hover();
  const restore = first.getByRole('button', { name: 'Restore', exact: true });
  await expect(restore).toBeVisible();
  // The actions sit inside the hovered row, and its tab count gives way to them.
  const rowBox = (await first.boundingBox())!;
  const barBox = (await first.locator('.row-toolbar').boundingBox())!;
  expect(barBox.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  await expect(first.getByText('2 tabs')).toBeHidden();

  // Every other row keeps its count in view, with nothing drawn over it.
  for (const i of [1, 2]) {
    const count = entries.nth(i).getByText('2 tabs');
    await expect(count).toBeVisible();
    const box = (await count.boundingBox())!;
    const onTop = await view.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.textContent?.trim(),
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(onTop).toBe('2 tabs');
    await expect(entries.nth(i).getByRole('button', { name: 'Restore', exact: true })).toBeHidden();
  }
});

test('Restore all on Recently closed brings every closed window back, hibernated, opening nothing', async ({
  sw,
  view,
}) => {
  const before = (await chromeWindows(sw)).map((w) => w.id);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(await closedEchoWindow(sw));
  const trash = view.getByRole('group', { name: 'Recently closed' });

  await trash.getByRole('button', { name: 'Restore all', exact: true }).click();

  await expect
    .poll(async () => Promise.all(ids.map(async (id) => (await recordById(sw, id))?.state)))
    .toEqual(['hibernated', 'hibernated', 'hibernated']);
  await expect(trash).toHaveCount(0);
  for (const id of ids)
    await expect(view.locator(`.window-header.hibernated[data-key="w:${id}"]`)).toBeVisible();
  expect((await chromeWindows(sw)).map((w) => w.id)).toEqual(before);
});
