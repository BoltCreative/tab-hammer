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

const openOrFocus = (sw: import('@playwright/test').Worker) =>
  sw.evaluate(() =>
    (
      globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }
    ).tabHammer.openOrFocus(),
  );
// Read Chrome's own window list rather than Playwright's page list, which registers new pages
// asynchronously and could miss a second window.
const popupIds = (sw: import('@playwright/test').Worker) =>
  sw.evaluate(async () =>
    (await chrome.windows.getAll({ windowTypes: ['popup'] })).map((w) => w.id),
  );

test('opening twice focuses the existing Tab Hammer window instead of making another', async ({
  sw,
  view,
}) => {
  const viewWindowId = await view.evaluate(async () => (await chrome.windows.getCurrent()).id);
  expect(await popupIds(sw)).toEqual([viewWindowId]);
  await openOrFocus(sw);
  expect(await popupIds(sw)).toEqual([viewWindowId]);
});

test('after an extension reload, opening reuses the old window and closes leftovers', async ({
  sw,
  view,
}) => {
  await expect(view.locator('main.outline')).toBeVisible();
  const viewWindowId = await view.evaluate(async () => (await chrome.windows.getCurrent()).id);
  // A reload wipes chrome.storage.session, and earlier reloads may have left a second window
  // behind. (The harness can't reload a --load-extension extension, so recreate the aftermath.)
  await sw.evaluate(async () => {
    await chrome.storage.session.clear();
    await chrome.windows.create({
      url: chrome.runtime.getURL('src/view/index.html'),
      type: 'popup',
    });
  });
  expect(await popupIds(sw)).toHaveLength(2);

  await openOrFocus(sw);
  expect(await popupIds(sw)).toEqual([viewWindowId]);
  await expect(view.locator('main.outline')).toBeVisible();
});

test('after an extension unload orphans the window on a New Tab page, opening brings it back', async ({
  sw,
  view,
}) => {
  await expect(view.locator('main.outline')).toBeVisible();
  const viewWindowId = await view.evaluate(async () => (await chrome.windows.getCurrent()).id);
  // While a build is unloaded, Chrome navigates its pages to the New Tab page; the reload also
  // wipes chrome.storage.session. (The harness can't reload the extension, so recreate that.)
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ windowType: 'popup' });
    await chrome.tabs.update(tab!.id!, { url: 'chrome://newtab/' });
    await chrome.storage.session.clear();
  });
  await expect.poll(() => view.url()).not.toContain('src/view/index.html');

  await openOrFocus(sw);
  expect(await popupIds(sw)).toEqual([viewWindowId]);
  await expect.poll(() => view.url()).toContain('src/view/index.html');
  await expect(view.locator('main.outline')).toBeVisible();
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

test('keyboard: arrows move and extend the selection, Left/Right collapse, Enter activates', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw);
  const [alpha, bravo] = s.groupedTabIds;
  const row = (k: string) => view.locator(`[data-key="${k}"]`);
  const selectedKeys = () =>
    view.locator('[aria-selected="true"]').evaluateAll((els) => els.map((e) => e.dataset.key));

  await row(`t:${alpha}`).click();
  await view.keyboard.press('ArrowDown');
  await expect(row(`t:${bravo}`)).toBeFocused();
  expect(await selectedKeys()).toEqual([`t:${bravo}`]);
  await view.keyboard.press('Shift+ArrowDown'); // onto Charlie, the window's loose tab
  const charlie = await row(`w:${s.winA}`)
    .locator('..')
    .locator(':scope > [data-kind="tab"]')
    .getAttribute('data-key');
  expect(await selectedKeys()).toEqual([`t:${bravo}`, charlie]);
  await expect(row(charlie!)).toHaveAttribute('aria-level', '2');
  await expect(row(`t:${bravo}`)).toHaveAttribute('aria-level', '3');
  await expect(row(charlie!)).toHaveAttribute('tabindex', '0');

  await view.keyboard.press('ArrowLeft'); // to the window
  await expect(row(`w:${s.winA}`)).toBeFocused();
  await expect(row(`w:${s.winA}`)).toHaveAttribute('aria-expanded', 'true');
  await view.keyboard.press('ArrowLeft'); // collapse it
  await expect(row(`w:${s.winA}`)).toHaveAttribute('aria-expanded', 'false');
  await expect(row(`t:${alpha}`)).toHaveCount(0);
  await view.keyboard.press('ArrowRight'); // expand
  await view.keyboard.press('ArrowRight'); // into the group
  await expect(row(`g:${await groupIdOf(sw, alpha)}`)).toBeFocused();
  await view.keyboard.press('ArrowDown');
  await view.keyboard.press('Enter');
  await expect
    .poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, alpha))
    .toBe(true);

  // Down arrow from the search box lands in the outline.
  await view.getByRole('searchbox').focus();
  await view.keyboard.press('ArrowDown');
  await expect(row(`t:${alpha}`)).toBeFocused();
});

async function groupIdOf(sw: import('@playwright/test').Worker, tabId: number) {
  return sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, tabId);
}

test('closes duplicate tabs across windows, keeping one copy', async ({ sw, view }) => {
  const dup = 'data:text/html,<title>Dup</title>';
  await sw.evaluate(async (url) => {
    await chrome.windows.create({
      url: [url, `${url}#again`, 'data:text/html,<title>Solo</title>'],
    });
    await chrome.windows.create({ url });
  }, dup);
  await expect(view.locator('.tab.duplicate')).toHaveCount(3);
  const button = view.getByRole('button', { name: 'Close 2 duplicates' });
  await button.click();
  await expect
    .poll(() =>
      sw.evaluate(async () => (await chrome.tabs.query({ title: 'Dup' })).map((t) => t.active)),
    )
    .toEqual([true]);
  await expect(view.locator('.tab.duplicate')).toHaveCount(0);
  await expect(button).toHaveCount(0);
  await expect(view.getByText('Solo')).toBeVisible();
});
