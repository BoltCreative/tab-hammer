import { expect, test } from './fixtures';

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
  sw,
  view,
}) => {
  // Read Chrome's own window list and the service worker's stored id, rather than Playwright's
  // page list, which registers new pages asynchronously and could miss a second window.
  const popupState = () =>
    sw.evaluate(async () => ({
      popupIds: (await chrome.windows.getAll({ windowTypes: ['popup'] })).map((w) => w.id),
      viewWindowId: (await chrome.storage.session.get('viewWindowId')).viewWindowId as unknown,
    }));
  const before = await popupState();
  const viewWindowId = await view.evaluate(async () => (await chrome.windows.getCurrent()).id);
  expect(before).toEqual({ popupIds: [viewWindowId], viewWindowId });

  await sw.evaluate(() =>
    (
      globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }
    ).tabHammer.openOrFocus(),
  );
  expect(await popupState()).toEqual(before);
});

test('renders window cards with a group row and indented tabs, excluding itself', async ({
  sw,
  view,
}) => {
  // The e2e fixture loads the extension with --load-extension, which grants its manifest's
  // host_permissions outright, so the "allow previews" banner never appears here.
  await expect(view.getByTestId('permission-banner')).toHaveCount(0);

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

test('the header stays put while only the outline list scrolls', async ({ sw, view }) => {
  await sw.evaluate(async () => {
    const urls = Array.from({ length: 40 }, (_, i) => `data:text/html,<title>T${i}</title>`);
    await chrome.windows.create({ url: urls });
  });
  const list = view.locator('main.outline');
  await expect(view.locator('[role="treeitem"], .row').nth(40)).toBeAttached();
  const header = view.locator('header.app-header');
  const headerTop = async () => (await header.boundingBox())!.y;
  expect(await headerTop()).toBe(0);

  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await view.evaluate(() => window.scrollY)).toBe(0);
  expect(await headerTop()).toBe(0);
  await expect(view.getByRole('button', { name: 'Clear previews' })).toBeInViewport();
});

test("right-clicking a window header copies all its tabs' URLs in tab order", async ({
  context,
  sw,
  view,
}) => {
  // Lets the test read the clipboard back (the extension itself only asks for clipboardWrite).
  // No origin: Playwright can't parse chrome-extension:// origins, and this profile is throwaway.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const s = await buildLayout(sw);
  const expected = await sw.evaluate(
    async (id) => (await chrome.tabs.query({ windowId: id })).map((t) => t.url || t.pendingUrl),
    s.winA,
  );

  await view.locator(`[data-key="w:${s.winA}"]`).click({ button: 'right' });
  const item = view.getByRole('menuitem', { name: 'Copy all URLs (3)' });
  await item.click();
  await expect(view.getByTestId('context-menu')).toHaveCount(0);
  await expect
    .poll(() => view.evaluate(() => navigator.clipboard.readText()))
    .toBe(expected.join('\n'));
});

test('the header search filters the outline, keeping window and group context', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  // Collapsed in Chrome: a match inside still shows.
  await sw.evaluate(async (tabId) => {
    const { groupId } = await chrome.tabs.get(tabId);
    await chrome.tabGroups.update(groupId, { collapsed: true });
  }, s.groupedTabIds[0]);
  const search = view.getByRole('searchbox', { name: 'Search tabs by title or URL' });
  await search.fill('bravo');
  const rows = view.locator('main.outline [role="treeitem"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-key', `w:${s.winA}`);
  await expect(rows.locator('.title').nth(1)).toHaveText('Research');
  await expect(rows.locator('.title').nth(2)).toHaveText('Bravo');
  await expect(view.getByTestId('match-count')).toHaveText('1 tab');
  await expect(search).toBeInViewport();

  await search.fill('nothing-matches-this');
  await expect(view.getByText('No matching tabs')).toBeVisible();

  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(view.locator(`[data-key="t:${s.lonelyTabId}"]`)).toBeVisible();
  await expect(view.getByTestId('match-count')).toHaveCount(0);
});
