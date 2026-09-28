# Tab Hammer MVP — Live Tree View

**Date:** 2026-09-28
**Status:** Approved design, pending implementation plan

## Goal

A Manifest V3 Chrome extension that opens its own window and shows every open Chrome window, its tab groups, and its tabs as a live outline. Read-only apart from selection and double-click-to-activate. This is the foundation for later features that fix Tabs Outliner's annoyances.

## Out of scope (post-MVP)

- Persisting the tree, saved/closed windows, and re-associating windows after a restart or crash. Tabs Outliner marks the old window as "crashed" and shows Chrome's restored copy as a new window even when the tabs are identical. Fixing this is the first post-MVP feature.
- Moving, closing, or deleting tabs, windows, or groups, including drag and drop and acting on a multi-selection.
- Online backup.
- Notes, separators, search.
- Tracking which tab opened which. Tab Hammer will never nest a tab under the tab that opened it. The only hierarchy is window → tab group → tab.

## User experience

### Opening

- Clicking the toolbar icon opens Tab Hammer in its own browser window (`chrome.windows.create({ type: 'popup' })`), not a side panel.
- If a Tab Hammer window is already open, clicking the icon focuses it instead of opening a second one.
- The Tab Hammer window itself is excluded from the tree.

### Look: dark window cards

- Dark theme throughout.
- Each Chrome window is a card. The header shows `Window N`, the tab count, and "focused" if that window currently has focus. The focused window's card gets an accent border.
- Windows are listed in Chrome's `windows.getAll` order. `N` is the 1-based position in that list.
- Inside a card, tabs are listed in Chrome's tab order. Each row shows the favicon (with a neutral placeholder if there is none) and the title (the URL if there is no title), truncated with an ellipsis.
- Each Chrome tab group gets a header row: a disclosure arrow, a color dot, the group title (or "Untitled group"), and the tab count, all in the group's Chrome color. The group's tabs are indented beneath it with a left rule in the group color.
- Group collapsed/expanded state mirrors Chrome's `collapsed` flag. Clicking the arrow in Tab Hammer toggles the display only; it does not change Chrome's group.
- Window cards can be collapsed and expanded with a disclosure arrow in the header. This is display-only.
- Each window's active tab is highlighted. Discarded (sleeping) tabs are dimmed.

### Interaction

- **Single click** selects a row (window header, group header, or tab) and clears any other selection.
- **Cmd-click** (Ctrl-click on Windows/Linux) toggles a row in or out of the selection.
- **Shift-click** selects the range of visible rows from the last clicked row to this one.
- **Double-click on a tab** makes it the active tab in its window (`tabs.update({active:true})`) and brings that window to the front (`windows.update({focused:true})`).
- **Double-click on a window header** brings that window to the front.
- Selection lives in the view only and is not saved. It is the groundwork for multi-select move later.

### Live updates

The view stays in sync with Chrome. These events trigger a refresh:

- tabs: `onCreated`, `onRemoved`, `onUpdated`, `onMoved`, `onAttached`, `onDetached`, `onActivated`, `onReplaced`
- windows: `onCreated`, `onRemoved`, `onFocusChanged`
- tabGroups: `onCreated`, `onUpdated`, `onRemoved`, `onMoved`

Refreshes are coalesced: a burst of events causes one re-query (next animation frame) rather than one query per event. Selection survives refreshes: selected IDs that still exist stay selected, and IDs that have disappeared are dropped.

## Architecture

```
toolbar click ──► service worker ──► open or focus the Tab Hammer popup window
                                          │
                   Tab Hammer page (React) ◄┘
                     ├─ chromeSource: queries windows/tabs/groups + subscribes to events
                     ├─ buildTree (pure): raw Chrome data ──► view model
                     ├─ selection (pure reducer): click / toggle / range over visible rows
                     └─ components: WindowCard, GroupRow, TabRow
```

- **Service worker** (`src/background/`): only handles `action.onClicked`. It stores the Tab Hammer window ID in `chrome.storage.session` so it can focus the existing window, or create one if that window is gone. It keeps no other state, so being terminated after about 30s idle is harmless.
- **chromeSource** (`src/view/chrome/`): the only module that touches `chrome.*` from the page. It exposes `snapshot()` → `{ windows, tabs, groups }` and `subscribe(onChange)`, plus `activateTab(tabId, windowId)` and `focusWindow(windowId)`.
- **buildTree** (`src/model/`): a pure function from the raw snapshot plus the Tab Hammer window ID to `WindowNode[]`. `WindowNode` holds `children: (GroupNode | TabNode)[]`; `GroupNode` holds `tabs: TabNode[]`. It groups consecutive tabs by `groupId`. Chrome keeps group tabs contiguous, but buildTree must not assume that: if tabs of the same group are split apart, each run gets its own `GroupNode`. It excludes the Tab Hammer window and flags the focused window, active tabs, and discarded tabs. Nodes carry Chrome IDs for now. When persistence arrives, it will introduce Tab Hammer's own stable node IDs, because Chrome's window and tab IDs change across restarts.
- **selection** (`src/model/`): a pure reducer over the flattened list of visible row keys (for example `w:12`, `g:5`, `t:301`). It handles `click`, `toggle`, `range`, and `prune(existingKeys)`, and ranges only span rows that are visible (not inside collapsed nodes).
- **Components** (`src/view/components/`): WindowCard, GroupRow, TabRow, each well under 200 lines. Styling uses CSS custom properties for the dark palette and maps Chrome's group colors (`grey, blue, red, yellow, green, pink, purple, cyan, orange`) to fixed hex values that read well on dark.

### Manifest

MV3. Permissions: `tabs` (titles and URLs), `tabGroups`, `storage`, `favicon` (favicons via `chrome-extension://<id>/_favicon/?pageUrl=…&size=16`). `action` has no popup, so `onClicked` fires. There are no host permissions and no content scripts.

## Stack and tooling

- TypeScript (strict), React 19, Vite with `@crxjs/vite-plugin` (the same approach as chatgpt-image-downloader), npm.
- ESLint (flat config) and Prettier.
- Vitest for pure-model unit tests. Playwright for end-to-end tests against a real Chromium with the built extension loaded.

## Testing

- **Unit (Vitest):** tests for `buildTree` and `selection`, because these contain the real edge cases:
  - ungrouped tabs mixed with grouped ones
  - a split group run
  - collapsed groups
  - the Tab Hammer window excluded
  - missing titles or favicons
  - range selection across a collapsed node
  - pruning after a tab closes
- **E2E (Playwright):** load the built `dist/` into Chromium with a persistent context (`--load-extension`). Open two windows, several tabs, and a tab group, open the Tab Hammer page, and assert that the cards, group row, and tabs render. Then close a tab and assert that it disappears (the live update). Then double-click a tab in the other window and assert that Chrome's active tab and focused window change. Tests wait on concrete conditions, never sleeps.
- **Completion gate:** `npm run gate` = typecheck + lint + format check + unit + build + e2e. It runs headless by default and is recorded in CLAUDE.md's gate table.

## Error handling

- `chrome.*` calls that reject (for example activating a tab that closed a moment ago) are caught; the view does a refresh and does not surface an error.
- If a favicon fails to load, the row falls back to the placeholder.
