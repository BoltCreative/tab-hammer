# Tab Hammer

Tab Hammer is a Chrome extension that shows every open Chrome window, tab group, and tab as a live
outline in its own window. You can rename, rearrange, hibernate, and restore windows and tabs from
the outline, see a screenshot preview of any tab before switching to it, carry your outline across
computers through your own Google Drive, and let an AI agent like Claude Code organize your tabs
through its MCP server.

## Tab Hammer and Tabs Outliner

Tab Hammer is a spiritual successor to
[Tabs Outliner](https://chromewebstore.google.com/detail/tabs-outliner/eggkanocgddhmamlbiijnphhppkpkmkl),
the long-running extension that shows your tabs as an outline in its own window. If you've used
Tabs Outliner, the core ideas will feel familiar: a dedicated outline window, closing a window
without losing it, and bringing it back later.

Tab Hammer takes the same idea and builds on modern Chrome:

- **Built for Manifest V3** and Chrome's native tab groups, which show up in the outline as
  groups.
- **Hibernate and a Recently closed trash** — hibernate a window or tab to close it in Chrome but
  keep it in the outline, dimmed, until you click it back open. Deleted rows go to a Recently
  closed section you can restore from for seven days.
- **Previews** — a screenshot of each tab, shown in a panel under the outline as you hover or
  move through it.
- **Sync across computers** through a hidden app-data folder in your own Google Drive, with daily
  checkpoints you can restore from. There's no Tab Hammer server.
- **Your other Chrome Sync devices**, phones included, in the same view.
- **AI agent control** through an MCP server, so an agent can list and rearrange tabs for you.

## Features

- **Its own window** — a dedicated outline window, not a side panel.
- **A live outline** of every window, tab group, and tab, kept in sync as you browse, with
  Tab Hammer's own IDs so a window keeps its name and place across a browser restart.
- **Search** tabs by title or URL.
- **Keyboard and mouse** — click, Cmd/Ctrl-click, and Shift-click to select; arrow keys to move;
  Enter or double-click to switch to a tab (or reopen a hibernated one); Delete to move the
  selection to the trash.
- **Drag and drop** to move tabs, groups, and whole windows.
- **Rename windows**, and give each computer a name for your other computers to see.
- **Hibernate** a window or tab, and **Move to trash**, with a **Recently closed** section to
  restore from for seven days.
- **Previews** — a panel under the outline shows a screenshot of the tab you hover or move to.
  Previews are taken as you browse; **Capture missing** screenshots every tab without one and
  **Refresh all** re-captures every tab, one at a time in the background, with progress and a Stop
  button. **Clear previews** wipes them all.
- **Close duplicates** — close tabs whose page is already open in another tab.
- **Copy all URLs** — right-click a window to copy its tabs' URLs, one per line.
- **Other devices** — view another computer's outline, a checkpoint, or a Chrome Sync device
  read-only, then **Open here** (a copy) or **Restore all** (missing windows come back hibernated).
- **AI agent control** — see [Connect an AI agent (MCP)](#connect-an-ai-agent-mcp).

## Install

**Chrome Web Store:** coming soon.

**From source:**

```
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select the
`packages/extension/dist/` folder. Click the toolbar icon to open Tab Hammer.

## Connect an AI agent (MCP)

Tab Hammer includes an MCP server, so an AI agent like Claude Code can list your windows, groups,
and tabs and rearrange them: "group my research tabs", "close the duplicates", "move everything
about the trip into its own window". Setup instructions are coming soon.

## Permissions

Tab Hammer asks for these when you install it:

- **Read and change your tabs** (`tabs`, `tabGroups`, `webNavigation`): to show every window, group,
  and tab in the outline, move and close them for you, and match the windows Chrome restores after a
  restart back to their rows.
- **Access to all sites** (`<all_urls>`): to screenshot the page a window is showing for its tab
  preview. You can withhold it; Tab Hammer then shows a banner offering to grant it, and works
  without previews until you do.
- **Debugger** (`debugger`): to screenshot background tabs. It's attached only while you run
  **Capture missing** or **Refresh all**, one tab at a time, so Chrome shows its "started debugging
  this browser" banner only during those runs (see below to hide it). Chrome doesn't allow this
  permission to be optional.
- **Communicate with cooperating native applications** (`nativeMessaging`): the bridge to an AI
  agent such as Claude Code. It does nothing unless you've installed the MCP server.
- `storage`, `favicon`, `system.display`, `alarms`, and `identity`, which add no install warning:
  settings, tab icons from Chrome's cache, keeping the window on a connected screen, checking for
  your other computers' outlines every 5 minutes, and signing in to your own Google Drive for sync.

Asked for only when you use the feature:

- **Your other devices' tabs** (`sessions`): the devices panel asks when you click **Show your
  phones and other Chrome Sync devices**.

Previews are stored only on your computer, and each is kept as long as a window in your outline
(open, hibernated, or recently closed) still has a tab at that address.

## Privacy

Tab Hammer has no server and collects nothing. Your outline and previews stay in your browser;
if you turn on sync, your outline is stored in a hidden app-data folder in your own Google Drive
that only Tab Hammer can read. Incognito windows and tabs are never captured. See the
[privacy policy](docs/store/privacy-policy.md) for the details.

## Hiding Chrome's debugging banner

**Capture missing** and **Refresh all** screenshot background tabs by briefly attaching Chrome's
debugger, so Chrome shows a "started debugging this browser" banner while they run. Hover and
everyday previews never attach it.

You can hide the banner by launching Chrome with the `--silent-debugger-extension-api` flag. The
trade-off: it hides the banner for **every** extension that uses the debugger, not just Tab
Hammer. On macOS, `npm run make:chrome-launcher` builds a small **Google Chrome silent
debugger.app** in `~/Applications` (pass another folder as an argument) that launches your normal
Chrome, same profile, with that flag. Quit Chrome completely (⌘Q) and launch it from that app; to
undo, launch Chrome normally.

## Developing

```
npm install
npm run dev
```

The dev server writes the extension to `~/.tab-hammer/dist` (set `TAB_HAMMER_DEV_DIR` to use
another folder). Load that folder unpacked in `chrome://extensions` once; after that, most changes
to the view or the service worker reload the running extension automatically.

The manifest has a fixed public `key`, so the extension gets the same ID wherever it's built:
storage, previews, and permission grants carry over between builds, checkouts, and worktrees. To
try a different checkout, stop `npm run dev` and start it in the other one; the running extension
reloads onto the new build.

Before opening a pull request, run the completion gate:

```
npm run gate
```

It runs the typechecker, linter, formatter check, unit tests, and the end-to-end Playwright suite
against a headless Chromium with its own throwaway profile. The gate builds into
`packages/extension/dist-e2e/`, so it never touches the `~/.tab-hammer/dist` build your Chrome is
using.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup details and [AGENTS.md](AGENTS.md) for the
architecture.

## Repository layout

npm workspaces, one package per process:

- `packages/extension` — the Chrome extension (service worker, outline view, tests).
- `packages/mcp` — the MCP server an AI agent starts, and the native messaging host Chrome starts.
- `packages/protocol` — the message types both sides compile against.
- `docs/superpowers` — design specs and implementation plans written while building Tab Hammer
  (historical records, not necessarily current).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
