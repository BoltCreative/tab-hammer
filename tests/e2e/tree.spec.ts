import { expect, test, VIEW_PATH } from './fixtures';

type Setup = { winA: number; winB: number; groupedTabIds: [number, number]; lonelyTabId: number };

// Build a known layout from inside the extension's service worker (it has the tabs/tabGroups APIs).
async function buildLayout(sw: import('@playwright/test').Worker): Promise<Setup> {
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
    const grouped: [number, number] = [aTabs[0]!.id!, aTabs[1]!.id!];
    const groupId = await chrome.tabs.group({
      tabIds: grouped,
      createProperties: { windowId: a!.id },
    });
    await chrome.tabGroups.update(groupId, { title: 'Research', color: 'red' });
    const bTabs = await chrome.tabs.query({ windowId: b!.id });
    return { winA: a!.id!, winB: b!.id!, groupedTabIds: grouped, lonelyTabId: bTabs[0]!.id! };
  });
}

test('opening twice focuses the existing Tab Hammer window instead of making another', async ({
  context,
  sw,
  view,
}) => {
  await sw.evaluate(() =>
    (
      globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }
    ).tabHammer.openOrFocus(),
  );
  const viewPages = context.pages().filter((p) => p.url().includes(VIEW_PATH));
  expect(viewPages).toHaveLength(1);
  expect(viewPages[0]).toBe(view);
});

test('renders window cards with a group row and indented tabs, excluding itself', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  const cardA = view.locator('section[data-testid="window-card"]', {
    has: view.locator(`[data-key="w:${s.winA}"]`),
  });
  await expect(cardA.locator('[data-kind="group"] .title')).toHaveText('Research');
  await expect(cardA.locator('.group-tabs [data-kind="tab"] .title')).toHaveText([
    'Alpha',
    'Bravo',
  ]);
  await expect(cardA.locator(':scope > [data-kind="tab"] .title')).toHaveText(['Charlie']);
  await expect(view.locator(`[data-key="t:${s.lonelyTabId}"] .title`)).toHaveText('Delta');

  const selfId = await view.evaluate(async () => (await chrome.windows.getCurrent()).id);
  await expect(view.locator(`[data-key="w:${selfId}"]`)).toHaveCount(0);
});

test('reflects a closed tab live', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  const row = view.locator(`[data-key="t:${s.lonelyTabId}"]`);
  await expect(row).toBeVisible();
  await sw.evaluate(async (id) => {
    await chrome.tabs.create({ url: 'data:text/html,<title>Echo</title>' }); // keep window B alive
    await chrome.tabs.remove(id);
  }, s.lonelyTabId);
  await expect(row).toHaveCount(0);
});

test('click selects one, cmd/ctrl-click toggles, shift-click selects a range', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  const [t1, t2] = s.groupedTabIds;
  const row = (k: string) => view.locator(`[data-key="${k}"]`);
  await row(`t:${t1}`).click();
  await expect(row(`t:${t1}`)).toHaveAttribute('aria-selected', 'true');
  await row(`t:${s.lonelyTabId}`).click({ modifiers: ['ControlOrMeta'] });
  await expect(row(`t:${t1}`)).toHaveAttribute('aria-selected', 'true');
  await expect(row(`t:${s.lonelyTabId}`)).toHaveAttribute('aria-selected', 'true');
  await row(`t:${t2}`).click();
  await expect(row(`t:${t1}`)).toHaveAttribute('aria-selected', 'false');
  await row(`w:${s.winA}`).click({ modifiers: ['Shift'] });
  // anchor is t2; visible rows from w:A down to t2 are: window header, group row, t1, t2
  await expect(view.locator('[aria-selected="true"]')).toHaveCount(4);
});

type FocusCall = [windowId: number, updateInfo: chrome.windows.UpdateInfo];

test('double-click a tab activates it and focuses its window', async ({ sw, view }) => {
  const s = await buildLayout(sw);
  const [t1] = s.groupedTabIds;
  // Headless Chromium ignores window focus changes, so record the view's chrome.windows.update
  // calls (still calling through to Chrome) instead of observing which window ends up focused.
  await view.evaluate(() => {
    const calls: FocusCall[] = [];
    (window as unknown as { __focusCalls: FocusCall[] }).__focusCalls = calls;
    const original = chrome.windows.update.bind(chrome.windows);
    chrome.windows.update = ((windowId: number, updateInfo: chrome.windows.UpdateInfo) => {
      calls.push([windowId, updateInfo]);
      return original(windowId, updateInfo);
    }) as typeof chrome.windows.update;
  });
  await view.locator(`[data-key="t:${t1}"]`).dblclick();
  await expect
    .poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, t1))
    .toBe(true);
  await expect
    .poll(() =>
      view.evaluate(() => (window as unknown as { __focusCalls: FocusCall[] }).__focusCalls),
    )
    .toContainEqual([s.winA, { focused: true }]);
});
