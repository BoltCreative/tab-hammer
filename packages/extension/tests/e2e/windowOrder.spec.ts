import type { Locator, Page, Worker } from '@playwright/test';
import type { WindowRec } from '../../src/model/outline/types';
import {
  expect,
  liveRow,
  outlineCommand,
  readOutline,
  runMenuAction,
  synced,
  test,
} from './fixtures';

// Three windows, one tab each: Alpha, Bravo, Charlie (in that order in the outline).
async function threeWindows(sw: Worker, view: Page) {
  const ids = await sw.evaluate(async () => {
    const out: number[] = [];
    for (const title of ['Alpha', 'Bravo', 'Charlie']) {
      const w = await chrome.windows.create({ url: `data:text/html,<title>${title}</title>` });
      out.push(w!.id!);
    }
    return out;
  });
  await synced(sw, view);
  const recs: WindowRec[] = [];
  for (const id of ids) recs.push(await liveRecord(sw, id));
  return recs;
}

async function liveRecord(sw: Worker, chromeWindowId: number): Promise<WindowRec> {
  let rec: WindowRec | undefined;
  await expect
    .poll(async () => {
      rec = (await readOutline(sw)).windows.find(
        (w) => w.state === 'live' && w.chromeWindowId === chromeWindowId && w.tabs.length > 0,
      );
      return rec !== undefined;
    })
    .toBe(true);
  return rec!;
}

/** The outline's shown window record IDs, in order (the worker's, and the view's). */
async function workerOrder(sw: Worker, only: string[]): Promise<string[]> {
  const { windows } = await readOutline(sw);
  return windows.filter((w) => w.state !== 'trashed' && only.includes(w.id)).map((w) => w.id);
}
async function viewOrder(view: Page, only: string[]): Promise<string[]> {
  const keys = await view
    .locator('[data-kind="window"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!.slice(2)));
  return keys.filter((k) => only.includes(k));
}

/** Presses on `source` and starts dragging it, without dropping. */
async function startDrag(view: Page, source: Locator) {
  const box = (await source.boundingBox())!;
  await view.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await view.mouse.down();
  await view.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 6, { steps: 3 });
}

/**
 * Moves the dragging pointer to `fraction` of the way down `target`. Playwright's drag sends only
 * dragenter when the pointer reaches a new element, and dragover on moves within it, so it ends
 * with a one-pixel move there.
 */
async function dragOver(view: Page, target: Locator, fraction: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height * fraction;
  await view.mouse.move(x, y, { steps: 4 });
  await view.mouse.move(x + 1, y);
}

test('a window header dropped at another header’s edge reorders; its middle merges', async ({
  sw,
  view,
}) => {
  const [a, b, c] = await threeWindows(sw, view);
  const ids = [a!.id, b!.id, c!.id];
  await expect.poll(() => viewOrder(view, ids)).toEqual(ids);
  const header = (rec: WindowRec) => liveRow(view, 'window', rec.chromeWindowId!);
  const card = (rec: WindowRec) => header(rec).locator('..');

  // Charlie over Alpha's top edge: a reorder bar above Alpha. Over its middle: a merge mark.
  await startDrag(view, header(c!));
  await dragOver(view, header(a!), 0.1);
  await expect(card(a!)).toHaveAttribute('data-reorder', 'before');
  await expect(header(a!)).not.toHaveAttribute('data-drop', /.*/);
  await dragOver(view, header(a!), 0.5);
  await expect(header(a!)).toHaveAttribute('data-drop', 'merge');
  await expect(card(a!)).not.toHaveAttribute('data-reorder', /.*/);
  await dragOver(view, header(a!), 0.1);
  await view.mouse.up();

  // Charlie moved first, still its own window, and the order is the worker's (and so persisted).
  await expect.poll(() => workerOrder(sw, ids)).toEqual([c!.id, a!.id, b!.id]);
  await expect.poll(() => viewOrder(view, ids)).toEqual([c!.id, a!.id, b!.id]);
  expect(
    (await readOutline(sw)).windows.find((w) => w.id === c!.id)?.tabs.map((t) => t.title),
  ).toEqual(['Charlie']);

  // A hibernated window reorders too: Bravo, hibernated, dropped after Charlie's bottom edge.
  await outlineCommand(sw, { cmd: 'hibernate', ids: [b!.id] });
  const bravo = view.locator(`[data-key="w:${b!.id}"]`);
  await expect(bravo).toHaveClass(/hibernated/);
  await startDrag(view, bravo);
  await dragOver(view, header(c!), 0.9);
  await expect(card(c!)).toHaveAttribute('data-reorder', 'after');
  await view.mouse.up();
  await expect.poll(() => workerOrder(sw, ids)).toEqual([c!.id, b!.id, a!.id]);

  // The middle of a header merges: Charlie's tab moves into Alpha's window.
  await header(c!).dragTo(header(a!));
  await expect
    .poll(async () => {
      const { windows } = await readOutline(sw);
      return {
        alpha: windows.find((w) => w.id === a!.id)?.tabs.map((t) => t.title),
        charlieGone: !windows.some((w) => w.id === c!.id),
      };
    })
    .toEqual({ alpha: ['Alpha', 'Charlie'], charlieGone: true });
});

test('Alt+Down moves the cursor’s window one place down', async ({ sw, view }) => {
  const [a, b, c] = await threeWindows(sw, view);
  const ids = [a!.id, b!.id, c!.id];
  await expect.poll(() => viewOrder(view, ids)).toEqual(ids);
  await liveRow(view, 'window', a!.chromeWindowId!).click();
  await view.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => workerOrder(sw, ids)).toEqual([b!.id, a!.id, c!.id]);
  await view.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => workerOrder(sw, ids)).toEqual(ids);
});

/** Waits for the one window record not in `before`, live, and returns it. */
async function addedWindow(sw: Worker, before: Set<string>): Promise<WindowRec> {
  let added: WindowRec | undefined;
  await expect
    .poll(async () => {
      added = (await readOutline(sw)).windows.find((w) => !before.has(w.id));
      return added?.state;
    })
    .toBe('live');
  return added!;
}

async function shownIds(sw: Worker): Promise<string[]> {
  return (await readOutline(sw)).windows.filter((w) => w.state !== 'trashed').map((w) => w.id);
}

test('New window, from the menu, opens an empty Chrome window as a known row', async ({
  sw,
  view,
}) => {
  const [a] = await threeWindows(sw, view);
  const before = new Set((await readOutline(sw)).windows.map((w) => w.id));
  // Where the row lands depends on which window headless Chromium reports focused (one on Linux,
  // none on macOS), so placement is checked through the command below, with a fixed anchor.
  await runMenuAction(view, 'New window');

  const added = await addedWindow(sw, before);
  expect(added.provisional).toBeUndefined();
  expect(added.tabs).toHaveLength(1);
  await expect(view.locator(`[data-key="w:${added.id}"]`)).toBeVisible();
  expect((await readOutline(sw)).windows.find((w) => w.id === a!.id)?.tabs).toHaveLength(1);

  // The command the view sends with the focused window: the row lands right after it.
  const before2 = new Set((await readOutline(sw)).windows.map((w) => w.id));
  await outlineCommand(sw, { cmd: 'newWindow', afterWindowId: a!.id });
  const second = await addedWindow(sw, before2);
  const shown = await shownIds(sw);
  expect(shown[shown.indexOf(a!.id) + 1]).toBe(second.id);
});

test('New window is on the outline background’s right-click menu too', async ({ sw, view }) => {
  await threeWindows(sw, view);
  const before = new Set((await readOutline(sw)).windows.map((w) => w.id));
  await view.locator('main.outline').click({ button: 'right', position: { x: 20, y: 400 } });
  await view
    .getByRole('menu', { name: 'Actions' })
    .getByRole('menuitem', { name: 'New window' })
    .click();
  await addedWindow(sw, before);
});

test('dropping tabs on "new window" moves them into a brand-new window', async ({ sw, view }) => {
  const winId = await sw.evaluate(async () => {
    const w = await chrome.windows.create({
      url: [
        'data:text/html,<title>Echo</title>',
        'data:text/html,<title>Foxtrot</title>',
        'data:text/html,<title>Golf</title>',
      ],
    });
    return w!.id!;
  });
  let rec: WindowRec | undefined;
  await expect
    .poll(async () => {
      rec = (await readOutline(sw)).windows.find((w) => w.chromeWindowId === winId);
      return rec?.tabs.length;
    })
    .toBe(3);
  const [echo, foxtrot, golf] = rec!.tabs;
  // Foxtrot hibernated: it travels in the outline, Golf in Chrome.
  await outlineCommand(sw, { cmd: 'hibernate', ids: [foxtrot!.id] });
  const row = (id: string) => view.locator(`[data-key="t:${id}"]`);
  await expect(row(foxtrot!.id)).toHaveClass(/hibernated/);
  await synced(sw, view);

  await expect(view.getByTestId('new-window-drop')).toHaveCount(0);
  await row(foxtrot!.id).click();
  await row(golf!.id).click({ modifiers: ['ControlOrMeta'] });
  await startDrag(view, row(golf!.id));
  const zone = view.getByTestId('new-window-drop');
  await expect(zone).toBeVisible();
  await dragOver(view, zone, 0.5);
  await view.mouse.up();
  await expect(zone).toHaveCount(0);

  await expect
    .poll(async () => {
      const { windows } = await readOutline(sw);
      const shown = windows.filter((w) => w.state !== 'trashed');
      const last = shown[shown.length - 1]!;
      return {
        source: windows.find((w) => w.id === rec!.id)?.tabs.map((t) => t.id),
        newLast: last.id !== rec!.id && last.state === 'live',
        tabs: last.tabs.map((t) => [t.id, t.chromeTabId !== undefined]),
      };
    })
    .toEqual({
      source: [echo!.id],
      newLast: true,
      tabs: [
        [foxtrot!.id, false],
        [golf!.id, true],
      ],
    });
  const chromeWindowOfGolf = await sw.evaluate(
    async (id) => (await chrome.tabs.get(id)).windowId,
    golf!.chromeTabId!,
  );
  expect(chromeWindowOfGolf).not.toBe(winId);
});

test('right-click "Open in new window" seeds a new window with the selected tabs, after their window', async ({
  sw,
  view,
}) => {
  const [a, b] = await threeWindows(sw, view);
  const extra = await sw.evaluate(
    async (windowId) =>
      (await chrome.tabs.create({ windowId, url: 'data:text/html,<title>Alpha2</title>' })).id!,
    a!.chromeWindowId!,
  );
  await expect(liveRow(view, 'tab', extra)).toBeVisible();
  const before = new Set((await readOutline(sw)).windows.map((w) => w.id));
  const first = liveRow(view, 'tab', a!.tabs[0]!.chromeTabId!);
  await first.click();
  await liveRow(view, 'tab', extra).click({ modifiers: ['ControlOrMeta'] });
  await liveRow(view, 'tab', extra).click({ button: 'right' });
  await view.getByRole('menuitem', { name: 'Open in new window (2 tabs)' }).click();

  const added = await addedWindow(sw, before);
  await expect
    .poll(async () =>
      (await readOutline(sw)).windows.find((w) => w.id === added.id)?.tabs.map((t) => t.title),
    )
    .toEqual(['Alpha', 'Alpha2']);
  // Alpha's window gave up its only tabs and closed; the new row sits where it was, before Bravo.
  const shown = await shownIds(sw);
  expect(shown.indexOf(added.id)).toBe(shown.indexOf(b!.id) - 1);
});

test('a window emptied of its open tabs by Open in new window stays a hibernated row, not trash', async ({
  sw,
  view,
}) => {
  const winId = await sw.evaluate(async () => {
    const w = await chrome.windows.create({
      url: ['data:text/html,<title>Echo</title>', 'data:text/html,<title>Foxtrot</title>'],
    });
    return w!.id!;
  });
  let rec: WindowRec | undefined;
  await expect
    .poll(async () => {
      rec = (await readOutline(sw)).windows.find((w) => w.chromeWindowId === winId);
      return rec?.tabs.length;
    })
    .toBe(2);
  const [echo, foxtrot] = rec!.tabs;
  await outlineCommand(sw, { cmd: 'hibernate', ids: [foxtrot!.id] });
  await expect(view.locator(`[data-key="t:${foxtrot!.id}"]`)).toHaveClass(/hibernated/);
  await synced(sw, view);

  // Echo, the window's only open tab, moves out: Chrome closes the window.
  const echoRow = view.locator(`[data-key="t:${echo!.id}"]`);
  await echoRow.click({ button: 'right' });
  await view.getByRole('menuitem', { name: 'Open in new window (1 tab)' }).click();

  await expect
    .poll(async () => {
      const { windows } = await readOutline(sw);
      const source = windows.find((w) => w.id === rec!.id);
      const moved = windows.find((w) => w.tabs.some((t) => t.id === echo!.id));
      return {
        source: source && [source.state, source.tabs.map((t) => t.id)],
        movedLive: moved?.state === 'live' && moved.id !== rec!.id,
        windowOpen: (await sw.evaluate(() => chrome.windows.getAll())).some((w) => w.id === winId),
      };
    })
    .toEqual({ source: ['hibernated', [foxtrot!.id]], movedLive: true, windowOpen: false });
});
