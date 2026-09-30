# Tab Hammer

Tab Hammer is a Manifest V3 Chrome extension that opens its own window and shows every open
Chrome window, tab group, and tab as a live outline — a spiritual successor to Tabs Outliner,
built to fix its annoyances. It's read-only apart from selection and double-click-to-switch: there's
no moving, closing, or renaming from Tab Hammer (yet).

Key features:

- **Its own window** — a dedicated outline window, not a side panel, that stays out of your way.
- **A live outline** of every window, tab group, and tab, kept in sync as you browse.
- **Multi-select** — click, Cmd/Ctrl-click, and Shift-click a range, groundwork for future
  bulk actions.
- **Double-click a tab** to bring it to the front — the fastest way to jump across windows.
- **Hover previews**, including on-demand screenshots of tabs you haven't looked at yet, so you
  can see what a background tab is before switching to it.
- **Clear previews**, a one-click way to wipe every stored screenshot and start fresh.

## Install from source

```
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → select the
`dist/` folder. Click the toolbar icon to open Tab Hammer.

## Development

```
npm run dev
```

This starts a dev server that rebuilds `~/.tab-hammer/dist` on save (set `TAB_HAMMER_DEV_DIR` to
use another folder). Load that folder once, the same way as above; after that, most changes — to
the view or the service worker — reload the running extension automatically, so you don't need to
click "Reload" in `chrome://extensions` for everyday edits.

Every checkout and worktree's dev server writes that same folder, and the manifest's fixed `key`
gives the extension the same ID wherever it's built, so storage, previews, and permission grants
carry over. To test a different tree, stop `npm run dev` and start it in the other tree: the
running extension reloads itself onto the new build. In Skullet, that's one command:

```
skullet-cli wiring create tab-hammer dev tab-hammer=worktree:<name>   # or tab-hammer=root
```

Before calling anything done, run the completion gate:

```
npm run gate
```

This runs the typechecker, linter, formatter check, unit tests, and the end-to-end Playwright
suite. The gate builds the extension into `dist-e2e/` (a separate output directory) rather than
`~/.tab-hammer/dist`, so running it never clobbers the build your `npm run dev` server and Chrome
are using.

## Permissions

Chrome shows these permissions when you install Tab Hammer; here's why each is needed:

- **`tabs`** — read every window's tabs (title, URL, status) to build the outline.
- **`tabGroups`** — read tab groups (title, color, collapsed state) to render group headers.
- **`storage`** — remember which window is Tab Hammer's own, and hold capture outcomes, in
  `chrome.storage`.
- **`favicon`** — show each tab's favicon in the outline.
- **`<all_urls>`** (a host permission) — `tabs.captureVisibleTab` needs host access to the page
  it's capturing, for hover previews.
- **`debugger`** — on-demand previews of background tabs, via the Chrome DevTools Protocol (see
  below).

**Privacy notes:**

- Incognito windows and tabs are never captured or stored.
- Previews are stored locally, in your browser's IndexedDB, keyed by page URL (not by tab), so a
  page reopened later or open in several tabs shares one shot.
- Previews older than 30 days are dropped, and the store is capped at 1000 entries (oldest evicted
  first).
- Previews are **not** cleared by Chrome's "Clear browsing data" — use Tab Hammer's own **Clear
  previews** button (in its header) to wipe them.

## Hiding Chrome's debugging banner

When Tab Hammer captures a preview of a tab you haven't looked at, it briefly attaches Chrome's
debugger to take the screenshot. While attached, Chrome shows a "\<extension\> started debugging
this browser" banner — it's unavoidable for any extension using the debugger, even for a fraction
of a second.

You can hide it by launching Chrome with the `--silent-debugger-extension-api` flag. The
trade-off: this suppresses the banner for **every** extension that uses the debugger, not just Tab
Hammer — for example, Claude in Chrome. Weigh that before turning it on.

To use the flag:

1. Quit Chrome completely (⌘Q) — the flag only takes effect on a fresh launch, and the Dock's
   normal "Quit" from a running Chrome doesn't get you there if you then reopen it normally.
2. The macOS Dock can't pass launch flags to an app, so build a small launcher app instead:
   ```
   npm run make:chrome-launcher
   ```
   This creates **Google Chrome silent debugger.app** in `~/Applications` (pass a different
   directory as an argument if you'd rather put it elsewhere). Drag it into the Dock.
3. Launch Chrome from that Dock icon from now on, instead of Chrome's own icon.

This isn't a separate copy of Chrome — it launches your normal Chrome, with the same profile,
extensions, and everything else, just with one extra flag. There's nothing to migrate.

To undo it, just launch Chrome normally (its own Dock icon, Spotlight, etc.) instead of the
launcher — no flag, no banner-hiding, nothing to uninstall.
