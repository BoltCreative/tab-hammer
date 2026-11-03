import { expect, test } from './fixtures';

type Bounds = { left: number; top: number; width: number; height: number };

test('the Tab Hammer window reopens where the user last left it', async ({ sw, view }) => {
  await expect(view.locator('main.outline')).toBeVisible();
  const target: Bounds = { left: 60, top: 50, width: 380, height: 480 };

  // Move and resize the view window the way the user would, then wait for the debounced save.
  const reported = await sw.evaluate(async (b) => {
    const { viewWindowId } = await chrome.storage.session.get('viewWindowId');
    const win = await chrome.windows.update(viewWindowId as number, b);
    return { left: win.left, top: win.top, width: win.width, height: win.height };
  }, target);
  expect(reported).toEqual(target);
  await expect
    .poll(() =>
      sw.evaluate(
        async () => (await chrome.storage.local.get('viewWindowBounds')).viewWindowBounds,
      ),
    )
    .toEqual(target);

  // Close the view, then reopen it through the toolbar path, recording the create call: headless
  // windows don't reliably report real screen positions, so assert what was asked of Chrome.
  const created = await sw.evaluate(async () => {
    const { viewWindowId } = await chrome.storage.session.get('viewWindowId');
    await chrome.windows.remove(viewWindowId as number);
    let createData: chrome.windows.CreateData | undefined;
    const original = chrome.windows.create.bind(chrome.windows);
    chrome.windows.create = ((data: chrome.windows.CreateData) => {
      createData = data;
      return original(data);
    }) as typeof chrome.windows.create;
    await (
      globalThis as unknown as { tabHammer: { openOrFocus: () => Promise<void> } }
    ).tabHammer.openOrFocus();
    chrome.windows.create = original;
    return createData;
  });
  expect(created).toMatchObject({ type: 'popup', ...target });
});
