import { expect, liveRow, synced, test } from './fixtures';

type Setup = { winA: number; winB: number; groupedTabIds: [number, number]; lonelyTabId: number };

// Build a known layout from inside the extension's service worker (it has the tabs/tabGroups APIs),
// resolving once the view shows it.
async function buildLayout(
  sw: import('@playwright/test').Worker,
  view: import('@playwright/test').Page,
): Promise<Setup> {
  const s = await sw.evaluate(async () => {
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
  await synced(sw, view);
  return s;
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

test('Alt+Shift+H is registered as the toolbar button’s shortcut', async ({ sw }) => {
  const commands = await sw.evaluate(() => chrome.commands.getAll());
  // On a Mac Chrome reports Alt as ⌥ and Shift as ⇧.
  expect(commands.find((c) => c.name === '_execute_action')?.shortcut).toMatch(
    /^(Alt\+Shift\+H|⌥⇧H)$/,
  );
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
  // chrome.windows.remove can resolve before the window leaves getAll (seen on Linux CI), so
  // wait for the leftover to actually go.
  await expect.poll(() => popupIds(sw)).toEqual([viewWindowId]);
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

  const s = await buildLayout(sw, view);
  const cardA = view.locator('section[data-testid="window-card"]', {
    has: liveRow(view, 'window', s.winA),
  });
  await expect(cardA.locator('[data-kind="group"] .title')).toHaveText('Research');
  await expect(cardA.locator('.group-tabs [data-kind="tab"] .title')).toHaveText([
    'Alpha',
    'Bravo',
  ]);
  await expect(cardA.locator(':scope > [data-kind="tab"] .title')).toHaveText(['Charlie']);
  await expect(liveRow(view, 'tab', s.lonelyTabId).locator('.title')).toHaveText('Delta');

  const selfId = await view.evaluate(async () => (await chrome.windows.getCurrent()).id);
  await expect(liveRow(view, 'window', selfId!)).toHaveCount(0);
});

test('reflects a closed tab live', async ({ sw, view }) => {
  const s = await buildLayout(sw, view);
  const row = liveRow(view, 'tab', s.lonelyTabId);
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
  const s = await buildLayout(sw, view);
  const [t1, t2] = s.groupedTabIds;
  const row = (tabId: number) => liveRow(view, 'tab', tabId);
  await row(t1).click();
  await expect(row(t1)).toHaveAttribute('aria-selected', 'true');
  await row(s.lonelyTabId).click({ modifiers: ['ControlOrMeta'] });
  await expect(row(t1)).toHaveAttribute('aria-selected', 'true');
  await expect(row(s.lonelyTabId)).toHaveAttribute('aria-selected', 'true');
  await row(t2).click();
  await expect(row(t1)).toHaveAttribute('aria-selected', 'false');
  await liveRow(view, 'window', s.winA).click({ modifiers: ['Shift'] });
  // anchor is t2; visible rows from w:A down to t2 are: window header, group row, t1, t2
  await expect(view.locator('[aria-selected="true"]')).toHaveCount(4);
});

type FocusCall = [windowId: number, updateInfo: chrome.windows.UpdateInfo];

test('double-click a tab activates it and focuses its window', async ({ sw, view }) => {
  const s = await buildLayout(sw, view);
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
  await liveRow(view, 'tab', t1).dblclick();
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
  // A short view, so a few tabs overflow the list (each tab is a renderer: keep them few).
  await view.setViewportSize({ width: 420, height: 300 });
  await sw.evaluate(async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `data:text/html,<title>T${i}</title>`);
    await chrome.windows.create({ url: urls });
  });
  const list = view.locator('main.outline');
  await expect(view.locator('[role="treeitem"], .row').nth(10)).toBeAttached();
  const header = view.locator('header.app-header');
  const headerTop = async () => (await header.boundingBox())!.y;
  expect(await headerTop()).toBe(0);

  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await view.evaluate(() => window.scrollY)).toBe(0);
  expect(await headerTop()).toBe(0);
  await expect(view.getByRole('button', { name: 'Actions' })).toBeInViewport();
});

test("right-clicking a window header copies all its tabs' URLs in tab order", async ({
  context,
  sw,
  view,
}) => {
  // Lets the test read the clipboard back. Writing is deliberately not granted: the extension has
  // no clipboardWrite permission, and the view writes from the user's click without one.
  // No origin: Playwright can't parse chrome-extension:// origins, and this profile is throwaway.
  await context.grantPermissions(['clipboard-read']);
  const s = await buildLayout(sw, view);
  const expected = await sw.evaluate(
    async (id) => (await chrome.tabs.query({ windowId: id })).map((t) => t.url || t.pendingUrl),
    s.winA,
  );

  await liveRow(view, 'window', s.winA).click({ button: 'right' });
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
  const s = await buildLayout(sw, view);
  // Collapsed in Chrome: a match inside still shows.
  await sw.evaluate(async (tabId) => {
    const { groupId } = await chrome.tabs.get(tabId);
    await chrome.tabGroups.update(groupId, { collapsed: true });
  }, s.groupedTabIds[0]);
  const search = searchBox(view);
  await search.fill('bravo');
  const rows = view.locator('main.outline [role="treeitem"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-window-id', `${s.winA}`);
  await expect(rows.locator('.title').nth(1)).toHaveText('Research');
  await expect(rows.locator('.title').nth(2)).toHaveText('Bravo');
  await expect(view.getByTestId('match-count')).toHaveText('1 tab');
  await expect(search).toBeInViewport();

  await search.fill('nothing-matches-this');
  await expect(view.getByText('No matching tabs')).toBeVisible();

  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(liveRow(view, 'tab', s.lonelyTabId)).toBeVisible();
  await expect(view.getByTestId('match-count')).toHaveCount(0);
});

const searchBox = (view: import('@playwright/test').Page) =>
  view.getByRole('combobox', { name: 'Search tabs by title or URL' });

test('keyboard: focus stays in search while ↑/↓ move the cursor, ⇧ extends, ⌘↑/↓ collapse and open, Enter activates', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw, view);
  const [alpha, bravo] = s.groupedTabIds;
  const row = (tabId: number) => liveRow(view, 'tab', tabId);
  const winA = liveRow(view, 'window', s.winA);
  const search = searchBox(view);
  const selectedTabIds = () =>
    view
      .locator('[aria-selected="true"]')
      .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.tabId)));
  // The cursor row: the one the search box names as active, and marked for the highlight.
  const expectCursor = async (r: ReturnType<typeof row>) => {
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute('aria-activedescendant', (await r.getAttribute('id'))!);
    await expect(r).toHaveAttribute('data-cursor', 'true');
    await expect(view.locator('[data-cursor]')).toHaveCount(1);
  };

  await row(alpha).click();
  await expectCursor(row(alpha));
  await view.keyboard.press('ArrowDown');
  await expectCursor(row(bravo));
  expect(await selectedTabIds()).toEqual([bravo]);
  await view.keyboard.press('Shift+ArrowDown'); // onto Charlie, the window's loose tab
  const charlie = Number(
    await winA.locator('..').locator(':scope > [data-kind="tab"]').getAttribute('data-tab-id'),
  );
  expect(await selectedTabIds()).toEqual([bravo, charlie]);
  await expect(row(charlie)).toHaveAttribute('aria-level', '2');
  await expect(row(bravo)).toHaveAttribute('aria-level', '3');
  await expectCursor(row(charlie));

  // Left, Right, Home and End are the search box's text keys now: the cursor stays put.
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) await view.keyboard.press(key);
  await expectCursor(row(charlie));

  await view.keyboard.press('ControlOrMeta+ArrowUp'); // to the window
  await expectCursor(winA);
  await expect(winA).toHaveAttribute('aria-expanded', 'true');
  await view.keyboard.press('ControlOrMeta+ArrowUp'); // collapse it
  await expect(winA).toHaveAttribute('aria-expanded', 'false');
  await expect(row(alpha)).toHaveCount(0);
  await view.keyboard.press('ControlOrMeta+ArrowDown'); // expand
  await view.keyboard.press('ControlOrMeta+ArrowDown'); // into the group
  await expectCursor(liveRow(view, 'group', await groupIdOf(sw, alpha)));
  await view.keyboard.press('ArrowDown');
  await view.keyboard.press('Enter');
  await expect
    .poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, alpha))
    .toBe(true);
  await expect(search).toHaveValue('');
});

test('typing anywhere goes to the search box, first character included', async ({ sw, view }) => {
  const s = await buildLayout(sw, view);
  const search = searchBox(view);
  await expect(liveRow(view, 'tab', s.lonelyTabId)).toBeVisible();
  // Nothing focused.
  await view.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(search).not.toBeFocused();
  await view.keyboard.type('delt');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('delt');
  await expect(view.getByTestId('match-count')).toHaveText('1 tab');

  // A focused button too: the key types after what's already there.
  await view.getByRole('button', { name: 'Actions' }).focus();
  await view.keyboard.press('a');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('delta');
});

test('searching: the first match is the cursor, Enter opens the highlighted row, Esc clears the search and then the selection', async ({
  sw,
  view,
}) => {
  const s = await buildLayout(sw, view);
  const [, bravo] = s.groupedTabIds;
  const search = searchBox(view);
  await search.focus();
  await view.keyboard.type('bravo');
  const winA = liveRow(view, 'window', s.winA);
  await expect(winA).toHaveAttribute('data-cursor', 'true');
  await view.keyboard.press('ArrowDown'); // the group
  await view.keyboard.press('ArrowDown'); // Bravo
  await expect(liveRow(view, 'tab', bravo)).toHaveAttribute('data-cursor', 'true');
  await view.keyboard.press('Enter');
  await expect
    .poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, bravo))
    .toBe(true);

  // Esc clears the search; the cursor stays on Bravo, now among the whole outline, still selected.
  await view.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(liveRow(view, 'tab', s.lonelyTabId)).toBeVisible();
  await expect(liveRow(view, 'tab', bravo)).toHaveAttribute('data-cursor', 'true');
  await expect(liveRow(view, 'tab', bravo)).toHaveAttribute('aria-selected', 'true');
  // Again: the selection goes.
  await view.keyboard.press('Escape');
  await expect(view.locator('[aria-selected="true"]')).toHaveCount(0);
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
  // From a right-click on the outline's empty background (the room below the last row).
  const list = view.locator('main.outline');
  const box = (await list.boundingBox())!;
  await list.click({ button: 'right', position: { x: box.width / 2, y: box.height - 8 } });
  const menu = view.getByRole('menu', { name: 'Actions' });
  await menu.getByRole('menuitem', { name: 'Close 2 duplicates' }).click();
  await expect(menu).toHaveCount(0);
  await expect
    .poll(() =>
      sw.evaluate(async () => (await chrome.tabs.query({ title: 'Dup' })).map((t) => t.active)),
    )
    .toEqual([true]);
  await expect(view.locator('.tab.duplicate')).toHaveCount(0);
  // The header's Actions menu offers the same action, now with nothing to close.
  await view.getByRole('button', { name: 'Actions' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Close duplicates' })).toBeDisabled();
  await view.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(view.getByText('Solo')).toBeVisible();
});
