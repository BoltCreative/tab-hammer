# Chrome Web Store listing

Copy for the Chrome Web Store developer dashboard. The permission list here must match
`packages/extension/src/manifest.ts`; update both together.

## Single purpose

Tab Hammer shows all of your Chrome windows, tab groups, and tabs as one outline, in its own window
or docked in the side panel, so you can find, preview, rearrange, hibernate, and restore them.

## Short description (132 characters max)

Every window, group, and tab as a live outline in its own window. Preview, rearrange, hibernate,
and restore your tabs.

## Full description

Tab Hammer turns every Chrome window, tab group, and tab into one live outline, in a window of its
own. It's a spiritual successor to Tabs Outliner, built to fix its annoyances.

- **Float or dock.** Use it as its own window, or dock it in Chrome's side panel in every window.
- **See everything at once.** Every window and group as a section, every tab as a row, updated live
  as you browse. Search filters the outline as you type.
- **Preview before you switch.** Hover a tab to see a screenshot of how it looked the last time it
  was on screen. Capture missing fills in the ones you haven't looked at yet.
- **Rearrange by dragging.** Move tabs between windows and groups, multi-select with the keyboard
  or mouse, rename windows and groups.
- **Hibernate instead of hoarding.** Close a window or tab in Chrome but keep its rows in the
  outline, dimmed, ready to reopen with a click. Deleted rows go to Recently closed for seven days.
- **Survives restarts.** After Chrome restarts, restored windows re-link to their rows, names and
  all.
- **Your other computers and phones.** Optional sync through a hidden folder in your own Google
  Drive shows your other computers' outlines, with daily checkpoints you can roll back to. Your
  phone's open tabs show up through Chrome Sync.
- **Works with Claude Code.** An optional MCP server lets Claude Code list and organize your tabs.

No account, no server, no analytics. Your outline and previews stay in your browser.

## Category

Workflow & Planning (alternative: Tools).

## Permission justifications

### Required permissions

- **tabs:** Reads each open tab's title and address to build the outline, and moves, closes,
  activates, and opens tabs when the user does so from the outline.
- **tabGroups:** Shows tab groups in the outline, and renames, moves, and recreates them when the
  user does so from the outline (or asks Claude Code to, through the optional bridge).
- **storage:** Saves the user's settings (window position, preview panel size), sync bookkeeping,
  and the outcome of recent screenshot attempts.
- **favicon:** Shows each tab's icon from Chrome's own favicon cache, so no website is contacted
  to get it.
- **debugger:** Takes screenshots of background tabs, which `captureVisibleTab` can't do, using the
  DevTools protocol's `Page.captureScreenshot`. It is attached only while the user runs Capture
  missing or Refresh all from the Actions menu, to one tab at a time, and detached as soon as that
  tab's screenshot is taken; hovering a tab or browsing never attaches it. Chrome shows its "Tab
  Hammer started debugging this browser" bar whenever an extension attaches the debugger; that's a
  Chrome security notice the extension can't hide, and it goes away when the run ends. No other
  DevTools protocol command is used, and no page content is read. (Chrome doesn't allow `debugger`
  as an optional permission, so it has to be requested at install.)
- **nativeMessaging:** Connects to Tab Hammer's helper program for Claude Code, if the user has
  installed it, so Claude Code on the same computer can list and organize tabs. Without the helper
  installed, the connection attempt simply fails and nothing else happens.
- **system.display:** Reopens the Tab Hammer window on a screen that's still connected when the
  screen it was last on is gone.
- **webNavigation:** Records the first address each tab loaded, so that after Chrome restarts, the
  windows it restores can be matched back to their rows in the outline.
- **identity:** Signs in to the user's own Google Drive (`drive.appdata` scope only) for optional
  sync, through the Google account already signed in to Chrome. Nothing is requested until the
  user turns sync on.
- **alarms:** Checks the user's Drive every 5 minutes for their other computers' outlines.
- **sidePanel:** Shows the outline docked in Chrome's side panel, when the user chooses docked mode
  instead of the floating window.
- **contextMenus:** Adds "Side panel: left or right…" to the toolbar icon's right-click menu, which
  opens Chrome's own side-panel setting.

### Optional permissions

- **sessions:** Requested only when the user clicks "Show your phones and other Chrome Sync
  devices" in the devices panel. Reads the tabs open on the user's other signed-in devices (from
  Chrome Sync) to show them read-only, and reopens one on this computer when the user asks.

### Host permission: `<all_urls>`

Screenshots of the tab a window is showing (`chrome.tabs.captureVisibleTab`) require host access
to that page, and the user can have any site open. Screenshots are stored only on the user's
computer, are used only to show the tab preview panel, and are never uploaded. No content scripts
are injected and no page content is read. The user can withhold site access in Chrome; the outline
then shows a banner offering to grant it, and works without previews until then.

## Remote code

No, Tab Hammer does not use remote code. All JavaScript ships in the extension package; it loads no
external scripts, uses no `eval`, and fetches no code. Its only network requests are to Google's
Drive API, for the user's optional sync.

## Data usage

Check these categories in the dashboard's privacy tab:

- **Web history:** the titles and addresses of the user's open, hibernated, and recently closed
  tabs. Stored locally; copied to the user's own Google Drive app-data folder only if they turn on
  sync.
- **Website content:** screenshots of pages, used for tab previews. Stored only on the user's
  computer, never uploaded.

Leave the rest unchecked (personally identifiable information, health, financial, authentication,
personal communications, location, user activity).

Certify all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL: the GitHub Pages address of `docs/store/privacy-policy.md` (published at
`/privacy-policy/` by its front matter).

## Screenshots

1280×800 (preferred) or 640×400, PNG or JPEG, up to 5. Use a clean profile with realistic but
non-personal tabs (open-source project pages, documentation, news front pages), several windows and
a couple of named groups.

1. **The outline:** the Tab Hammer window beside a browser window, three or four windows with
   colourful section headers, a couple of tab groups, the preview panel showing a hovered tab.
2. **Previews:** the cursor resting on a tab, the preview panel below the outline showing its
   screenshot.
3. **Hibernate and restore:** a hibernated (dimmed) window and the Recently closed section open.
4. **Other devices:** the devices panel listing another computer and a phone, with a remote
   outline shown read-only.
5. **Search and rearrange:** the search box filtering to a few matches, or a multi-selection being
   dragged into another window.

## Promotional images

- **Small promo tile (required):** 440×280, PNG or JPEG. The Tab Hammer icon and name on a plain
  background, with a hint of the outline (window bars in their colours). Minimal text.
- **Marquee promo tile (optional):** 1400×560, PNG or JPEG. Only used if the store features the
  item. The outline window on one side, the name and one line ("Every tab, one outline") on the
  other.
- **Store icon:** 128×128 PNG, `packages/extension/icons/icon-128.png`.
