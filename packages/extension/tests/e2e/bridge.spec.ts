// The whole Claude → Chrome path: an MCP client starts the real MCP server (as Claude Code does),
// which reaches the native host that Chromium itself launched for the extension, which runs the
// command against Chrome. Chromium finds the native host through a manifest in the profile's
// NativeMessagingHosts folder, so the test profile carries one pointing at a deployed host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NATIVE_HOST_NAME, type WindowInfo } from '@tab-hammer/protocol';
import { deployHost, hostManifest } from '../../../mcp/src/deploy.ts';
import { expect, launchWithExtension, liveRow, readOutline, test as base } from './fixtures';

const MCP_MAIN = path.resolve(import.meta.dirname, '../../../mcp/src/main.ts');

const test = base.extend<{ dir: string; sock: string; mcp: Client }>({
  // eslint-disable-next-line no-empty-pattern
  dir: async ({}, use) => {
    // Short path: Unix socket paths are capped near 104 bytes on macOS.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  sock: async ({ dir }, use) => use(path.join(dir, 'b.sock')),
  context: async ({ dir, sock }, use) => {
    // Deployed exactly as the installer does it, but into this test's own folder.
    const profile = path.join(dir, 'profile');
    const hosts = path.join(profile, 'NativeMessagingHosts');
    fs.mkdirSync(hosts, { recursive: true });
    const launcher = deployHost(path.join(dir, 'host'));
    fs.writeFileSync(
      path.join(hosts, `${NATIVE_HOST_NAME}.json`),
      JSON.stringify(hostManifest(launcher)),
    );
    const context = await launchWithExtension(profile, { TAB_HAMMER_SOCKET: sock });
    await use(context);
    await context.close();
  },
  mcp: async ({ sock, sw }, use) => {
    void sw; // the service worker connects to the host at startup
    await expect.poll(() => fs.existsSync(sock)).toBe(true);
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MCP_MAIN],
        env: { ...(process.env as Record<string, string>), TAB_HAMMER_SOCKET: sock },
        stderr: 'inherit',
      }),
    );
    await use(client);
    await client.close();
  },
});

async function call<T>(mcp: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await mcp.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]!.text;
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as T;
}

test('Claude can list, group, move, focus, and close tabs through the MCP server', async ({
  sw,
  view,
  mcp,
}) => {
  const ids = await sw.evaluate(async () => {
    const w = await chrome.windows.create({
      url: ['data:text/html,<title>Alpha</title>', 'data:text/html,<title>Bravo</title>'],
    });
    const tabs = await chrome.tabs.query({ windowId: w!.id });
    return { windowId: w!.id!, alpha: tabs[0]!.id!, bravo: tabs[1]!.id! };
  });
  await expect
    .poll(() => sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.title), ids.bravo))
    .toBe('Bravo');

  // list_tabs sees the new window and leaves out Tab Hammer's own.
  const { windows } = await call<{ windows: WindowInfo[] }>(mcp, 'list_tabs');
  const viewWindowId = await view.evaluate(async () => (await chrome.windows.getCurrent()).id);
  expect(windows.map((w) => w.windowId)).not.toContain(viewWindowId);
  const listed = windows.find((w) => w.windowId === ids.windowId)!;
  expect(listed.items.map((t) => 'tabId' in t && t.title)).toEqual(['Alpha', 'Bravo']);

  // group_tabs makes a titled, colored group, and the outline shows it live.
  const { groupId } = await call<{ groupId: number }>(mcp, 'group_tabs', {
    tabIds: [ids.alpha, ids.bravo],
    title: 'Research',
    color: 'red',
  });
  expect(await sw.evaluate((g) => chrome.tabGroups.get(g), groupId)).toMatchObject({
    title: 'Research',
    color: 'red',
    windowId: ids.windowId,
  });
  await expect(liveRow(view, 'group', groupId).locator('.title')).toHaveText('Research');

  // move_tabs with no window puts the tab in a new one.
  const moved = await call<{ windowId: number }>(mcp, 'move_tabs', { tabIds: [ids.bravo] });
  expect(moved.windowId).not.toBe(ids.windowId);
  expect(await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.windowId), ids.bravo)).toBe(
    moved.windowId,
  );

  // open_tabs with no window opens a new one. Tab Hammer opened it, so the outline records it as
  // known at once instead of holding it as a candidate for re-linking to a closed window.
  const opened = await call<{ windowId: number }>(mcp, 'open_tabs', {
    urls: ['data:text/html,<title>Delta</title>'],
  });
  const openedRec = (await readOutline(sw)).windows.find(
    (w) => w.chromeWindowId === opened.windowId,
  );
  expect({ recorded: openedRec !== undefined, provisional: openedRec?.provisional }).toEqual({
    recorded: true,
    provisional: undefined,
  });

  // focus_tab selects the tab (window focus itself is invisible in headless Chromium).
  await call(mcp, 'open_tabs', {
    urls: ['data:text/html,<title>Charlie</title>'],
    windowId: ids.windowId,
  });
  await call(mcp, 'focus_tab', { tabId: ids.alpha });
  expect(await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.active), ids.alpha)).toBe(
    true,
  );

  // close_tabs closes it, and Chrome's errors come back as tool errors.
  expect(await call(mcp, 'close_tabs', { tabIds: [ids.bravo] })).toEqual({ closed: 1 });
  await expect(liveRow(view, 'tab', ids.bravo)).toHaveCount(0);
  await expect(call(mcp, 'focus_tab', { tabId: ids.bravo })).rejects.toThrow(/No tab with id/);
});
