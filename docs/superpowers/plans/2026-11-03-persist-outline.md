# Persist the Outline and Re-link Restored Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every window, group, and tab a persisted Tab Hammer ID owned by the service worker, add hibernate / trash / rename / reopen, and re-link windows Chrome restores to their original rows instead of duplicating them.

**Architecture:** Pure, unit-tested model modules (`src/model/outline/`) hold the outline records and every rule: lifecycle operations, reconcile against a Chrome snapshot, the restore-matching heuristic, match application, reopen planning, and drag placement. A service-worker owner (`src/background/outline/`) wires Chrome events to those functions through one serial job queue, persists to a new IndexedDB database, and broadcasts the outline to the view over a `chrome.runtime` port; the view sends commands back as runtime messages. The view stops reading Chrome for the tree: `buildTree` turns the broadcast outline into the existing `WindowNode`/`GroupNode`/`TabNode` view model, keyed by Tab Hammer IDs.

**Tech Stack:** TypeScript 6.0 (strict, erasable), React 19, Vite 8 + crxjs 3, Vitest 5 (+ `fake-indexeddb`), Playwright 1.63 (headless new-mode Chromium), MV3 `chrome.*` APIs.

**Spec:** `docs/superpowers/specs/2026-11-03-persist-outline-design.md` (read it first; it is authoritative, including its lifecycle table). Repo rules: `CLAUDE.md` at the worktree root.

## Global Constraints

- Never run `npm run dev` or `npm run install-mcp`; never build into `~/.tab-hammer/dist`. E2E builds with `npm run build:e2e` into `packages/extension/dist-e2e/`. E2E stays headless.
- Completion gate for any code change: `npm run gate` (repo root). Per-task loops run the narrower commands given in each task, from `packages/extension/`.
- Pure model modules (`src/model/**`) never touch `chrome.*`, `Date.now()`, `crypto`, or timers: `now: number` and `newId: () => string` are parameters. The worker passes `Date.now()` and `crypto.randomUUID()`.
- Model operations never mutate their inputs. They return a new `Outline`; a `WindowRec` that didn't change is returned **by reference** (the store diffs by identity to decide what to write).
- Tab Hammer IDs are random UUIDs, never Chrome IDs. Chrome IDs are attached only while live and only trusted within one browser session.
- Constants (exact): `TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000`; `SETTLE_QUIET_MS = 1500`; `MATCH_THRESHOLD = 0.6`; exact tab match scores `1`, loose `0.75`; IndexedDB name `tab-hammer-outline`, `OUTLINE_SCHEMA_VERSION = 1`.
- Visual changes are limited to: a `hibernated` dim class on rows, an absolutely positioned hover toolbar overlay, the Recently closed section, and the inline rename field. Don't change row font size, height, or padding (another session, SKULL-838, is restyling rows).
- The MCP bridge (`src/background/tabCommands.ts`) stays live-only and unchanged; `bridge.spec.ts` must keep passing.
- Tests: Vitest in `__tests__/` folders next to the code, pure logic only, injected clock/timers, no sleeps. E2E waits on conditions (`expect.poll`, locator assertions), never fixed timeouts.
- **Sync-ready storage** (input from the user, via the spawner; no sync is built here): IDs are `crypto.randomUUID()`. Every `WindowRec` carries `originInstallId` (a per-install ID created once and kept in `chrome.storage.local` under `installId`; the worker passes it into the model). Every `WindowRec`, `GroupRec`, and `TabRec` carries `modifiedAt: number`, set to `now` whenever that record's own persisted fields change (name, state, url, title, group, order position, membership); records whose fields didn't change keep their old `modifiedAt`. Machine-local fields (`chromeWindowId`, `chromeTabId`, `chromeGroupId`, `launchUrl`, `provisional`, `openAtShutdown`, `liveAtClose`) are stripped by `exportOutline()`, and a unit test seeds a record with every one of them and asserts no exported record contains any.
- Commit messages end with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Typing in the rename field** — Backspace/Delete must edit the text, not trash the selected rows; Enter must save, not open/activate. (Test: Task 11, e2e `rename field keystrokes stay in the field`.)
2. **Closing a window in Chrome mid-reconcile** — Chrome fires `tabs.onRemoved` (window closing) for each tab before `windows.onRemoved`; a re-query in between must not strip tabs from the window, so its trash entry keeps every tab. (Test: Task 3, `a window that is closing keeps its tabs`; Task 7 e2e asserts the trash entry's tab count.)
3. **The worker idling out and waking** is not a browser launch: nothing goes to the trash and Chrome IDs re-attach. (Test: Task 13 e2e asserts the window is still live with the same ID and the trash is empty after a worker restart.)
4. **Reopening a tab Chrome refuses to create** (e.g. a URL an extension can't open) — the other tabs still open and the refused one stays hibernated in place. (Test: Task 5, `attachOpened leaves tabs that failed to open hibernated`.)
5. **A tab dragged out into its own window** keeps its row in a new window row and is never treated as a restored window (never matched against the trash). (Test: Task 3, `a new window holding a known tab is not provisional`.)

---

## File Structure

All paths under `packages/extension/` unless noted.

```
src/model/outline/types.ts          Outline records (WindowRec/GroupRec/TabRec), ChromeSnapshot, Effects
src/model/outline/lifecycle.ts      closeWindow, hibernate, trash, renameWindow, deleteWindow, expireTrash, startFresh, findRow
src/model/outline/matching.ts       normalizeForMatch, isBlankPage, tabMatch, alignWindows, assignMatches
src/model/outline/reconcile.ts      reconcile, mergeHibernated, replaceTabId
src/model/outline/applyMatch.ts     matchRestored
src/model/outline/open.ts           planOpen, attachOpened
src/model/outline/place.ts          placeTabs, attachGroup
src/model/outline/__tests__/        unit tests + recs.ts (test record builders)
src/model/types.ts                  view nodes reworked (Task 9); Raw* types removed
src/model/buildTree.ts              OutlineState -> OutlineView (Task 9)
src/model/moveSelection.ts          planDrop for hibernated rows (Task 10)
src/model/keyboardNav.ts            'trash' intent (Task 11)
src/shared/outlineMessages.ts       port name, LiveDetails, OutlineState, state message, OutlineCommand + guards
src/background/session.ts           the single browserSession instance (moved out of previews.ts)
src/background/outline/outlineStore.ts   IndexedDB: loadOutline, saveOutline, exportOutline
src/background/outline/settleTracker.ts  quiet-period tracker for provisional windows
src/background/outline/chromeOutline.ts  Chrome reads (snapshot, launch URLs, focus) and effects (open, group, close)
src/background/outline/outlineOwner.ts   the owner: queue, init, reconcile, settle -> match, persist, broadcast, commands
src/background/index.ts             registers the owner; test hooks
src/manifest.ts                     + webNavigation
src/view/chrome/outlineClient.ts    port subscription (with reconnect) + sendOutlineCommand
src/view/chrome/chromeSource.ts     snapshot()/subscribe() removed; activate/focus/move/close stay
src/view/App.tsx                    fed by outlineClient; commands; keyboard
src/view/components/RowToolbar.tsx  hover toolbar
src/view/components/RenameField.tsx inline rename input
src/view/components/RecentlyClosed.tsx  trash section
src/view/components/{WindowCard,GroupRow,TabRow}.tsx  hibernated class, toolbar, data-*-id attributes
src/view/hover/HoverCard.tsx        no on-demand capture for hibernated tabs
src/view/styles/theme.css           .hibernated, .row-toolbar, .recently-closed, .rename-field
tests/e2e/fixtures.ts               helpers: readOutline, outlineCommand, liveRow
tests/e2e/outline.spec.ts           worker mirror + lifecycle flows
tests/e2e/restart.spec.ts           browser restart re-link, worker restart
tests/e2e/{tree,move,preview}.spec.ts   locators move from data-key=t:<chromeId> to data-tab-id
CLAUDE.md (repo root)               architecture + tests sections
```

**Decisions baked in (beyond the spec):**
- **Flat window record.** `WindowRec` holds `tabs: TabRec[]` (outline order) and `groups: GroupRec[]`, with `TabRec.groupId` naming its group record — instead of nested group children. Groups that split around a hibernated tab stay one record; `buildTree` renders runs exactly as today (`g:<id>`, `g:<id>#2`).
- **Trashed windows stay in `Outline.windows`** at their position, so a match restores them in place; opening one by hand moves it to the bottom. The trash view sorts by `closedAt` descending.
- **Provisional windows** are real `WindowRec`s (`provisional: true`, keyed by a fresh ID) so the view shows them immediately; a match replaces the record with the matched one, an unmatched settle just clears the flag (no row change).
- **One shared quiet period.** All provisional windows settle together once no relevant event touched any of them for `SETTLE_QUIET_MS`, so windows restored together are assigned in one global pass.
- **Every command job reconciles first** against a fresh Chrome snapshot, then applies the command.
- **Reopen creates tabs one by one** (`windows.create` with the first URL, then `tabs.create({ active: false })`), then best-effort `tabs.discard` of the background ones; a tab whose create fails stays hibernated.
- **Trashing every live tab of a live window that has no hibernated tabs** trashes the window (with its tabs) rather than leaving an empty trash entry. Deleting the last tab of a hibernated window deletes the window.
- **Rename field:** Enter or blur saves, Escape cancels.
- **Recently closed entries** are not selectable, not keyboard-navigable, and not drag sources or targets; their tab rows have no hover card or toolbar.

---

### Task 1: Outline records and lifecycle operations

**Files:**
- Create: `src/model/outline/types.ts`, `src/model/outline/lifecycle.ts`, `src/model/outline/__tests__/recs.ts`, `src/model/outline/__tests__/lifecycle.test.ts`

**Interfaces:**
- Consumes: `GroupColor` from `src/model/types.ts`.
- Produces (`types.ts`):

```ts
export type WindowState = 'live' | 'hibernated' | 'trashed';
export interface TabRec {
  id: string;
  chromeTabId?: number;      // present = live
  url: string;
  title: string;
  launchUrl?: string;        // address Chrome created/restored the tab with (live/provisional tabs)
  groupId?: string;          // GroupRec.id in the same window
  liveAtClose?: boolean;     // was live when its window last stopped being live (match scoring uses these)
  modifiedAt: number;
}
export interface GroupRec { id: string; chromeGroupId?: number; title: string; color: GroupColor; collapsed: boolean; modifiedAt: number }
export interface WindowRec {
  id: string;
  name?: string;
  state: WindowState;
  chromeWindowId?: number;   // present iff state === 'live'
  closedAt?: number;         // trashed only
  openAtShutdown?: boolean;
  provisional?: boolean;     // live, unknown origin, not yet matched
  lastLiveAt: number;
  originInstallId: string;   // install that created it (sync-readiness)
  modifiedAt: number;
  tabs: TabRec[];
  groups: GroupRec[];
}
export interface Outline { windows: WindowRec[] }          // outline order, trashed included
export interface Effects { closeWindows: number[]; closeTabs: number[] }  // Chrome IDs to close
export interface OpResult { outline: Outline; effects: Effects }
export const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NO_EFFECTS: Effects;
```

- Produces (`lifecycle.ts`), all `(o: Outline, …) => …`:
  - `findRow(o, id): { window: WindowRec; tab?: TabRec; group?: GroupRec } | undefined` — `id` is a window, group, or tab record ID.
  - `closeWindow(o, windowId: string, now): Outline` — Chrome closed it (or a missed close): strip Chrome IDs (tabs that had one get `liveAtClose: true`, others `false`), `lastLiveAt = now`; → `hibernated` if it holds any hibernated tab, else `trashed` with `closedAt = now`. Clears `provisional`.
  - `hibernate(o, ids: string[], now): OpResult` — window IDs: live → hibernated, `effects.closeWindows`; tab/group IDs: their live tabs lose `chromeTabId`, `effects.closeTabs`; if that leaves a live window with no live tabs it becomes hibernated (its Chrome window closes with its last tab, so it is not listed in `closeWindows`).
  - `trash(o, ids, now): OpResult` — window live → trashed + `closeWindows`; window hibernated → trashed; tab live → removed + `closeTabs`; tab hibernated → removed. If a live window loses all live tabs: hibernated if hibernated tabs remain; if none remain, the whole window is trashed with the removed tabs kept (decision above). A hibernated window left with no tabs is deleted.
  - `renameWindow(o, windowId, name: string, now): Outline` — trimmed; empty clears `name`.
  - `deleteWindow(o, windowId): Outline` — removes the record.
  - `expireTrash(o, now): Outline` — deletes trashed windows with `now - closedAt > TRASH_TTL_MS` (exactly 7 days old stays).
  - `startFresh(o, now): Outline` — fresh browser launch: every live window → `closeWindow` semantics plus `openAtShutdown: true`.
  - Any user op on a window (`hibernate`, `trash`, `renameWindow`, and later `attachOpened`) clears its `openAtShutdown`.
  - **`modifiedAt` rule (all ops here and in Tasks 3-5):** an op sets `modifiedAt = now` only on records whose own persisted fields changed, and leaves other records untouched (by reference). Window: `name`, `state`, or its tab list/group list changes (the flat model has no position field, so adding, removing, or reordering tabs stamps the window). Tab: `url`, `title`, or `groupId` changes. Group: `title`, `color`, or `collapsed` changes.

- [ ] **Step 1: Write the test builders** in `__tests__/recs.ts`: `tab(id, opts?)`, `group(id, opts?)`, `win(id, opts?)` returning records with defaults (`url: https://e.test/<id>`, `title: id`, `state` derived from `chromeWindowId`, `lastLiveAt: 0`, `groups: []`, `modifiedAt: 0`, `originInstallId: 'i'`). Later tasks reuse them.

- [ ] **Step 2: Write the failing tests** in `lifecycle.test.ts`. Use `NOW = 1_000_000`.

```ts
it('closing a live window with only live tabs trashes it, marking which tabs were live', () => {
  const o = { windows: [win('w', { chromeWindowId: 1, tabs: [tab('a', { chromeTabId: 11 }), tab('b', { chromeTabId: 12 })] })] };
  const w = closeWindow(o, 'w', NOW).windows[0]!;
  expect(w).toMatchObject({ state: 'trashed', closedAt: NOW, lastLiveAt: NOW });
  expect(w.chromeWindowId).toBeUndefined();
  expect(w.tabs.map((t) => [t.chromeTabId, t.liveAtClose])).toEqual([[undefined, true], [undefined, true]]);
});
it('closing a live window that holds hibernated tabs hibernates it instead', …) // state 'hibernated', no closedAt
it('hibernating the last live tab hibernates the window and closes just the tab', …)
  // effects toEqual({ closeWindows: [], closeTabs: [11] }), window.state 'hibernated', tab row kept in place
it('hibernating a live window closes it in Chrome and keeps every tab row', …)
it('trashing a hibernated tab deletes it; trashing a live tab removes it and closes it', …)
it('trashing every live tab of a window with no hibernated tabs trashes the window with those tabs', …)
it('trashing the last tab of a hibernated window deletes the window', …)
it('renaming trims, and an empty name clears it', …) // '  Work  ' -> 'Work'; '   ' -> name undefined
it('trash entries expire after 7 days, not before', …)
  // closedAt = NOW - TRASH_TTL_MS stays; NOW - TRASH_TTL_MS - 1 goes
it('a fresh launch trashes live windows marked open-at-shutdown, and hibernates partly live ones', …)
  // also: user-hibernated windows untouched (no openAtShutdown), already-trashed untouched
it('user actions clear open-at-shutdown', …) // rename + hibernate on an openAtShutdown window
it('returns untouched windows by reference', …) // closeWindow on w1 leaves o.windows[1] === result.windows[1]
it('ops stamp changed records only', …) // renameWindow(o, 'w', 'X', NOW): w.modifiedAt === NOW, its tabs and the other window keep modifiedAt 0; renaming to the same name stamps nothing
```

- [ ] **Step 3: Run to verify they fail**

Run (from `packages/extension`): `npx vitest run src/model/outline/__tests__/lifecycle.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `types.ts` and `lifecycle.ts`** per the Interfaces block. One private helper `detach(w, now)` does the ID stripping for `closeWindow`, `hibernate` (window), `trash` (window), and `startFresh`.

- [ ] **Step 5: Run to verify they pass** (same command). Expected: PASS. Then `npm run typecheck` (repo root) passes.

- [ ] **Step 6: Commit** — `feat(model): outline records and lifecycle operations (SKULL-811)`

---

### Task 2: Restore-matching heuristic

**Files:**
- Create: `src/model/outline/matching.ts`, `src/model/outline/__tests__/matching.test.ts`

**Interfaces:**
- Consumes: nothing (pure strings).
- Produces:

```ts
export const MATCH_THRESHOLD = 0.6;
export const LOOSE_SCORE = 0.75;
export function normalizeForMatch(url: string): string;      // see Step 3
export function isBlankPage(url: string): boolean;           // '', about:blank, chrome://newtab/, chrome://new-tab-page/
export interface RestoredTab { url: string; launchUrl?: string }
export function tabMatch(restored: RestoredTab, savedUrl: string): 0 | 0.75 | 1;
export interface Alignment { score: number; pairs: [restoredIndex: number, savedIndex: number][] }
export function alignWindows(restored: RestoredTab[], saved: string[]): Alignment;
export interface MatchRestored { id: string; tabs: RestoredTab[] }
export interface MatchCandidate { id: string; tabs: string[]; openAtShutdown: boolean; lastLiveAt: number }
export interface Assignment { restoredId: string; candidateId: string; alignment: Alignment }
export function assignMatches(restored: MatchRestored[], candidates: MatchCandidate[]): Assignment[];
```

- [ ] **Step 1: Write the failing tests** (`u = (p) => 'https://e.test/' + p`):

```ts
it('normalizes', () => {
  expect(normalizeForMatch('http://www.Example.com/a/#top')).toBe(normalizeForMatch('https://example.com/a'));
  expect(normalizeForMatch('https://e.test/')).toBe(normalizeForMatch('https://e.test'));
  expect(normalizeForMatch('chrome://settings/#x')).toBe('chrome://settings/');
});
it('tab match: exact on launch or current URL, loose when only the query differs', () => {
  expect(tabMatch({ url: 'https://login.e.test/?next=1', launchUrl: u('inbox') }, u('inbox'))).toBe(1);
  expect(tabMatch({ url: u('p?a=1') }, u('p?cf_chl=2'))).toBe(0.75);
  expect(tabMatch({ url: u('p') }, u('q'))).toBe(0);
});
it('scores identical windows 1 and reordered ones by their longest common run', () => {
  expect(alignWindows(['a','b','c'].map((p) => ({ url: u(p) })), ['a','b','c'].map(u)).score).toBe(1);
  expect(alignWindows(['c','a','b'].map((p) => ({ url: u(p) })), ['a','b','c'].map(u)).score).toBeCloseTo(2 / 3);
});
it('added tabs cost only their share; removed tabs too', () => {
  expect(alignWindows(['a','b','c','d'].map(r), ['a','b','c'].map(u)).score).toBe(0.75);
  expect(assignMatches([R('r', ['a','b'])], [C('c', ['a','b','c','d','e'])])).toEqual([]); // 0.4 < 0.6
});
it('a single-tab window must match exactly', () => {
  expect(assignMatches([R('r', ['p?q=1'])], [C('c', ['p?q=2'])])).toEqual([]);
  expect(assignMatches([R('r', ['p'])], [C('c', ['p'])])).toHaveLength(1);
});
it('loose matches count in multi-tab windows', …) // 2 tabs both loose -> score 0.75, assigned
it('windows of only new-tab pages are never matched', …) // ['chrome://newtab/'] vs same -> []
it('assigns globally best pairs first', () => {
  // B–X scores 1, A–X 0.75, A–Y 0.67: expect B→X and A→Y, not A→X.
});
it('ties prefer open-at-shutdown candidates, then the most recently live', …)
it('each restored window and candidate is used at most once', …)
```

(`R(id, paths)` / `C(id, paths, opts?)` are local helpers building `MatchRestored` / `MatchCandidate`.)

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/model/outline/__tests__/matching.test.ts` → FAIL.

- [ ] **Step 3: Implement.**
  - `normalizeForMatch`: parse with `URL`; unparseable → the string itself. For `http:`/`https:`: scheme `https`, host lowercased minus a leading `www.`, path minus a trailing `/` (root path becomes empty), query kept, fragment dropped. Other schemes: drop the fragment only.
  - `tabMatch`: exact if `normalizeForMatch` of `launchUrl` or `url` equals the saved one's; loose if (http(s) only) host + path agree for either; else 0.
  - `alignWindows`: weighted LCS. `dp[i][j] = max(dp[i-1][j], dp[i][j-1], dp[i-1][j-1] + m)` where `m = tabMatch(restored[i-1], saved[j-1])` and the diagonal is only taken when `m > 0`. Backtrack (prefer the diagonal on ties) for `pairs` in ascending order. `score = dp[n][m] / max(n, m)` (0 if both empty). When either side has exactly one tab, loose matches count 0.
  - `assignMatches`: drop restored windows and candidates whose tabs are all `isBlankPage`; score every pair; keep pairs with `score >= MATCH_THRESHOLD`; sort by score desc, then `openAtShutdown` first, then `lastLiveAt` desc, then candidate input order, then restored input order; take greedily, each ID once.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit** — `feat(model): restore-matching heuristic (SKULL-822)`

---

### Task 3: Reconcile the outline with a Chrome snapshot

**Files:**
- Create: `src/model/outline/reconcile.ts`, `src/model/outline/__tests__/reconcile.test.ts`
- Modify: `src/model/outline/types.ts` (add snapshot types)

**Interfaces:**
- Consumes: Task 1 records, `closeWindow` from `lifecycle.ts`.
- Produces (`types.ts` additions):

```ts
export interface LiveTab {
  id: number; windowId: number; index: number; groupId: number; // -1 = ungrouped
  url: string; title: string; launchUrl?: string;
  active: boolean; discarded: boolean; lastAccessed?: number;
}
export interface LiveGroup { id: number; windowId: number; title: string; color: GroupColor; collapsed: boolean }
/** Chrome's normal windows (Tab Hammer's popup excluded), their tabs (capture swap tab excluded), groups. */
export interface ChromeSnapshot { windowIds: number[]; tabs: LiveTab[]; groups: LiveGroup[] }
```

- Produces (`reconcile.ts`):

```ts
export interface ReconcileInput {
  snapshot: ChromeSnapshot;
  closingWindowIds: ReadonlySet<number>; // windows Chrome is closing (tabs.onRemoved isWindowClosing)
  now: number;
  newId: () => string;
  installId: string;                     // stamped as originInstallId on every new WindowRec
}
export interface ReconcileResult { outline: Outline; newProvisional: number[] /* Chrome window IDs */ }
export function reconcile(o: Outline, input: ReconcileInput): ReconcileResult;
/** `live` (records in their new order) plus the hibernated tabs of `old` (no chromeTabId, not in
 *  `live`), each re-inserted right after its nearest preceding `old` neighbour that is in `live`
 *  (start of the list if none); runs of hibernated tabs keep their order. */
export function mergeHibernated(old: TabRec[], live: TabRec[]): TabRec[];
export function replaceTabId(o: Outline, addedTabId: number, removedTabId: number): Outline;
```

Rules `reconcile` implements:
1. Index every live `TabRec` by `chromeTabId` and every `GroupRec` by `chromeGroupId` across all windows (tabs and groups can change windows).
2. Live window whose `chromeWindowId` isn't in the snapshot → `closeWindow` (missed close), unless it is in `closingWindowIds` *and* still present — see 4.
3. Snapshot windows with no tabs are ignored this round.
4. A known window in `closingWindowIds` is left exactly as it is (its tabs vanish one by one while Chrome closes it).
5. Known window: its live tab list = snapshot tabs sorted by `index`, each the existing record (by `chromeTabId`, from any window, keeping its ID) updated with `url`/`title`, `launchUrl ??=` the snapshot's, or a new record. Live tab `groupId` follows Chrome: the `GroupRec` with that `chromeGroupId` (moved into this window if it lived elsewhere; title/color/collapsed updated from Chrome) or a new one. Then `mergeHibernated(oldTabs, liveTabs)`. Live tab records no longer anywhere in the snapshot are dropped.
6. Group records: `chromeGroupId` removed when the Chrome group is gone; records no tab references are pruned.
7. Unknown snapshot window: if it holds any known tab → a new non-provisional live `WindowRec` (a tab dragged out). Otherwise a new live `WindowRec` with `provisional: true`, appended at the bottom, its Chrome ID returned in `newProvisional`.
8. Windows whose content didn't change come back by reference.
9. New `WindowRec`s get `originInstallId = input.installId` and `modifiedAt = now`; new tab/group records get `modifiedAt = now`. Existing records are stamped `now` only when their own persisted fields changed (window: tab list/order or group list; tab: `url`, `title`, `groupId`; group: `title`, `color`, `collapsed`); unchanged ones keep their `modifiedAt`.

- [ ] **Step 1: Write the failing tests** (build snapshots with a local `snap({ windows: { 1: [t(11), t(12, { groupId: 5 })] }, groups: [g(5, 1)] })` helper):

```ts
it('worker restart: known windows and tabs re-attach by Chrome ID, keeping record IDs', …)
it('live tab order follows Chrome; a hibernated tab stays after the neighbour it had', () => {
  // old: [a(11), h(hibernated), b(12)]; Chrome now [12, 11] -> ['b', 'a', 'h']
});
it('a hibernated tab whose preceding neighbour closed moves up to the next surviving one', …)
it('a closed tab is removed; a missed window close sends the window to the trash', …)
it('a window that is closing keeps its tabs', () => {
  // window 1 in closingWindowIds, snapshot has it with 1 of its 3 tabs -> record unchanged (toBe)
});
it('a new window holding a known tab is not provisional', …) // the tab keeps its record ID in the new window; the window carries input.installId as originInstallId
it('an unknown window becomes a provisional row at the bottom', …) // newProvisional === [chromeId]; originInstallId === input.installId
it('stamps modifiedAt only on records that changed', …) // retitled tab and its window get now; an untouched sibling tab and window keep their old modifiedAt
it('groups follow Chrome for live tabs and keep hibernated members', …)
it('a group moved to another window takes its record with it', …)
it('unchanged windows come back by reference', …)
it('replaceTabId swaps a prerendered or discarded tab ID in place', …)
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/model/outline/__tests__/reconcile.test.ts` → FAIL.

- [ ] **Step 3: Implement** per the rules above.

- [ ] **Step 4: Run to verify they pass.** Then run the whole model suite: `npx vitest run src/model` → PASS.

- [ ] **Step 5: Commit** — `feat(model): reconcile the outline with Chrome (SKULL-811)`

---

### Task 4: Apply restore matches

**Files:**
- Create: `src/model/outline/applyMatch.ts`, `src/model/outline/__tests__/applyMatch.test.ts`

**Interfaces:**
- Consumes: `assignMatches`, `MatchCandidate`, `MatchRestored`, `Alignment` (Task 2); `mergeHibernated` (Task 3); records (Task 1).
- Produces:

```ts
export interface MatchResult { outline: Outline; matched: { restoredId: string; windowId: string }[] }
/** Matches the given provisional windows against the outline's candidates and applies every
 *  assignment. Unmatched provisional windows just lose the flag. */
export function matchRestored(o: Outline, provisionalIds: string[], now: number, newId: () => string): MatchResult;
```

Rules:
- Candidates: windows with `openAtShutdown` (trashed or hibernated), plus every other trashed window. User-hibernated windows (hibernated, no `openAtShutdown`) never. A candidate's saved list is its tabs with `liveAtClose === true`, in outline order. Restored lists are the provisional window's tabs (`url`, `launchUrl`).
- Applying a match to candidate `C` from provisional `P`: `C` keeps its position in `Outline.windows`; `P` is removed. `C` becomes `live` with `P`'s `chromeWindowId`, `lastLiveAt = now`, no `closedAt`/`openAtShutdown`/`provisional`, `name` kept. Tabs: walk `P`'s tabs in order; aligned ones take the saved record's `id` with `P`'s `chromeTabId`/`url`/`title`/`launchUrl`; unaligned keep `P`'s record. Then `mergeHibernated(C.tabs with Chrome IDs stripped, thoseLiveTabs)` keeps unrestored saved tabs hibernated in place.
- `modifiedAt = now` on `C` (state and tab list change) and on any tab record whose `url`/`title`/`groupId` changed by taking `P`'s values; saved tab and group records that didn't change keep their `modifiedAt`.
- Groups: for each Chrome group in `P`, the `C` group record holding most of its aligned tabs takes over (gets the `chromeGroupId`, Chrome's title/color/collapsed); otherwise `P`'s group record moves into `C`. Live tabs' `groupId` follows Chrome; hibernated tabs keep theirs.

- [ ] **Step 1: Write the failing tests:**

```ts
it('re-links a restored window into its trashed row, in place, with the same IDs and name', () => {
  // outline: [X(live), C(trashed, openAtShutdown, name 'Work', tabs a,b), P(provisional, tabs a',b')]
  // expect windows ids ['X','C'], C live with P's chromeWindowId, tabs ids ['a','b'] with P's chromeTabIds, name 'Work'
});
it('partial match: extra restored tabs become new rows, missing saved tabs stay hibernated in place', …)
it('hibernated tabs of a partly live window are not scored and stay hibernated', () => {
  // C hibernated+openAtShutdown, tabs [a(liveAtClose), h(liveAtClose false), b(liveAtClose)];
  // restored [a, b] -> score 1; result tabs ['a','h','b'], h without chromeTabId
});
it('user-hibernated windows are never matched', …)
it('a restored group re-attaches to the saved group holding most of its tabs', …)
it('an unmatched provisional window just loses the flag', …)
it('two restored windows match two trash entries in one pass', …)
it('stamps modifiedAt only on the matched window and on tabs whose fields changed', …)
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/model/outline/__tests__/applyMatch.test.ts` → FAIL.
- [ ] **Step 3: Implement `matchRestored`.**
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** — `feat(model): apply restore matches (SKULL-822)`

---

### Task 5: Reopen planning and drag placement

**Files:**
- Create: `src/model/outline/open.ts`, `src/model/outline/place.ts`, `src/model/outline/__tests__/open.test.ts`, `src/model/outline/__tests__/place.test.ts`

**Interfaces:**
- Consumes: records, `Effects`, `findRow` (Task 1).
- Produces (`open.ts`):

```ts
export interface OpenTab { tabId: string; url: string; index: number; groupId?: string }
export interface OpenPlan {
  windowId: string;
  chromeWindowId: number | null; // null = create a new Chrome window
  tabs: OpenTab[];               // ascending index; each index is valid at the moment it is created
  groups: GroupRec[];            // the groups the opened tabs belong to (live ones carry chromeGroupId)
}
/** `rowId` is a window, group, or tab record (hibernated or trashed). Null if nothing to open. */
export function planOpen(o: Outline, rowId: string): OpenPlan | null;
export interface Opened {
  chromeWindowId: number;
  tabs: { tabId: string; chromeTabId: number }[];   // only the ones Chrome actually created
  groups: { groupId: string; chromeGroupId: number }[];
}
export function attachOpened(o: Outline, windowId: string, opened: Opened, now: number): Outline;
```

  `planOpen` cases (spec lifecycle table): hibernated or trashed window → new window, all tabs, indexes `0..n-1`; window partly live → into its Chrome window, all hibernated tabs; hibernated tab or group in a hibernated window → new window with just those tabs; in a live window → into it. In a live window, a tab's index = the number of live-or-being-opened tabs before it in outline order. `attachOpened`: window goes live (clears `closedAt`, `openAtShutdown`); a window that was trashed moves to the bottom of `Outline.windows`; listed tabs/groups get their Chrome IDs; others stay hibernated.

- Produces (`place.ts`):

```ts
export interface Placement {
  windowId: string;              // target window record
  beforeTabId: string | null;    // insert before this (non-moved) tab record; null = window end
  tabs: { id: string; groupId: string | null }[]; // moved tab records in final order
}
export interface PlaceResult {
  outline: Outline;
  effects: Effects;              // live tabs dropped into a hibernated window are closed
  regroup: { groupId: string; chromeWindowId: number; chromeTabIds: number[] }[];
}
export function placeTabs(o: Outline, p: Placement, now: number, newId: () => string): PlaceResult;
export function attachGroup(o: Outline, groupId: string, chromeGroupId: number): Outline;
```

  `placeTabs`: moves the records to the target position. `groupId` is applied only to tabs that are hibernated after the move (Chrome owns live tabs' groups). A group record belonging to another window is moved if no tab there still uses it, else copied under a new ID. `modifiedAt = now` on the source and target windows and on any moved tab whose `groupId` changed (`attachOpened` stamps the window it makes live); everything else keeps its `modifiedAt`. A hibernated source window left with no tabs is deleted. Target window not live → moved live tabs lose `chromeTabId` and are listed in `effects.closeTabs`; a source window left without live tabs follows the Task 1 rules. Target live and a `groupId` whose record has no `chromeGroupId` while live tabs were placed in it → listed in `regroup`.

- [ ] **Step 1: Write the failing tests:**

```ts
// open.test.ts
it('plans a hibernated window as a new Chrome window with every tab in order', …)
it('plans one hibernated tab of a live window at its live index', () => {
  // tabs [a(live), h1, b(live), h2]; planOpen('h2') -> chromeWindowId set, tabs [{ tabId: 'h2', index: 2 }]
});
it('plans a hibernated tab of a hibernated window as a new window with just that tab', …)
it('plans a partly live window as all its hibernated tabs into that window', …)
it('attaching an opened trash entry moves it to the bottom and makes it live', …)
it('attachOpened leaves tabs that failed to open hibernated', …) // Review Focus 4
// place.test.ts
it('moves hibernated tabs between windows without effects', …)
it('live tabs dropped into a hibernated window are hibernated there', …) // effects.closeTabs
it('keeps live and hibernated moved tabs in their relative order', …)
it('a hibernated tab joining a group takes the group; a live one does not', …)
it('live tabs placed into a group with no live tabs ask to regroup', …)
it('stamps modifiedAt on the windows and regrouped tabs it changed, nothing else', …)
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/model/outline/__tests__/open.test.ts src/model/outline/__tests__/place.test.ts` → FAIL.
- [ ] **Step 3: Implement `open.ts` and `place.ts`.**
- [ ] **Step 4: Run to verify they pass.** Then `npx vitest run src/model` → PASS.
- [ ] **Step 5: Commit** — `feat(model): reopen planning and outline placement`

---

### Task 6: Outline store, settle tracker, shared messages

**Files:**
- Create: `src/background/outline/outlineStore.ts`, `src/background/outline/settleTracker.ts`, `src/shared/outlineMessages.ts`, `src/background/session.ts`
- Create tests: `src/background/outline/__tests__/outlineStore.test.ts`, `src/background/outline/__tests__/settleTracker.test.ts`
- Modify: `src/background/previews.ts` (import `browserSession` from `./session` instead of creating one)

**Interfaces:**
- Consumes: `Outline`, `WindowRec`, `Placement` (Tasks 1, 5).
- Produces (`outlineStore.ts`), modelled on `src/shared/previewStore.ts` (lazy `db()` with `onversionchange`/`onclose` reset, `run()` per transaction):

```ts
export const OUTLINE_SCHEMA_VERSION = 1;
export interface OutlineMeta { schemaVersion: number; sessionId: string; order: string[] /* window IDs */ }
export function loadOutline(): Promise<{ meta: OutlineMeta | undefined; outline: Outline }>;
/** Writes windows of `next` that aren't (by reference) in `prev`, deletes ones gone, and the meta, in one transaction. */
export function saveOutline(prev: Outline, next: Outline, sessionId: string): Promise<void>;
export function exportOutline(): Promise<{ schemaVersion: number; windows: SyncWindow[] }>; // plain JSON, outline order, live-only fields stripped (SyncWindow = WindowRec minus chromeWindowId/provisional/openAtShutdown; its tabs minus chromeTabId/launchUrl/liveAtClose; its groups minus chromeGroupId)
```

  DB `tab-hammer-outline` v1: object store `windows` (keyPath `id`), object store `meta` (one record under key `'meta'`).

- Produces (`settleTracker.ts`):

```ts
export const SETTLE_QUIET_MS = 1500;
export interface SettleTracker { touch(chromeWindowId: number): void; forget(chromeWindowId: number): void; pending(): number[] }
export function createSettleTracker(opts: {
  onSettled: (chromeWindowIds: number[]) => void;
  quietMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): SettleTracker;
```

  One shared timer: every `touch` restarts it; when it fires, all pending IDs settle together and are cleared. `forget` removes one (no fire if none left).

- Produces (`outlineMessages.ts`):

```ts
export const OUTLINE_PORT = 'tabHammer.outline';
export interface LiveDetails {
  tabs: Record<number, { active: boolean; discarded: boolean; lastAccessed?: number }>; // by chromeTabId
  focusedWindowId: number | null; // last-focused normal window
}
export interface OutlineState { windows: WindowRec[]; live: LiveDetails }
export interface OutlineStateMessage { type: 'outline'; state: OutlineState }
export const OUTLINE_COMMAND = 'tabHammer.outlineCommand';
export type OutlineCommand =
  | { cmd: 'hibernate'; ids: string[] }
  | { cmd: 'trash'; ids: string[] }
  | { cmd: 'open'; id: string }
  | { cmd: 'rename'; windowId: string; name: string }
  | { cmd: 'deleteForever'; windowId: string }
  | { cmd: 'place'; placement: Placement };
export interface OutlineCommandRequest { type: typeof OUTLINE_COMMAND; command: OutlineCommand }
export interface OutlineCommandReply { ok: boolean; error?: string }
export function isOutlineCommandRequest(msg: unknown): msg is OutlineCommandRequest;
```

- Produces (`session.ts`): `export const browserSession: BrowserSession` — the one instance (moved verbatim from `previews.ts`). Two instances would each renew the session ID on launch.

- [ ] **Step 1: Write the failing tests:**

```ts
// outlineStore.test.ts (import 'fake-indexeddb/auto')
it('round-trips windows in outline order with the meta', …)
it('persists changes and deletions', …) // save, replace one window with a new object, delete one; load equals next
it('exportOutline returns plain JSON', () => { expect(JSON.parse(JSON.stringify(x))).toEqual(x) })
it('exportOutline strips machine-local fields', …) // seed a window and its tab/group records with every stripped field (chromeWindowId, provisional, openAtShutdown; chromeTabId, launchUrl, liveAtClose; chromeGroupId) so the test can fail; none appear anywhere in the export; originInstallId and modifiedAt are present
// settleTracker.test.ts (fake timers via injected setTimer/clearTimer capturing callbacks)
it('settles all touched windows together once quiet', …)
it('a touch restarts the quiet period', …)
it('a forgotten window is not reported', …)
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/background/outline` → FAIL.
- [ ] **Step 3: Implement** the four modules; switch `previews.ts` to `import { browserSession } from './session'`.
- [ ] **Step 4: Run to verify they pass**, plus `npx vitest run src/background` (browserSession tests unchanged) and `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(worker): outline store, settle tracker, outline messages`

---

### Task 7: Service-worker outline owner: mirror, persist, broadcast, re-link

**Files:**
- Create: `src/background/outline/chromeOutline.ts`, `src/background/outline/outlineOwner.ts`, `tests/e2e/outline.spec.ts`
- Modify: `src/background/index.ts`, `src/manifest.ts`, `tests/e2e/fixtures.ts`

**Interfaces:**
- Consumes: Tasks 1–6 (`reconcile` (its input takes `installId`), `replaceTabId`, `closeWindow`, `startFresh`, `expireTrash`, `matchRestored`, store, tracker, messages, `browserSession`), `SWAP_KEY`/`hiddenBySwap`/`isSwapRecord` from `src/shared/captureSwap.ts`.
- Produces (`chromeOutline.ts`):
  - `readSnapshot(launchUrls: ReadonlyMap<number, string>): Promise<ChromeSnapshot>` — `windows.getAll({ windowTypes: ['normal'] })`, `tabs.query({})` filtered to those windows and through `hiddenBySwap`, `tabGroups.query({})`; `url = t.url || t.pendingUrl || ''`.
  - `liveDetails(snapshot, focusedWindowId): LiveDetails`.
- Produces (`outlineOwner.ts`):

```ts
export interface OutlineOwner {
  idle(): Promise<void>;                 // resolves when the job queue is empty
  simulateBrowserRestart(): Promise<void>; // test hook: startFresh + reconcile (fresh-launch path without a relaunch)
  command(c: OutlineCommand): Promise<void>; // Task 8 fills this in; throws 'not implemented' here
}
export function registerOutline(): OutlineOwner; // call synchronously at module top level
```

Owner behaviour:
- **Listeners registered synchronously** in `registerOutline` (Chrome queues events for a waking worker only to listeners registered at top level). Every event handler only records data and enqueues work; all outline mutations run in one serial promise queue, behind `init`.
- **Launch URLs:** `Map<chromeTabId, string>`, first one wins: `tabs.onCreated` (`url || pendingUrl`, if non-empty) and `webNavigation.onCommitted` with `frameId === 0`. Deleted on `tabs.onRemoved`.
- **Init:** read `installId` from `chrome.storage.local` (key `installId`), creating it with `crypto.randomUUID()` if absent, and pass it to every `reconcile`; `loadOutline()`; `sessionId = await browserSession.current()`; if `meta?.sessionId !== sessionId` (a fresh launch; an inline check, not a separate function) → `startFresh(outline, now)`; `expireTrash`; reconcile; persist; touch the tracker with every provisional window's Chrome ID.
- **Reconcile job** (coalesced: at most one queued, not started): `readSnapshot` → `reconcile` with `closingWindowIds` → `expireTrash` → touch `newProvisional` → persist (`saveOutline(prev, next, sessionId)`) → broadcast if anything changed (outline by reference, or live details by value).
  Scheduled by: `tabs.onCreated/onUpdated/onMoved/onAttached/onDetached/onActivated/onRemoved(not window closing)`, `windows.onCreated/onFocusChanged`, `tabGroups.onCreated/onUpdated/onRemoved/onMoved`, `storage.onChanged` of `SWAP_KEY`.
- **Explicit intent events:** `tabs.onRemoved` with `isWindowClosing` adds the window to `closingWindowIds` (no reconcile); `windows.onRemoved` → job: `closeWindow` on the live record with that Chrome ID, drop from `closingWindowIds`, `tracker.forget`; `tabs.onReplaced` → job: `replaceTabId`.
- **Settle:** tab created/removed/moved/attached/detached in a window whose record is `provisional` → `tracker.touch(windowId)`. `onSettled(ids)` → job: reconcile, then `matchRestored(outline, recordIdsFor(ids still provisional), now, newId)`, persist, broadcast.
- **Focus:** `focusedWindowId` = last `windows.onFocusChanged` ID that is a normal window in the latest snapshot (ignore `WINDOW_ID_NONE` and Tab Hammer's popup); seeded from `windows.getLastFocused({ windowTypes: ['normal'] })`.
- **Broadcast:** `runtime.onConnect` with `name === OUTLINE_PORT` → add port, post the current state once init is done; remove on disconnect. Message: `OutlineStateMessage`.
- **Manifest:** add `'webNavigation'` to `permissions` with a comment (launch URLs for re-linking). Its install warning ("Read your browsing history") is subsumed by the existing `history` and `tabs` warnings; record in the commit message that you checked this, or, if you find it adds a new warning line, drop the permission, rely on `tabs.onCreated` alone, and report it as a deviation.
- **Test hooks** (`index.ts`, extend `TestHooks`): `readOutline: () => Promise<{ schemaVersion: number; windows: WindowRec[] }>` (awaits `owner.idle()` then returns the owner's full in-memory records, Chrome IDs included, which e2e asserts on; the stripped sync export, `exportOutline()` from Task 6, is unit-tested there and exposed as `syncExport`), `simulateBrowserRestart: () => Promise<void>`, `outlineCommand: (c: OutlineCommand) => Promise<void>`.
- **Fixtures** (`tests/e2e/fixtures.ts`): `readOutline(sw)`, `outlineCommand(sw, c)` wrappers over the hooks.

- [ ] **Step 1: Write the failing e2e** in `tests/e2e/outline.spec.ts`:

```ts
test('the worker mirrors Chrome: windows, tabs in order, and groups get Tab Hammer IDs', async ({ sw }) => {
  // build window A [Alpha, Bravo grouped 'Research'] Charlie; poll readOutline until a live window
  // with chromeWindowId === A has tab titles ['Alpha','Bravo','Charlie'], Alpha/Bravo share a groupId
  // whose group title is 'Research', and every id is a non-numeric string.
});
test('closing a window in Chrome moves it to the trash with all its tabs', async ({ sw }) => {
  // record A's id, chrome.windows.remove(A); poll: record state 'trashed', 3 tabs, closedAt set
});
test('a window opened with the same tabs as a trash entry is re-linked to it', async ({ sw }) => {
  // close window with 2 data: URLs -> trashed; create a new window with the same 2 URLs;
  // poll (settle is 1.5s; default poll timeout covers it): the trashed record is live again with
  // the new chromeWindowId, and no other record holds that chromeWindowId.
});
```

  Run `npm run build:e2e && npm run test:e2e -- tests/e2e/outline.spec.ts` → FAIL.

- [ ] **Step 2: Implement** `chromeOutline.ts`, `outlineOwner.ts`, the manifest change, `index.ts` registration and hooks, fixture helpers.

- [ ] **Step 3: Verify.** `npm run build:e2e && npm run test:e2e -- tests/e2e/outline.spec.ts` PASS; existing suites still green: `npm run test:e2e` (the view still uses `chromeSource` at this point).

- [ ] **Step 4: Commit** — `feat(worker): service worker owns and persists the outline, re-links restored windows (SKULL-811, SKULL-822)`

---

### Task 8: Outline commands in the worker

**Files:**
- Modify: `src/background/outline/outlineOwner.ts`, `src/background/outline/chromeOutline.ts`, `tests/e2e/outline.spec.ts`

**Interfaces:**
- Consumes: `hibernate`, `trash`, `renameWindow`, `deleteWindow` (Task 1), `planOpen`/`attachOpened` (Task 5), `placeTabs`/`attachGroup` (Task 5), `OutlineCommand` (Task 6).
- Produces (`chromeOutline.ts`):
  - `runEffects(e: Effects): Promise<void>` — `windows.remove` / `tabs.remove`, each error ignored (already gone).
  - `openPlanned(plan: OpenPlan): Promise<Opened>` — new window: `windows.create({ url: first.url, focused: true })`, then the rest with `tabs.create({ windowId, index, url, active: false })`; into a live window: `tabs.create` per tab. A rejected create is skipped (that tab stays hibernated). Then groups: live group → `tabs.group({ groupId, tabIds })`; else `tabs.group({ tabIds, createProperties: { windowId } })` + `tabGroups.update(id, { title, color, collapsed })`. Then best-effort `tabs.discard` of every created background tab (errors ignored).
  - `createGroup(chromeWindowId, chromeTabIds, group: GroupRec): Promise<number>` (for `regroup`).
- Produces (`outlineOwner.ts`): `command(c)` implemented. Each command is one queued job: reconcile against a fresh snapshot, apply the model op, persist + broadcast, run Chrome effects, then (for `open`) `attachOpened` with what Chrome created, persist + broadcast. Holding the queue across the Chrome calls means the windows/tabs Tab Hammer creates are already attached when their events' reconcile runs, so they never become provisional.
  - `runtime.onMessage`: `isOutlineCommandRequest` → `owner.command(msg.command)` → reply `{ ok: true }` or `{ ok: false, error: String(err) }`; return `true` (async). Other messages: return `false`.
  - `hibernate`/`trash`: model first, then `runEffects` (the resulting `onRemoved` events find no live record and do nothing).
  - `place`: `placeTabs(outline, placement, Date.now(), crypto.randomUUID)`, `runEffects`, then for each `regroup` entry `createGroup` and `attachGroup`.

- [ ] **Step 1: Write the failing e2e** (append to `outline.spec.ts`, driving commands through the `outlineCommand` hook):

```ts
test('hibernating a window closes it and keeps its rows; opening it restores order and groups', async ({ sw }) => {
  // window [Alpha, Bravo]@Research, Charlie; hibernate its record id.
  // Chrome: the window is gone. Record: state 'hibernated', tab ids unchanged, no chromeTabIds.
  // open(record id): poll Chrome — one new window with titles ['Alpha','Bravo','Charlie'] and
  // Alpha/Bravo in a group titled 'Research'; record live with the same tab ids.
});
test('hibernating one tab keeps its row in place; opening it puts it back at its position', …)
test('rename and delete forever', …) // rename -> name; trash then deleteForever -> record gone
```

  Run `npm run build:e2e && npm run test:e2e -- tests/e2e/outline.spec.ts` → the new tests FAIL.

- [ ] **Step 2: Implement** per the Interfaces block.
- [ ] **Step 3: Verify** — the same command PASSES; `npm run test:e2e -- tests/e2e/bridge.spec.ts` still PASSES.
- [ ] **Step 4: Commit** — `feat(worker): hibernate, trash, open, rename, delete, and place commands`

---

### Task 9: View model from the outline; the view follows the worker

**Files:**
- Modify: `src/model/types.ts`, `src/model/buildTree.ts`, `src/model/duplicates.ts`, `src/model/moveSelection.ts` (field renames only), `src/model/visibleRows.ts`, `src/view/App.tsx`, `src/view/chrome/chromeSource.ts`, `src/view/components/{WindowCard,GroupRow,TabRow}.tsx`, `src/view/hover/HoverCard.tsx`, all affected `src/model/__tests__/*.test.ts`, `tests/e2e/{tree,move,preview}.spec.ts`, `tests/e2e/fixtures.ts`
- Create: `src/view/chrome/outlineClient.ts`, `src/model/__tests__/outlineState.ts` (builder of `OutlineState` for model tests)

**Interfaces:**
- Consumes: `OutlineState`, `OUTLINE_PORT`, `OUTLINE_COMMAND`, `OutlineCommand`, `OutlineCommandReply` (Task 6).
- Produces (`src/model/types.ts`; `RawWindow`, `RawTab`, `RawSnapshot` are deleted, `RawGroup` too unless still used):

```ts
export interface TabNode {
  kind: 'tab'; key: string /* `t:${id}` */; id: string;
  tabId?: number; windowId?: number;     // Chrome IDs, live only
  title: string; url: string;
  active: boolean; discarded: boolean; lastAccessed?: number;
  hibernated: boolean;
}
export interface GroupNode {
  kind: 'group'; key: string /* `g:${id}`, later runs `g:${id}#n` */; id: string;
  chromeGroupId?: number; title: string; color: GroupColor;
  chromeCollapsed: boolean;              // GroupRec.collapsed (Chrome's flag while live)
  hibernated: boolean;                   // no live tabs
  tabs: TabNode[];
}
export interface WindowNode {
  kind: 'window'; key: string /* `w:${id}` */; id: string;
  windowId?: number; label: string; name?: string;
  focused: boolean; hibernated: boolean; // hibernated = state !== 'live'
  closedAt?: number;                     // trash entries
  tabCount: number; children: (GroupNode | TabNode)[];
}
export interface OutlineView { windows: WindowNode[]; trash: WindowNode[] }
```

- `buildTree(state: OutlineState): OutlineView` — `windows`: non-trashed records in outline order, `label = name ?? \`Window ${n}\`` (n = 1-based position among them); `trash`: trashed records sorted by `closedAt` desc, `label = name ?? first tab's title`. Group runs as today. `active/discarded/lastAccessed` from `state.live.tabs[tabId]`; `focused` = `windowId === state.live.focusedWindowId`. Tab `title` falls back to `url`; group title to `'Untitled group'`.
- `findDuplicates`: live tabs only (skip `tabId === undefined`); the focus rule compares `TabNode.windowId` with the focused window's `windowId`.
- `moveSelection.ts`: same algorithm, reading `GroupNode.chromeGroupId` and `TabNode.tabId!`; `isWholeGroup` compares group `id`s. Hibernated tabs have no `tabId`, so until Task 10 the drag and drop handlers ignore hibernated rows: they get no drag props and are not drop targets (live rows only, as today). Task 10 lifts this.
- `outlineClient.ts` (a view module allowed to touch `chrome.runtime`):

```ts
/** Connects to the worker's outline port; calls onState on every broadcast; reconnects (100ms, then
 *  doubling to 2s) when the port drops, e.g. the worker restarted. Returns an unsubscribe. */
export function subscribeOutline(onState: (s: OutlineState) => void): () => void;
export function sendOutlineCommand(c: OutlineCommand): Promise<void>; // rejects on { ok: false }
```

- `chromeSource.ts`: delete `snapshot`, `subscribe`, focus tracking, and the self-window logic; keep `activateTab`, `focusWindow`, `applyMoveOps`, `closeTabs`.
- Rows render Chrome IDs for tests and debugging: `data-window-id` / `data-group-id` / `data-tab-id` when live, plus the existing `data-key`.
- `HoverCard`: for a tab without `tabId`, show the stored preview by URL if any, never request a capture or read a capture outcome.
- `App.tsx`: `subscribeOutline` replaces `snapshot`/`subscribe`/`buildTree(snapshot)`; `tree = view.windows`. Activate/focus use the node's Chrome IDs and do nothing when absent (Task 11 adds open). Keep App under ~320 lines; move the subscription + `discardStaleOverrides` into a small hook in `outlineClient.ts` (`useOutline(): OutlineView`) if needed.

- [ ] **Step 1: Rewrite the model tests against the new shape.** `outlineState.ts` exports `state({ windows: [...] , live?: … })` taking Task 1 records (reuse `src/model/outline/__tests__/recs.ts`). Update `buildTree.test.ts` (add: `labels windows by name or position`, `hibernated tabs and groups are flagged`, `trash entries are newest first and labelled by name or first tab`), and switch `moveSelection`, `duplicates` (add: `hibernated tabs are never duplicates`), `filterTree` (add: `search covers hibernated rows`), `visibleRows`, `keyboardNav`, `hoverSignature` tests to build through it. Expected keys become record-ID based (`t:a`, `g:g1`, `w:w1`); `planMove` expectations keep Chrome IDs.
- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/model src/view` → FAIL (types/build).
- [ ] **Step 3: Implement** the model changes; then `outlineClient.ts`, the `chromeSource.ts` trim, `App`/components/`HoverCard`.
- [ ] **Step 4: Update the e2e locators.** Add to `fixtures.ts`: `liveRow(view, kind: 'window' | 'group' | 'tab', chromeId: number)` → `view.locator(\`[data-${kind}-id="${chromeId}"]\`)`. Replace every `[data-key="t:${id}"]`/`w:`/`g:` Chrome-ID locator in `tree.spec.ts`, `move.spec.ts`, `preview.spec.ts` with it. Assertions on visible text stay as they are.
- [ ] **Step 5: Verify** — `npx vitest run` PASS; `npm run typecheck && npm run lint` PASS; `npm run build:e2e && npm run test:e2e` all PASS (tree, move, preview, bridge, outline).
- [ ] **Step 6: Commit** — `feat(view): render the worker's outline, keyed by Tab Hammer IDs`

---

### Task 10: Drag and drop with hibernated rows

**Files:**
- Modify: `src/model/moveSelection.ts`, `src/model/__tests__/moveSelection.test.ts`, `src/view/App.tsx`, `src/view/components/useRowDrag.ts` (hibernated rows and window rows get drag props; today windows have `draggable: kind !== 'window'`), `tests/e2e/move.spec.ts`

**Interfaces:**
- Consumes: `Placement` (Task 5), `sendOutlineCommand` (Task 9), view types (Task 9).
- Produces:

```ts
export interface DropPlan { chrome: MoveOp[]; place: Placement | null }
export function planDrop(tree: WindowNode[], keys: readonly string[], target: DropTarget): DropPlan;
```

  `planMove` stays (now internal or exported for its tests). Task 9 made drag ignore hibernated rows; this task removes that restriction, so hibernated tabs/groups and window header rows are all draggable and valid targets. `planDrop`:
  0. **Window rows are draggable.** A window row (or a selection that includes one) is a unit that expands to all of that window's tabs, live and hibernated, in outline order; they move into the target with the same live/hibernated rules as any other drag (so `place` carries every tab, and `chrome` moves the live ones). Dropping a window onto itself, or onto a row inside it, is a no-fixed-point no-op. The emptied source window follows the Task 1/5 rules (a live window closes with its last tab; a hibernated one is deleted).
  1. Resolve units, the target window, the insertion point in its tabs (hibernated included) and the joined group exactly as `planMove` does today; same "no fixed point" early returns (→ `{ chrome: [], place: null }`).
  2. `place` is non-null when any moved tab is hibernated, the target window is hibernated, or the joined group has no `chromeGroupId`: `windowId` = target window `id`; `beforeTabId` = first non-moved tab at/after the insertion point, or null; `tabs` = moved tab IDs in unit order, `groupId` = joined group's `id`, else the moved group's `id` for group units, else null. The worker's `place` handler calls `placeTabs(outline, placement, Date.now(), crypto.randomUUID)` (Task 8).
  3. `chrome`: empty if the target window is hibernated. Otherwise run `planMove` on the **live projection**: the tree with hibernated tabs removed (and groups left empty dropped), keys narrowed to live tabs/groups, and the target mapped to a live row — a hibernated target tab maps to the next live tab after it in the same window (`before`), else the previous live one (`after`), else the window header (`inside`); a target group with no live tabs maps the same way from its position (the worker's `regroup` then makes the Chrome group).
  4. Pure-live drags into live windows yield exactly today's `planMove` ops with `place: null`.
- `App.tsx`: on drop, `applyMoveOps(plan.chrome)` then, if `plan.place`, `sendOutlineCommand({ cmd: 'place', placement: plan.place })`.

- [ ] **Step 1: Write the failing unit tests** (in `moveSelection.test.ts`):

```ts
it('pure-live drags plan exactly what planMove plans, with no placement', …)
it('a hibernated tab moves in the outline only', …) // chrome [], place.tabs [{ id: 'h', groupId: null }]
it('a mixed selection moves live tabs in Chrome and places all moved tabs in order', …)
it('dropping next to a hibernated tab anchors Chrome moves on the next live tab', …)
it('live tabs dropped into a hibernated window: no Chrome moves, placed there', …)
it('joining a group with no live tabs places the tabs into it', …)
it('dragging a window row moves all its tabs, live and hibernated, in order, into the target', …) // chrome moves only the live tabs; place.tabs lists every tab of the window in outline order; dropping a window onto itself plans nothing
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/model/__tests__/moveSelection.test.ts` → FAIL.
- [ ] **Step 3: Implement `planDrop`, wire App.**
- [ ] **Step 4: Add the e2e** in `move.spec.ts`: `dragging a live tab into a hibernated window hibernates it there` — hibernate window B via the `outlineCommand` hook, drag Alpha's row onto B's header, poll: Alpha's Chrome tab is gone and B's record lists Alpha's record (same id) last, hibernated. Also `dragging a window row moves all its tabs into another window` — window C holds a live tab and a hibernated tab; drag C's header onto window A's header; poll `readOutline`: A's record lists C's tab records (same ids, same order) after its own, C's record is gone, and C's live tab is now in A's Chrome window.
- [ ] **Step 5: Verify** — unit PASS; `npm run build:e2e && npm run test:e2e -- tests/e2e/move.spec.ts` PASS.
- [ ] **Step 6: Commit** — `feat: drag and drop hibernated rows`

---

### Task 11: Hibernated rows, hover toolbar, rename, keyboard

**Files:**
- Create: `src/view/components/RowToolbar.tsx`, `src/view/components/RenameField.tsx`
- Modify: `src/model/keyboardNav.ts`, `src/model/__tests__/keyboardNav.test.ts`, `src/view/App.tsx`, `src/view/components/{WindowCard,GroupRow,TabRow}.tsx`, `src/view/styles/theme.css`, `tests/e2e/outline.spec.ts`

**Interfaces:**
- Consumes: view types and `sendOutlineCommand` (Task 9).
- Produces:
  - `NavIntent` gains `{ type: 'trash'; key: string }` for `Delete` and `Backspace`.
  - `RowToolbar({ actions }: { actions: { label: string; icon: ReactNode; onClick: () => void }[] })` — a `div.row-toolbar` absolutely positioned at the row's right edge, shown by CSS on `.row:hover`; each a `<button aria-label={label}>` whose click and double-click and mousedown stop propagation (no selection, no drag start). Icons are small inline SVGs (builder's choice).
  - Labels (exact, tests use them): window rows `Rename window`, `Hibernate` (live only), `Move to trash`; tab rows `Hibernate` (live only), `Move to trash`; trash entries (Task 12) `Restore`, `Delete forever`.
  - `RenameField({ initial, onSave, onCancel })` — autofocused, text selected; Enter or blur → `onSave(value)`; Escape → `onCancel()`; `onKeyDown` stops propagation for every key so tree shortcuts never fire.
  - CSS: `.row { position: relative }`, `.row.hibernated { opacity: 0.5 }` (dims hibernated windows' headers, groups, and tabs), `.row-toolbar`, `.rename-field` sized to the title's box. No other row style changes.
  - App: `Delete`/`Backspace` → `sendOutlineCommand({ cmd: 'trash', ids })` for the selected rows' record IDs (the cursor row if nothing is selected). Enter/double-click on a hibernated window, group, or tab → `{ cmd: 'open', id }`; on live rows unchanged (activate/focus/toggle). Toolbar actions send `hibernate` / `trash` / start renaming.

- [ ] **Step 1: Write the failing unit test** in `keyboardNav.test.ts`: `Delete and Backspace mean trash the cursor row` (`navIntent(rows, 'k', 'Delete', false)` → `{ type: 'trash', key: 'k' }`; same for `Backspace`). Run `npx vitest run src/model/__tests__/keyboardNav.test.ts` → FAIL.
- [ ] **Step 2: Write the failing e2e** in `outline.spec.ts` (through the UI):

```ts
test('hover toolbar hibernates a window; it stays dimmed; double-click reopens it', …)
test('hibernate one tab, open just it, then open the rest of its window', async ({ sw, view }) => {
  // window [A, B, C]: Hibernate B (toolbar) -> B row has class hibernated, Chrome strip ['A','C'];
  // hibernate the window -> all dimmed; double-click B -> new Chrome window ['B'], A and C rows still
  // dimmed inside the same window row; double-click the window header -> Chrome strip ['A','B','C'].
});
test('rename field: Enter saves, Escape cancels, empty clears to Window N', …)
test('rename field keystrokes stay in the field', async ({ sw, view }) => {
  // select a tab row, open Rename on its window, type 'ab', press Backspace, Delete, Enter:
  // window label 'a'; the selected tab is still open in Chrome.  (Review Focus 1)
});
test('Delete trashes the selected tabs', …)
```

  Run `npm run build:e2e && npm run test:e2e -- tests/e2e/outline.spec.ts` → new tests FAIL.
- [ ] **Step 3: Implement** per the Interfaces block.
- [ ] **Step 4: Verify** — unit and e2e commands PASS; `npm run lint` PASS.
- [ ] **Step 5: Commit** — `feat(view): hibernated rows, hover toolbar, rename, Delete to trash`

---

### Task 12: Recently closed section

**Files:**
- Create: `src/view/components/RecentlyClosed.tsx`
- Modify: `src/view/App.tsx`, `src/view/components/useRowDrag.ts`, `src/view/styles/theme.css`, `tests/e2e/outline.spec.ts`

**Interfaces:**
- Consumes: `OutlineView.trash` (Task 9), `RowToolbar` (Task 11), `sendOutlineCommand`.
- Produces: `RecentlyClosed({ entries }: { entries: WindowNode[] })` rendered as the last child inside the scrolling `<main>` (after the window cards, also while searching, since search doesn't cover it — hide it while a query is active). A header row `Recently closed (N)` with a twisty, collapsed by default (local state); hidden when N is 0. Each entry: a dimmed row (`data-testid="trash-entry"`, its label and `N tabs`) with its own twisty (collapsed by default) showing its tabs as plain dimmed rows (title + favicon, no hover card, not selectable). Entry toolbar: `Restore` → `{ cmd: 'open', id }`; `Delete forever` → `{ cmd: 'deleteForever', windowId: id }`. Double-click an entry = Restore. Not `role="treeitem"` rows of the outline tree (use `role="group"`/`listitem` semantics so keyboard nav and selection ignore them). Trash rows are not drag sources or targets: `useRowDrag` (which Task 10 made accept window and hibernated rows) must never give them drag props or drop handling.

- [ ] **Step 1: Write the failing e2e:**

```ts
test('a closed window lands in Recently closed and Restore brings it back at the bottom', async ({ sw, view }) => {
  // create window W [Echo, Foxtrot]; chrome.windows.remove(W); expand 'Recently closed (1)';
  // entry shows 'Echo' and '2 tabs'; hover it, click Restore; poll Chrome: a window with
  // ['Echo','Foxtrot']; the outline's last window card holds Echo, Foxtrot; trash section gone.
});
test('Delete forever removes a trash entry', …)
```

  Run `npm run build:e2e && npm run test:e2e -- tests/e2e/outline.spec.ts` → FAIL.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** — same command PASS.
- [ ] **Step 4: Commit** — `feat(view): Recently closed section`

---

### Task 13: Restart E2E: browser restart re-link and worker restart

**Files:**
- Create: `tests/e2e/restart.spec.ts`
- Modify: `tests/e2e/fixtures.ts` (a relaunch helper), possibly `src/background/index.ts` (hooks only)

**Interfaces:**
- Consumes: `launchWithExtension(userDataDir)`, `readOutline`, `outlineCommand` helpers (Task 7), `simulateBrowserRestart` hook (Task 7).
- Produces: `relaunch(userDataDir): Promise<{ context, sw }>` in `fixtures.ts` if the real restart works.

- [ ] **Step 1: Feasibility check (time-boxed, ~30 min).** In a scratch spec (not committed), with a `fs.mkdtemp` profile: launch, open two windows of `data:text/html,<title>…</title>` tabs, `context.close()`, then relaunch the same dir both with `--restore-last-session` in `args` and, separately, with `Default/Preferences` containing `{"session":{"restore_on_startup":1}}` written before relaunch. Check whether the windows come back (`chrome.windows.getAll({ populate: true })` from the new worker) in headless new mode. Run it 5 times; it's "reliable" only if all 5 restore.
- [ ] **Step 2: Write the restart test** in `restart.spec.ts`:
  - **If real restore is reliable:** `a browser restart re-links restored windows to their rows` — build windows A (`[A1, A2]@Group`, A3) and B (`[B1, B2]`), rename A to `Work`, `readOutline` → remember A/B record IDs; close; relaunch; poll `readOutline` until A and B records are `live` with the same IDs, A named `Work`, no other record holds their Chrome window IDs, and neither is trashed. Don't assert on Playwright's own `about:blank` window (all-blank windows are never matched, so its old record stays in the trash).
  - **Else (deviation, report it):** `the fresh-launch path re-links open windows to their rows` — same setup in the default fixture, then call `simulateBrowserRestart` (every live window → trash marked open-at-shutdown, Chrome IDs stripped, then the still-open Chrome windows come in as unknown windows and must re-link); same assertions.
- [ ] **Step 3: Write `a rename survives a service-worker restart`** — rename a window via the UI, then stop the worker: `const cdp = await context.newCDPSession(view); await cdp.send('ServiceWorker.stopAllWorkers')`; wait for `context.waitForEvent('serviceworker')` (the view's reconnect wakes it). Assert: `readOutline` (through the new worker) shows the same record ID, `state: 'live'`, the name, and no trashed records (Review Focus 3); the view row shows the name. If `stopAllWorkers` doesn't stop an extension worker in this Playwright/Chromium, use CDP `Target.getTargets` + `Target.closeTarget` on the `service_worker` target; report whichever was used.
- [ ] **Step 4: Run** — `npm run build:e2e && npm run test:e2e -- tests/e2e/restart.spec.ts` PASS, three consecutive runs.
- [ ] **Step 5: Commit** — `test(e2e): re-link after a browser restart; outline survives a worker restart`

---

### Task 14: Docs and the full gate

**Files:**
- Modify: `CLAUDE.md` (repo root)

- [ ] **Step 1: Update `CLAUDE.md` "Architecture in one breath":** the service worker owns the outline (`src/background/outline/`): records with Tab Hammer IDs in IndexedDB `tab-hammer-outline`, reconciled with Chrome events through a serial queue, fresh launches told apart by `browserSession` (now the single instance in `src/background/session.ts`), restored windows re-linked after a quiet period by the pure matcher. The view no longer reads Chrome for the tree: it subscribes over the `tabHammer.outline` port (`src/view/chrome/outlineClient.ts`) and sends commands as runtime messages; `buildTree` turns the outline into the view model; `chromeSource.ts` keeps only direct live actions (activate, focus, move, close). Hibernate/trash/Recently closed in one sentence. Replace the "persistence (post-MVP) must introduce Tab Hammer's own node IDs" sentence. Note the bridge stays live-only.
- [ ] **Step 2: Update the Tests section:** unit tests now include `src/model/outline/` (lifecycle, matching, reconcile, match application, open/place) and `src/background/outline/` (store with `fake-indexeddb`, settle tracker); e2e adds `outline.spec.ts` and `restart.spec.ts` (state whether the restart test is real or simulated), the `readOutline`/`outlineCommand`/`simulateBrowserRestart` hooks, and `data-tab-id`/`data-window-id`/`data-group-id` locators for live rows.
- [ ] **Step 3: Run the gate** — `npm run gate` from the repo root. Expected: typecheck, lint, format check, unit, `build:e2e`, e2e all green. Fix anything red, including failures that look pre-existing or flaky (diagnose the cause; no retries, timeout bumps, or sleeps). Run `npm run format` if only formatting fails, then re-run the gate.
- [ ] **Step 4: Commit** — `docs: architecture for the persisted outline` (plus any gate fixes as their own commits). Report the gate name (`npm run gate`) and result.

---

## Self-review notes

- **Spec coverage:** lifecycle table → Tasks 1, 5, 8 (+ UI 11, 12); re-link (when / against what / launch URL / scoring / assignment / partial application) → Tasks 2, 3, 4, 7; model & storage, `exportOutline`, reconcile strategy → Tasks 1, 3, 6, 7; view (port, buildTree, Tab Hammer keys, commands, live actions) → Task 9; look (dim, names, Recently closed, toolbar, rename, keyboard, search incl. hibernated, duplicates live-only, drag) → Tasks 9–12; tests (unit lists, five e2e flows) → Tasks 1–5, 7, 8, 11–13; `webNavigation` warning check → Task 7; lazy reopen → Task 8.
- **Deviations to report at the end of execution:** flat `WindowRec.tabs/groups` instead of nested children; one shared settle quiet period; rename blur saves; a simulated restart if Task 13's feasibility check fails; any `webNavigation` fallback.
