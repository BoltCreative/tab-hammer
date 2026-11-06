# Outline sync: implementation plan

**Spec:** `docs/superpowers/specs/2026-11-05-outline-sync-design.md` (SKULL-814)
**Branch:** `dave/outline-sync`

Paths are relative to `packages/extension/`. Every task is test-first: write the failing test, make it pass, commit.

## Shape

- `src/model/sync/` (pure, no `chrome.*`): the sync file schema and validation, Restore all, the Open-here copy, checkpoint retention and the drastic-drop trigger, device list assembly.
- `src/background/sync/`: the `SyncBackend` interface, the Drive REST backend, an in-memory backend (unit tests), the sync engine (push, pull, checkpoints, self-restore, forget), the local sync store (IndexedDB `tab-hammer-sync`: other computers' cached files, local checkpoints, the last pushed file), the `chrome.sessions` device reader, and the worker wiring (port, messages, alarm, test hooks).
- `src/shared/syncMessages.ts`: port name, the picker state, commands.
- `src/shared/syncConfig.ts`: the OAuth client ID constant. Empty = Drive sync off, and the manifest leaves out its `oauth2` block (no invalid client ID ever ships).
- `src/view/sync/`: the picker (`DevicePicker.tsx`), the read-only outline of another device or checkpoint (`RemoteOutline.tsx`), and the sync client. App and AppHeader get one slot each, so the parallel header restyle (SKULL-841..844) stays easy to merge.

## Tasks

1. **Sync file schema.** `model/sync/schema.ts`: `SyncFile` (spec's format, `checkpointAt` optional), `validateSyncFile(unknown)` returning the file, `newer`, or `malformed` with a reason. Moves `SyncWindow` and the pure `toSyncWindow` out of `outlineStore.ts` into `model/sync/export.ts` (the store re-exports). Tests: good file, each malformed field, unknown state, group reference to a missing group, newer version, duplicate IDs.
2. **Restore all.** `model/sync/restore.ts`: `restoreWindows(outline, windows, { now, newId, keepTrash })`: windows whose ID isn't in the outline are appended hibernated (trashed ones skipped, or kept trashed for self-restore); colliding tab and group IDs get fresh ones; empty windows skipped; existing records untouched. Tests cover each.
3. **Open-here copy.** `model/sync/copy.ts`: `copyForOpen(window, rowId, { now, newId, installId })` → a hibernated `WindowRec` with fresh IDs holding the whole window, one group's tabs, or one tab (its group kept). Tests.
4. **Checkpoint retention and drastic drop.** `model/sync/checkpoints.ts`: local-calendar day and Monday-week keys; `pruneCheckpoints(list)`: newest per day for the 14 most recent days that have one (all of those days' pre-drastic checkpoints kept), then newest per week for the 8 most recent older weeks; `dailyCheckpointDue`; `isDrasticDrop(prev, next)` (more than half of the previously pushed open windows gone, at least 2). Tests across month and year edges, a week spanning New Year, idle gaps.
5. **Device list.** `model/sync/devices.ts`: `assembleDevices(self, computers, sessionDevices)`: other Tab Hammer computers newest first; Chrome Sync devices newest first, minus one named like a Tab Hammer computer or this computer; `sessionWindows(device)` converts `chrome.sessions` sessions into read-only windows. Tests.
6. **SyncBackend + memory backend + Drive backend.** `background/sync/backend.ts` (name-keyed list/read/write/delete), `memoryBackend.ts`, `driveBackend.ts` (appDataFolder, multipart create, media PATCH, name→ID cache, pagination, 401 → `removeCachedAuthToken` + one retry, injected `fetch` and token source, base URLs overridable for e2e). Unit tests on the Drive backend's requests with a fake `fetch`.
7. **Sync engine.** `background/sync/syncEngine.ts` with injected backend, store, clock, timers, outline access. Debounced push (10s), dirty flag (`chrome.storage.local`), skip when the export is unchanged, validation before upload, drastic-drop checkpoint of the last pushed file, daily checkpoint (local + Drive) with pruning, pull (list, download only changed modified times, validate, cache, drop vanished), re-push when this computer's own file is gone, self-restore (pending flag set on a fresh outline database; no push until resolved), restore all (checkpoint first), forget (outline file and its checkpoints), status. Tests against the memory backend: two installs, offline then recovery, corrupt and newer files skipped, forget and take-over, self-restore, debounce with a fake clock.
8. **Owner hooks.** `outlineOwner.ts`: `onChange` callback, `wasFresh`, commands `restoreWindows` and `openCopy` (copy, then open like a hibernated window).
9. **Devices.** `background/sync/devices.ts`: reads `chrome.sessions.getDevices`, restores a session (fallback: open the URLs). Unit tests with a stubbed `chrome`.
10. **Worker wiring + manifest.** `identity`, `sessions`, `alarms` permissions with comments; `oauth2` only when the client ID is set; `tabHammer.sync` port broadcasting picker state; sync command messages; 5-minute alarm; test hooks `useTestSync` (point the Drive backend at a test server with a fixed token) and `syncNow`.
11. **View.** Picker in the header, read-only remote outline with banner (name, age or checkpoint date and counts, Back, Restore all, Forget, take-over confirmation), Open here on rows (hover button, double-click, Enter), rename this computer, Sign in to sync / status line.
12. **E2E.** `tests/e2e/sync.spec.ts` + `tests/e2e/fakeDrive.ts`: two profiles against one fake Drive server in the test process. A's hibernated window in B's picker; Open here copies it live; Restore all brings A's windows in hibernated; a checkpoint view restores a deleted window.
13. **Docs + gate.** CLAUDE.md architecture and tests sections; `npm run gate`.
