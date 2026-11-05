# Persist the outline and re-link restored windows

**Date:** 2026-11-03
**Tickets:** SKULL-811 (persist the outline with Tab Hammer's own node IDs), SKULL-822 (re-link restored windows after a restart or crash)
**Status:** Agreed in brainstorm, pending implementation plan

## Why

Today the outline only mirrors live Chrome state. Nothing survives a window closing, and nothing can carry structure (names, hibernated tabs) across a browser restart, because Chrome's window and tab IDs change across restarts and get reused.

The user's top annoyance with Tabs Outliner: after a restart or crash, the old window is marked "crashed" and the window Chrome restores shows up as a brand-new duplicate, even when its tabs are identical. Tab Hammer must instead recognize the restored window and keep it in its original row, with its name and structure, and no duplicate.

The longer-term direction is hibernating windows and tabs within a window. This work lays that foundation.

## Goals

- Every window, group, and tab in the outline has a stable Tab Hammer ID, persisted, with Chrome IDs attached only while it is live.
- **Hibernate** a window or tab: close it in Chrome but keep its row (dimmed) in the outline. Reopen it later.
- **Trash** ("Recently closed"): closed windows land here for 7 days, so an accidentally closed window can be recovered.
- **Re-link** windows Chrome restores (after quit, crash, or Cmd+Shift+T) to their existing rows instead of showing them as new windows.
- **Rename** a window.
- A hover toolbar (edit / trash / hibernate) on the row under the mouse.

## Non-goals

- Tab notes, tab renaming, separators. (Edit renames windows only.)
- Online backup (SKULL-814). The storage shape just has to make it easy.
- Keeping single closed tabs in the trash. Chrome's Cmd+Shift+T covers those.
- Hibernated rows in the MCP bridge. `list_tabs` and the other bridge commands stay live-only.

## Anti-goals

- A restart or crash must never produce a duplicate window or a "crashed" copy of one Chrome restores.
- A window the user closed by hand must not stay in the main outline.
- Nothing is silently lost: anything that disappears without the user asking goes to the trash or stays hibernated.

## Lifecycle (decided with the user)

A window row is in one of three states: **live** (attached to a Chrome window), **hibernated** (in the outline, dimmed, no Chrome window), or **trashed** (in Recently closed, with a `closedAt` time).

| Event | Result |
|---|---|
| User closes a Chrome window (any way: Chrome's close button, Tab Hammer's trash button, closing its last tab) | Window → trash. |
| Chrome quits or crashes | Windows open at shutdown → trash at the next launch, marked as open-at-shutdown. Each one that Chrome restores is re-linked and leaves the trash. Ones Chrome doesn't restore stay in the trash. |
| User closes a single tab in a live window | Tab row removed (not kept). |
| Hibernate on a live window | Chrome window closed; row stays, hibernated, with all its tabs hibernated. |
| Hibernate on a live tab | Chrome tab closed; row stays in its window at its position, dimmed. If it was the window's last live tab, the whole window becomes hibernated (not trashed). |
| Trash on a live window | Closes it in Chrome → trash. |
| Trash on a hibernated window | → trash. |
| Trash on a live tab | Closes the tab (gone). |
| Trash on a hibernated tab | Deleted. |
| Trash entry older than 7 days | Deleted. |
| Open (double-click / Enter) a hibernated window | Reopens the whole window in Chrome, tabs in their saved order, groups recreated; the row goes live. Every tab loads right away (no lazy loading). The window reopens at its last position and size (or maximized/fullscreen if it was); if Chrome rejects those bounds, it opens at Chrome's default. |
| Open a hibernated tab whose window is hibernated | Opens a Chrome window with just that tab, at the window's last position and size; the window row goes live, its other tabs stay hibernated inside it. |
| Open a hibernated tab whose window is live | Opens the tab in that window at its row's position. |
| Open a hibernated window whose window is already partly live | Opens all its hibernated tabs into that Chrome window, at their positions. |
| Open a trash entry | Reopens the whole window at its last position and size; it moves back into the outline (at the bottom). |

**Windows holding hibernated tabs never go to the trash implicitly** (builder's call, following "nothing is silently lost"). Closing the last live tab of such a window, or closing the window itself in Chrome, makes it hibernated instead. On a fresh launch, a window that was partly live at shutdown becomes hibernated, marked as open-at-shutdown, rather than trashed. Only the Trash button sends it to the trash.

The key distinction, "closed by hand" vs "Chrome quit", cannot be read from Chrome directly. It falls out of the design: everything closed goes to the trash, and restore matching pulls windows back out of it. A window closed by hand isn't restored by Chrome, so it stays in the trash.

## Look

- Hibernated windows, groups, and tabs are the same rows, dimmed. No timestamp. No other visual change to rows, because another session is restyling rows (SKULL-838) in parallel.
- Window rows show the custom name if set, else `Window N` as today.
- The outline list has generous empty space below its last row (40% of the window height), so the bottom rows, Recently closed included, can be scrolled up away from the window's bottom edge.
- **Recently closed** is a collapsible section at the bottom of the outline list (inside the scrolling list, collapsed by default), showing its count. Each entry is a window row (name or first tab's title, tab count); expanding an entry shows its tabs. Entries are newest first.
- **Hover toolbar:** when the mouse is over a window or tab row (live, hibernated, or in the trash), small icon buttons appear at the row's right edge, overlaid on it, without changing the row's layout:
  - Window rows: Edit (rename), Hibernate (live only), Trash.
  - Tab rows: Hibernate (live only), Trash.
  - Trash entries: Restore, Delete forever.
- **Rename:** Edit turns the window's label into an inline text field. Enter saves, Escape cancels, and an empty name clears back to `Window N`.
- Keyboard: Delete/Backspace on selected rows = Trash. Enter/double-click on a hibernated row = Open.
- Search covers hibernated rows too (not the trash). Duplicate detection stays live-only.
- **Drag and drop works on hibernated rows** (agreed with the user). Moving a hibernated tab or group is only a change in the outline; Chrome isn't involved. A mixed drag, such as a window or a selection holding both kinds, moves its live tabs in Chrome and its hibernated tabs in the outline, keeping their relative order. Live tabs dropped into a hibernated window are hibernated there: closed in Chrome, kept as rows in that window. Trash entries aren't drag targets.

## Re-linking restored windows (SKULL-822)

### When matching runs

Each Chrome window that the outline doesn't already know (one Tab Hammer didn't open itself, and didn't get by a tab being dragged out into a new window) is a **matching candidate**. It's matched once its tabs settle: no tab created, removed, or moved in that window for a short quiet period, about 1.5s (an injectable timer in tests). This covers startup restore, a late "Restore pages?" click after a crash, and Cmd+Shift+T reopening a closed window, which then comes back out of the trash. Until it settles, the new window shows as an ordinary new window. On a match, that provisional row is replaced by the matched row, in the matched row's position.

### What it matches against

Windows the user hibernated aren't matched: they were put away deliberately. Only these are:
- Windows marked open-at-shutdown (preferred): trash entries, or windows that were partly live and so became hibernated.
- Any other trash entry.

A saved window is scored only against the tabs that were **live at shutdown** (or at close, for trash entries). Its hibernated tabs don't count: Chrome never restores them, so counting them would make every partly hibernated window look like a poor match. The open-at-shutdown mark stays until the window is matched or the user acts on it.

### Which address each tab is compared on

Each tab's **launch URL** is the address Chrome created or restored it with. It's captured from `chrome.webNavigation` (the first committed navigation in that tab) and from `tabs.onCreated`'s `url`/`pendingUrl`, whichever arrives first. The launch URL is captured when those events reach the worker. When they don't (for example the worker starts after Chrome has restored the tabs), matching falls back to each tab's current URL, exact or loose (host and path). That still handles tabs that haven't loaded and error-page tabs; a redirected tab (an expired login, a Cloudflare challenge) then only lowers its score.

`webNavigation` is a new permission. Builder: confirm it doesn't add an install warning beyond the existing `history` warning ("Read and change your browsing history"). If it would, fall back to `tabs.onCreated` alone and note it as a deviation.

### Scoring

1. **Normalize** a URL: drop the `#fragment`, the trailing slash, and the `www.` prefix, and treat `http` as `https`.
2. **Tab match:**
   - Exact if any of the restored tab's URLs (launch or current) equals the saved tab's normalized URL.
   - Loose if the host and path agree and only the query differs (a challenge or tracking parameter).
   - Otherwise no match. Exact scores 1, loose scores 0.75.
3. **Window score:** the best ordered alignment of the two tab lists, a weighted longest-common-subsequence over tab matches, divided by the longer list's length. Order matters, but inserted or removed tabs only cost their own share.
4. **Threshold:** the score must be at least 0.6. A window with a single tab on either side must match exactly. Windows whose tabs are all new-tab or blank pages are never candidates.
5. **Assignment:** score every restored window against every candidate, then assign pairs in descending score order, each window and candidate used at most once. Ties go first to open-at-shutdown candidates, then to the most recently live (`lastLiveAt`). Identical windows are interchangeable, so a tie can't mislink anything that matters.
6. Below the threshold, the restored window stays a new window.

### Applying a match (partial matches)

The matched row goes live with the restored window's Chrome ID:
- Restored tabs aligned to saved tabs keep those rows (IDs, and any group membership the row had, re-attached to the live group).
- Restored tabs with no aligned saved tab become new rows at their live positions.
- Saved tabs that weren't restored stay in the window as hibernated rows, at their saved position relative to their neighbors.
- Groups: a restored Chrome group re-attaches to the saved group row containing most of its tabs; otherwise it's a new group row.

The matching is pure, unit-tested code with no `chrome.*` (see Tests).

## Model and storage (SKULL-811)

These are the builder's calls, agreed in outline with the user.

- **Service worker owns the outline.** It keeps it in memory, persists every change to IndexedDB, and rebuilds from IndexedDB when the worker restarts. It then **reconciles** with what Chrome has open:
  - Known Chrome windows and tabs re-attach by their Chrome IDs, which are valid within one browser session.
  - Live rows whose Chrome window has vanished go to the trash (a missed close).
  - Unknown Chrome windows become matching candidates.
  - Chrome IDs are only trusted within one browser session. The existing `browserSession` module tells a fresh browser launch from a worker restart. On a fresh launch, every row still marked live goes to the trash, marked as open at shutdown, and becomes a matching candidate.
- **Node shape** (sketch; the builder may adjust names):
  - `WindowRec { id, name?, state: 'live'|'hibernated'|'trashed', chromeWindowId?, closedAt?, openAtShutdown?, lastLiveAt, children: (GroupRec|TabRec)[] }`
  - `GroupRec { id, chromeGroupId?, title, color, collapsed, tabs: TabRec[] }`
  - `TabRec { id, chromeTabId?, url, title, launchUrl?, ... }`
  - IDs are random (`crypto.randomUUID()`), never Chrome IDs.
  - A tab is live when it has `chromeTabId`. A group is live when any of its tabs is.
  - The window record holds its children inline, in outline order (live and hibernated interleaved).
- **Sync-ready** (later: the outline shared across several computers; no sync in this PR). IDs are globally unique UUIDs. Each window records the install it came from (a per-install ID in `chrome.storage.local`). Every window, group, and tab records its own last-modified time, so a later sync can merge per record instead of overwriting. Live Chrome IDs and other machine-local fields (such as each window's last screen bounds, which don't stamp its modified time) are left out of the export.
- **Ordering:** live tab order follows Chrome. A hibernated tab keeps its place relative to the neighbors it had when it was hibernated, so it stays between the same tabs. Outline window order is persistent: new windows go to the bottom, windows keep their position when hibernated, and restored windows take their old position.
- **IndexedDB:** a new database (separate from previews), one object store of window records keyed by `id` (trashed windows included), plus a `meta` record (`schemaVersion`, the browser session ID the Chrome IDs belong to). An `exportOutline()` function returns `{ schemaVersion, windows }` as plain JSON; SKULL-814 serializes this.
- **Reconcile strategy:** the worker reacts to Chrome's events by re-querying Chrome (coalesced), and diffs the result against the outline. The few events that carry intent are handled explicitly: window removed, tab removed, tabs created by Tab Hammer's own reopen, and a tab detaching into a new window.
- **View:** the view stops building the tree from Chrome directly. It connects to the worker with a `chrome.runtime` port and receives the outline (plus the live details it renders today: active, discarded, last accessed, focused window) on every change. `buildTree`'s job becomes turning that into the existing `WindowNode` / `GroupNode` / `TabNode` view model, now keyed by Tab Hammer IDs and with optional Chrome IDs and a `hibernated` flag. Commands (hibernate, trash, open, rename, delete) go to the worker as runtime messages. Existing direct Chrome actions (activate, move, close) keep working against live Chrome IDs.

## Tests

- **Unit (model, pure):**
  - Matching heuristic: exact, reordered, tabs added or removed, redirect via the launch URL, loose query match, single-tab exact-only, new-tab-only windows excluded, ties, multiple windows assigned at once, below threshold.
  - Reconcile: worker restart, fresh launch, missed close, hibernated tab ordering, partial match application, group re-attach.
  - Lifecycle operations and trash expiry.
- **E2E (real Chromium, headless):**
  - Hibernate a window and reopen it (order and groups intact).
  - Hibernate a single tab, then open just it, then the rest.
  - Close a window → it's in Recently closed → restore it.
  - Rename survives a service-worker restart.
  - **Restart:** launch with a real temp profile, build windows, close the context, relaunch the same profile with session restore (`--restore-last-session` or the restore-on-startup pref). Assert the restored windows re-linked to their original rows (same Tab Hammer IDs, names kept, no duplicates, nothing left in the trash). Builder's call: if headless Chromium can't restore a session reliably, simulate the restart instead. Drive the worker's fresh-launch path, then have the test open windows with the same URLs the way a restore would. Note it as a deviation.

## Left to the builder

The exact quiet period, the icon set for the hover toolbar, names of modules and messages, and how to split the work into commits.
