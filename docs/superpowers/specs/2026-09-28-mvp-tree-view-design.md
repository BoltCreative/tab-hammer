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
- Each Chrome window is a card. The header shows `Window N` and the tab count. The window that was most recently focused other than Tab Hammer itself (Tab Hammer's own window has focus whenever it is in use) is marked by bright, bold text on its header and on its active tab, plus an accent border on its card. Other windows' headers use regular text.
- Windows are listed in Chrome's `windows.getAll` order. `N` is the 1-based position in that list.
- Inside a card, tabs are listed in Chrome's tab order. Each row shows the favicon (with a neutral placeholder if there is none) and the title (the URL if there is no title), truncated with an ellipsis.
- Each Chrome tab group gets a header row: a disclosure arrow, a color dot, the group title (or "Untitled group"), and the tab count, all in the group's Chrome color. The group's tabs are indented beneath it with a left rule in the group color.
- Group collapsed/expanded state mirrors Chrome's `collapsed` flag. Clicking the arrow in Tab Hammer toggles the display only; it does not change Chrome's group. That local choice holds until Chrome's own `collapsed` flag for the group changes; then it is discarded and the view mirrors Chrome again.
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

- **Service worker** (`src/background/`): handles `action.onClicked` and captures hover previews (see [Hover preview](#hover-preview)). It stores the Tab Hammer window ID in `chrome.storage.session` so it can focus the existing window, or create one if that window is gone. Previews live in IndexedDB; the only in-memory state is the capture debounce/queue, so being terminated after about 30s idle costs at most a pending capture.
- **chromeSource** (`src/view/chrome/`): the only module that touches `chrome.*` from the page. It exposes `snapshot()` → `{ windows, tabs, groups, selfWindowId, lastFocusedWindowId }` and `subscribe(onChange)`, plus `activateTab(tabId, windowId)` and `focusWindow(windowId)`.
- **buildTree** (`src/model/`): a pure function from the raw snapshot plus the Tab Hammer window ID to `WindowNode[]`. `WindowNode` holds `children: (GroupNode | TabNode)[]`; `GroupNode` holds `tabs: TabNode[]`. It groups consecutive tabs by `groupId`. Chrome keeps group tabs contiguous, but buildTree must not assume that: if tabs of the same group are split apart, each run gets its own `GroupNode`. A group's first run is keyed `g:<groupId>` and later runs `g:<groupId>#2`, `#3`, …, so the key survives the group's first tab closing or moving. It excludes the Tab Hammer window and flags the last-focused window (tracked by chromeSource from `windows.getLastFocused` and `windows.onFocusChanged`, ignoring Tab Hammer's own window), active tabs, and discarded tabs. Nodes carry Chrome IDs for now. When persistence arrives, it will introduce Tab Hammer's own stable node IDs, because Chrome's window and tab IDs change across restarts.
- **selection** (`src/model/`): a pure reducer over the flattened list of visible row keys (for example `w:12`, `g:5`, `t:301`). It handles `click`, `toggle`, `range`, and `prune(existingKeys)`, and ranges only span rows that are visible (not inside collapsed nodes).
- **Components** (`src/view/components/`): WindowCard, GroupRow, TabRow, each well under 200 lines. Styling uses CSS custom properties for the dark palette and maps Chrome's group colors (`grey, blue, red, yellow, green, pink, purple, cyan, orange`) to fixed hex values that read well on dark.

### Manifest

MV3. Permissions: `tabs` (titles and URLs), `tabGroups`, `storage`, `favicon` (favicons via `chrome-extension://<id>/_favicon/?pageUrl=…&size=16`), `debugger` (on-demand hover previews of background tabs, see [Hover preview](#hover-preview)). `action` has no popup, so `onClicked` fires. Host permissions: `<all_urls>`, which `tabs.captureVisibleTab` needs for hover previews. There are no content scripts.

## Hover preview

Resting the pointer on a tab row for 400ms opens a floating card showing the page's last screenshot (if one exists), its title, URL, and "Last viewed …" (relative, from `tab.lastAccessed`). With no screenshot the card is text-only. The card spans the window width minus an 8px margin and sits below the row, or above it if it doesn't fit, always inside the window. It closes on leaving the row, any scroll, any mouse press, window blur, or when the tree changes under it: the order of visible rows in any window (tabs added, removed, or moved, or a window or group collapsed) or the hovered tab's URL. Title changes update the card in place instead, so pages with ticking titles don't keep closing it. It has `pointer-events: none`, so click, cmd/shift-click, and double-click behave exactly as without it. The rows' native `title` tooltip was removed so it doesn't compete with the card; instead each tab row's `aria-label` carries its title and URL, and while the card is open the row points at it with `aria-describedby`. Since Chrome can leave the `<all_urls>` host permission ungranted (an unpacked reload doesn't always re-grant it, and the user can withhold or revoke site access at any time), the view shows a slim banner — "Hover previews need access to all sites." with an "Allow previews" button — whenever that permission is missing, and hides it the moment the permission is granted.

**Capture (service worker).** `tabs.captureVisibleTab` can only screenshot the tab currently showing in a window, so the service worker captures as the user browses (background tabs are captured on demand instead, see below): on `tabs.onActivated`, `tabs.onUpdated` with `status: 'complete'` on an active tab, `windows.onFocusChanged`, and `tabs.onReplaced` (when the new tab is active). Listeners are registered synchronously at top level.

- A pure scheduler (`src/background/captureScheduler.ts`) debounces per window (500ms after the last trigger, so the page has painted) and runs captures one at a time, at least 550ms apart (Chrome allows 2 calls per second). A failed capture is swallowed; it just means no preview. The one exception is Chrome's `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota error, which re-triggers that window once through the scheduler.
- Skipped: incognito windows and tabs (never captured or stored, since previews persist on disk; incognito tabs are filtered at the event too, so they don't spend the rate budget), minimized windows, non-`normal` windows (Tab Hammer's own window is a popup, and its stored ID is checked too), tabs not yet `complete`, and URLs Chrome won't let extensions capture. Only `http:`, `https:` and `file:` are attempted; `chrome://`, extension pages, `about:`, `view-source:`, `devtools:`, the Chrome Web Store, and `data:` (refused even with `<all_urls>`) are not.
- After capturing, the window's active tab is re-read; if it switched tabs, navigated, started loading, or went to another tab and back (a changed `lastAccessed`) meanwhile, the shot is discarded rather than mislabeled.
- The JPEG is downscaled to 640px wide (about 2× the card's width, for Retina) (`createImageBitmap` + `OffscreenCanvas`) and stored.

**On-demand capture of background tabs (service worker, `src/background/debuggerCapture.ts`).** Tabs the user never looks at would otherwise never get a preview. When the hover card opens for a tab with no preview, or one older than 10 minutes (`wantsOnDemandCapture` in `src/shared/previewPolicy.ts`; the lookup is by the tab's current URL, so a preview of another page never counts), the view sends the service worker a `tabHammer.captureTab` runtime message. The service worker replies once the capture has finished, with its outcome.

- It attaches `chrome.debugger` to the tab (protocol 1.3) and calls CDP `Page.captureScreenshot` with `{ format: 'jpeg', quality: 70, fromSurface: true, captureBeyondViewport: false }`; Chrome draws a background tab offscreen for it, in normal and minimized windows alike. (`fromSurface: false` is refused: "Only screenshots from surface are allowed".) The shot is then downscaled and stored under the tab's URL like any other, and the outcome recorded per tab.
- While attached, Chrome shows its "Tab Hammer started debugging this browser" infobar. So the attach → screenshot → detach sequence is kept minimal: the debugger detaches the moment the screenshot data arrives (or fails, or times out after 5s), before anything is decoded or saved.
- A minimized window never draws its active tab, so its screenshot would time out. For that tab, the service worker first activates a stand-in in that window (the nearest tab by index that isn't discarded, which activating would reload, and isn't in a collapsed group, which activating would expand for good; if there is none, a temporary `about:blank` tab), captures the target as a background tab, then undoes the swap in a `finally`, so even after a failure. The user doesn't see this, since the window is minimized.
  - The undo doesn't fight the user: it reactivates the target only if the stand-in (or an unused temporary tab) is still the window's active tab, and removes the temporary tab only if it is still an inactive (after that reactivation) `about:blank` tab. A tab the user switched to or navigated stays.
  - Before swapping, the service worker saves a swap record `{ windowId, targetId, standInId?, blankId?, knownTabIds, at }` in `chrome.storage.local` (`src/shared/captureSwap.ts`) and clears it after the undo. On startup, it finishes the undo of any leftover record by the same rule (the worker may have died mid-swap), and detaches any debugger session a previous worker left attached (`chrome.debugger.getTargets`; detaching only ends our own sessions).
  - The view reads the record and leaves out of the tree any tab that appeared in that window after the swap began (the temporary tab), ignoring records older than 30s, so the tree and the hover card over it don't change during the capture, and the card shows the new shot. The stand-in's activation only changes which tab is active, which the card doesn't depend on.
- The visible tab of a non-minimized window doesn't need the debugger (or its infobar): it goes through the regular `captureVisibleTab` scheduler instead, and the reply waits for that capture.
- Skipped, with the reason recorded: no `debugger` or `<all_urls>` permission, discarded (sleeping) tabs (attaching would reload them; the view doesn't ask for these at all), incognito tabs and windows, tabs still loading, non-capturable URLs (same rule as above), non-`normal` windows, and Tab Hammer's own window. Attach errors (another debugger, such as DevTools, is already attached) and screenshot errors (Chrome may answer "Internal error" for a tab it had frozen) are recorded as failures. If the tab navigated during the capture, the shot is dropped.
- Captures run through one queue (`src/background/captureQueue.ts`), one at a time. Repeated requests for a tab that is waiting or in flight share its result, and at most 3 wait: hovering down a list drops the oldest waiting requests (outcome `skipped:superseded`), since those cards have closed. A run that hasn't finished after 15s (a Chrome call that never settles) is given up on so it can't jam the queue; its abort signal makes it detach at once if its attach resolves later.
- After a failed capture (an `error:` outcome), requests for that tab within 60s get that failure back without attaching again, so re-hovering a tab DevTools is attached to doesn't flash the infobar each time.
- The card shows "Capturing preview…" while it waits (over the old image, if it has one), then swaps in the new shot if it is still open for that tab. If the capture didn't produce one, a card without an image shows the usual "No preview yet · last capture: …" line, from the tab's own outcome if it has one (it is about this very tab), else its window's.

**Store (`src/shared/previewStore.ts`).** IndexedDB, one record per page: `{ key, capturedAt, image: Blob, width, height }`. The key is the page URL with its `#fragment` dropped (query kept), not the tab ID, so previews survive a browser restart (tab IDs are reassigned; restored and discarded tabs keep their URLs) and tabs on the same page share the latest shot. Nothing is deleted when a tab closes, since the page may be open elsewhere or reopened. Instead, entries older than 30 days are dropped and the store is capped at 1000 entries, evicting the least recently captured (`pickEvictions` in `src/shared/previewPolicy.ts`). Pruning reads keys only (via a `capturedAt` index) and deletes in the same transaction, so a shot written meanwhile can't be evicted by mistake. It runs on browser startup, on the first write of each service-worker lifetime (the worker is killed after ~30s idle, so this applies the age limit regularly), and whenever a write takes the store over its cap. The IndexedDB connection closes on `versionchange` and is reopened on next use. The view reads the store directly by the tab's current URL.

**Outcomes (`src/shared/captureOutcomes.ts`).** `chrome.storage.session` holds the latest outcome per window (`captureOutcomes`, from visible-tab captures) and per tab (`tabCaptureOutcomes`, from on-demand captures), each capped at the 20 newest entries.

## Stack and tooling

- TypeScript (strict), React 19, Vite with `@crxjs/vite-plugin` (the same approach as chatgpt-image-downloader), npm.
- ESLint (flat config) and Prettier.
- Vitest for pure-model unit tests. Playwright for end-to-end tests against a real Chromium with the built extension loaded.

## Testing

- **Unit (Vitest):** tests for `buildTree` and `selection`, because these contain the real edge cases (plus, for hover preview: the capture scheduler's debounce/rate limit, the URL skip rules, the per-window capture with an injected `chrome` (incognito/minimized skips, the after-capture check, quota retry), the on-demand tab capture with an injected `chrome` (every skip rule; detach even when the screenshot fails or times out, and before decoding or saving; the minimized-window swap and its undo on failure, when the user switched tabs or navigated the temporary tab mid-capture, and crash recovery; the failure cooldown; which tabs the view hides during a swap; visible tabs routed to `captureVisibleTab`), the capture queue (serializes, dedupes, drops the oldest waiting, gives up on a hung run), the prune policy, the card's close-on-change signature, and card placement):
  - ungrouped tabs mixed with grouped ones
  - a split group run
  - collapsed groups
  - the Tab Hammer window excluded
  - missing titles or favicons
  - range selection across a collapsed node
  - pruning after a tab closes
- **E2E (Playwright):** load the built `dist/` into Chromium with a persistent context (`--load-extension`). Open two windows, several tabs, and a tab group, open the Tab Hammer page, and assert that the cards, group row, and tabs render. Then close a tab and assert that it disappears (the live update). Then double-click a tab in the other window and assert that Chrome's active tab and focused window change. For hover preview: open a window on an http page (served by Playwright routing), poll until the service worker has stored its preview, hover its row and assert the card shows the image, hover a background tab on the same URL (different fragment) and assert it shares the image, and hover an uncapturable (`about:blank`) tab and assert a text-only card. Hover a background tab that was never shown and assert the card shows an on-demand capture while the tab stays in the background. (Headless Chromium ignores the minimized window state, so the minimized-window swap is covered by unit tests only.) Tests wait on concrete conditions, never sleeps.
- **Completion gate:** `npm run gate` = typecheck + lint + format check + unit + build + e2e. It runs headless by default and is recorded in CLAUDE.md's gate table.

## Error handling

- `chrome.*` calls that reject (for example activating a tab that closed a moment ago) are caught; the view does a refresh and does not surface an error.
- If a favicon fails to load, the row falls back to the placeholder.
