import type { Locator, Page, Worker } from '@playwright/test';
import type { WindowRec } from '../../src/model/outline/types';
import { expect, liveRow, outlineCommand, readOutline, test } from './fixtures';

// Window A: [Research: Alpha, Bravo] Charlie ; Window B: Delta
async function buildLayout(sw: Worker) {
  return sw.evaluate(async () => {
    const a = await chrome.windows.create({
      url: [
        'data:text/html,<title>Alpha</title>',
        'data:text/html,<title>Bravo</title>',
        'data:text/html,<title>Charlie</title>',
      ],
    });
    const b = await chrome.windows.create({ url: 'data:text/html,<title>Delta</title>' });
    const aTabs = await chrome.tabs.query({ windowId: a!.id });
    const groupId = await chrome.tabs.group({
      tabIds: [aTabs[0]!.id!, aTabs[1]!.id!],
      createProperties: { windowId: a!.id },
    });
    await chrome.tabGroups.update(groupId, { title: 'Research', color: 'red' });
    const [delta] = await chrome.tabs.query({ windowId: b!.id });
    return {
      winA: a!.id!,
      winB: b!.id!,
      groupId,
      alpha: aTabs[0]!.id!,
      bravo: aTabs[1]!.id!,
      charlie: aTabs[2]!.id!,
      delta: delta!.id!,
    };
  });
}

// A window's tabs in Chrome's order, as "Title" or "Title@GroupTitle".
function strip(sw: Worker, windowId: number) {
  return sw.evaluate(async (id) => {
    const tabs = await chrome.tabs.query({ windowId: id });
    const out: string[] = [];
    for (const t of tabs) {
      const title = t.title ?? '';
      if (t.groupId === -1) out.push(title);
      else out.push(`${title}@${(await chrome.tabGroups.get(t.groupId)).title}`);
    }
    return out;
  }, windowId);
}

// A point a quarter of the way into the row from its top or bottom edge: drops before or after it.
async function edge(row: Locator, side: 'top' | 'bottom') {
  const box = await row.boundingBox();
  if (!box) throw new Error('row not visible');
  return { x: box.width / 2, y: side === 'top' ? box.height / 4 : (box.height * 3) / 4 };
}

/** An outline row by its Tab Hammer record ID (works for hibernated rows, which have no Chrome ID). */
function recordRow(view: Page, kind: 't' | 'g' | 'w', id: string) {
  return view.locator(`[data-key="${kind}:${id}"]`);
}

/** The live record of a Chrome window, once the worker has it with `tabs` tabs. */
async function liveRecord(sw: Worker, chromeWindowId: number, tabs: number): Promise<WindowRec> {
  let rec: WindowRec | undefined;
  await expect
    .poll(async () => {
      rec = (await readOutline(sw)).windows.find(
        (w) => w.state === 'live' && w.chromeWindowId === chromeWindowId,
      );
      return rec?.tabs.length;
    })
    .toBe(tabs);
  return rec!;
}

async function recordById(sw: Worker, id: string): Promise<WindowRec | undefined> {
  return (await readOutline(sw)).windows.find((w) => w.id === id);
}

// Window C: Echo, Foxtrot (hibernated), Golf.
async function buildWindowC(sw: Worker) {
  const winC = await sw.evaluate(async () => {
    const c = await chrome.windows.create({
      url: [
        'data:text/html,<title>Echo</title>',
        'data:text/html,<title>Foxtrot</title>',
        'data:text/html,<title>Golf</title>',
      ],
    });
    return c!.id!;
  });
  const before = await liveRecord(sw, winC, 3);
  await outlineCommand(sw, { cmd: 'hibernate', ids: [before.tabs[1]!.id] });
  const rec = (await recordById(sw, before.id))!;
  expect(rec.tabs.map((t) => [t.title, t.chromeTabId !== undefined])).toEqual([
    ['Echo', true],
    ['Foxtrot', false],
    ['Golf', true],
  ]);
  return { winC, rec };
}

test('dragging a multi-selection moves the tabs to another window, in outline order', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  await liveRow(view, 'tab', s.alpha).click();
  await liveRow(view, 'tab', s.charlie).click({ modifiers: ['ControlOrMeta'] });
  await liveRow(view, 'tab', s.charlie).dragTo(liveRow(view, 'tab', s.delta), {
    targetPosition: await edge(liveRow(view, 'tab', s.delta), 'bottom'),
  });
  await expect.poll(() => strip(sw, s.winB)).toEqual(['Delta', 'Alpha', 'Charlie']);
  await expect.poll(() => strip(sw, s.winA)).toEqual(['Bravo@Research']);
  // The outline follows Chrome.
  await expect(
    liveRow(view, 'window', s.winB).locator('..').locator('[data-kind="tab"] .title'),
  ).toHaveText(['Delta', 'Alpha', 'Charlie']);
});

test('dragging a group onto another window header moves the whole group there', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  await liveRow(view, 'group', s.groupId).dragTo(liveRow(view, 'window', s.winB));
  await expect.poll(() => strip(sw, s.winB)).toEqual(['Delta', 'Alpha@Research', 'Bravo@Research']);
  await expect.poll(() => strip(sw, s.winA)).toEqual(['Charlie']);
});

test('dragging a group later in its own window keeps it a group', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  await liveRow(view, 'group', s.groupId).dragTo(liveRow(view, 'tab', s.charlie), {
    targetPosition: await edge(liveRow(view, 'tab', s.charlie), 'bottom'),
  });
  await expect
    .poll(() => strip(sw, s.winA))
    .toEqual(['Charlie', 'Alpha@Research', 'Bravo@Research']);
});

test('dropping a tab between grouped tabs puts it in that group', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  await liveRow(view, 'tab', s.delta).dragTo(liveRow(view, 'tab', s.bravo), {
    targetPosition: await edge(liveRow(view, 'tab', s.bravo), 'top'),
  });
  await expect
    .poll(() => strip(sw, s.winA))
    .toEqual(['Alpha@Research', 'Delta@Research', 'Bravo@Research', 'Charlie']);
});

test("dropping tabs from two windows after a group's last tab adds them to its end", async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  await liveRow(view, 'tab', s.delta).click();
  await liveRow(view, 'tab', s.charlie).click({ modifiers: ['ControlOrMeta'] });
  await liveRow(view, 'tab', s.delta).dragTo(liveRow(view, 'tab', s.bravo), {
    targetPosition: await edge(liveRow(view, 'tab', s.bravo), 'bottom'),
  });
  await expect
    .poll(() => strip(sw, s.winA))
    .toEqual(['Alpha@Research', 'Bravo@Research', 'Charlie@Research', 'Delta@Research']);
});

test('dropping a grouped tab before the group header takes it out of the group', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  await liveRow(view, 'tab', s.bravo).dragTo(liveRow(view, 'group', s.groupId), {
    targetPosition: await edge(liveRow(view, 'group', s.groupId), 'top'),
  });
  await expect.poll(() => strip(sw, s.winA)).toEqual(['Bravo', 'Alpha@Research', 'Charlie']);
});

test('dragging a live tab into a hibernated window hibernates it there', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  const a = await liveRecord(sw, s.winA, 3);
  const b = await liveRecord(sw, s.winB, 1);
  const alpha = a.tabs[0]!;
  await outlineCommand(sw, { cmd: 'hibernate', ids: [b.id] });

  await liveRow(view, 'tab', s.alpha).dragTo(recordRow(view, 'w', b.id));

  await expect.poll(() => strip(sw, s.winA)).toEqual(['Bravo@Research', 'Charlie']);
  await expect
    .poll(async () => {
      const r = await recordById(sw, b.id);
      return { state: r?.state, tabs: r?.tabs.map((t) => [t.id, t.chromeTabId ?? null]) };
    })
    .toEqual({
      state: 'hibernated',
      tabs: [
        [b.tabs[0]!.id, null],
        [alpha.id, null],
      ],
    });
});

test('dragging a window row moves all its tabs into another window', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  const a = await liveRecord(sw, s.winA, 3);
  const { winC, rec: c } = await buildWindowC(sw);

  await liveRow(view, 'window', winC).dragTo(liveRow(view, 'window', s.winA));

  // Live tabs move in Chrome; the hibernated one keeps its place between them in the outline.
  await expect
    .poll(() => strip(sw, s.winA))
    .toEqual(['Alpha@Research', 'Bravo@Research', 'Charlie', 'Echo', 'Golf']);
  await expect
    .poll(async () => {
      const { windows } = await readOutline(sw);
      return {
        a: windows.find((w) => w.id === a.id)?.tabs.map((t) => t.id),
        cGone: !windows.some((w) => w.id === c.id),
        cWindowOpen: (await chromeWindowIds(sw)).includes(winC),
      };
    })
    .toEqual({ a: [...a.tabs, ...c.tabs].map((t) => t.id), cGone: true, cWindowOpen: false });
});

test('a mixed drop moves live tabs in Chrome and hibernated rows in the outline, in order', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  const a = await liveRecord(sw, s.winA, 3);
  const { rec: c } = await buildWindowC(sw);
  const [echo, foxtrot, golf] = c.tabs;

  // Foxtrot (hibernated) and Golf (live), dropped before Alpha: both join Research there.
  await recordRow(view, 't', foxtrot!.id).click();
  await recordRow(view, 't', golf!.id).click({ modifiers: ['ControlOrMeta'] });
  const alphaRow = liveRow(view, 'tab', s.alpha);
  await recordRow(view, 't', golf!.id).dragTo(alphaRow, {
    targetPosition: await edge(alphaRow, 'top'),
  });

  await expect
    .poll(() => strip(sw, s.winA))
    .toEqual(['Golf@Research', 'Alpha@Research', 'Bravo@Research', 'Charlie']);
  await expect
    .poll(async () => {
      const { windows } = await readOutline(sw);
      const recA = windows.find((w) => w.id === a.id)!;
      const research = recA.tabs.find((t) => t.id === a.tabs[0]!.id)?.groupId;
      return {
        a: recA.tabs.map((t) => [t.id, t.chromeTabId !== undefined, t.groupId === research]),
        c: windows.find((w) => w.id === c.id)?.tabs.map((t) => t.id),
      };
    })
    .toEqual({
      a: [
        [foxtrot!.id, false, true],
        [golf!.id, true, true],
        [a.tabs[0]!.id, true, true],
        [a.tabs[1]!.id, true, true],
        [a.tabs[2]!.id, true, false],
      ],
      c: [echo!.id],
    });
});

function chromeWindowIds(sw: Worker): Promise<number[]> {
  return sw.evaluate(async () => (await chrome.windows.getAll()).map((w) => w.id!));
}
