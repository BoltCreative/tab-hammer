import type { Worker } from '@playwright/test';
import { expect, liveRow, test } from './fixtures';

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

// Rows are 18px tall: drop near the top or bottom edge.
const TOP = { x: 40, y: 3 };
const BOTTOM = { x: 40, y: 15 };

test('dragging a multi-selection moves the tabs to another window, in outline order', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  await liveRow(view, 'tab', s.alpha).click();
  await liveRow(view, 'tab', s.charlie).click({ modifiers: ['ControlOrMeta'] });
  await liveRow(view, 'tab', s.charlie).dragTo(liveRow(view, 'tab', s.delta), {
    targetPosition: BOTTOM,
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
    targetPosition: BOTTOM,
  });
  await expect
    .poll(() => strip(sw, s.winA))
    .toEqual(['Charlie', 'Alpha@Research', 'Bravo@Research']);
});

test('dropping a tab between grouped tabs puts it in that group', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  await liveRow(view, 'tab', s.delta).dragTo(liveRow(view, 'tab', s.bravo), {
    targetPosition: TOP,
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
    targetPosition: BOTTOM,
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
    targetPosition: TOP,
  });
  await expect.poll(() => strip(sw, s.winA)).toEqual(['Bravo', 'Alpha@Research', 'Charlie']);
});
