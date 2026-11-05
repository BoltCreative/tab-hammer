# Sync the outline across computers, with backup and checkpoints

**Date:** 2026-11-05
**Ticket:** SKULL-814 (sync the outline across computers, with online backup)
**Status:** Agreed in brainstorm, pending implementation plan
**Builds on:** `2026-11-03-persist-outline-design.md` (SKULL-811/822)

## Why

The persisted outline lives in one Chrome profile's IndexedDB. Nothing leaves the machine: a wiped profile or a dead laptop loses every hibernated window, name, and trash entry, and the user can't see on one computer what they put away on another. The user also wants to see what's open on their other devices, iPhone and iPad included, the way Chrome's "tabs from other devices" does.

## Goals

- **Device picker:** see any of the user's devices' outlines, read-only, and pull a single window or tab onto this computer.
- **Other devices' live tabs** (any Chrome Sync device, iOS included) through `chrome.sessions`, with no Drive and no sign-in.
- **Drive sync** of each Tab Hammer computer's full outline (live, hibernated, and trash; names; groups) for state Chrome Sync doesn't know about.
- **Backup and restore:** a reinstalled or replaced computer can take over an old computer's outline. A computer whose local data is wiped restores itself.
- **Checkpoints:** dated snapshots of this computer's outline, viewable and restorable, to undo "I deleted a bunch of stuff" beyond what Recently closed holds (deleted tabs, deleted hibernated tabs, anything older than 7 days).

## Non-goals

- Editing another computer's outline (rename, delete, hibernate there). Other devices are read-only.
- Moving a window between computers. "Open here" copies; the original stays until it's deleted on its own computer.
- Showing other computers' trash.
- Tab groups on Chrome Sync-only devices (`chrome.sessions` doesn't report them).
- The MCP bridge. It stays live-only and local.

## Anti-goals

- Sync must never lose or rewrite local data. Nothing a remote file says changes this computer's outline except an explicit Restore all / take-over, or the self-restore of a computer with an empty outline.
- A malformed file is never uploaded and never read in.
- Tests never hit real Google APIs.

## Decisions (agreed with the user)

### Ownership: one file per computer, single writer

Each Tab Hammer install writes one Drive file, `outline-<installId>.json`, and only that install writes it. Other installs only read it. Two computers never write the same record, so there's no conflict resolution: no last-writer-wins, no tombstones. (The alternative, a shared outline merged per record, was rejected: it brings a window live on two computers, delete-vs-edit races, and move semantics nobody asked for.)

The per-install ID (`chrome.storage.local`, already created by SKULL-811) is the computer's identity.

### Storage and auth: Google Drive app-data folder via `chrome.identity`

- The hidden app-data folder (`appDataFolder` space), scope `https://www.googleapis.com/auth/drive.appdata` only. Free, per-app, invisible in the user's Drive.
- `chrome.identity.getAuthToken` with the Chrome profile's signed-in Google account. No separate login screen. Requires the `identity` permission and `oauth2.client_id` in the manifest.
- **User setup (one time, the user's to do):** a Google Cloud project with the Drive API enabled, an OAuth consent screen (Internal for a Workspace account, so tokens don't expire after 7 days as in Testing), and an OAuth client of type "Chrome extension" for extension ID `lpnkidobhhpmokecbinbliomjehmndia` (pinned by the manifest key). The client ID is not secret and gets committed. Until it's filled in, Drive sync is off and the picker shows device tabs and checkpoints only.
- The Drive transport sits behind an interface (`SyncBackend`: list files with modified times, read, write, delete). Production uses Drive's REST API with `fetch`. Unit and e2e tests use an in-memory or test-served fake.

### Two sources, one picker

| Source | Covers | Needs |
|---|---|---|
| `chrome.sessions.getDevices()` | Every Chrome Sync device's open windows and tabs, iOS included; live only; up to 25 sessions per device; no groups | `sessions` permission, Chrome Sync with open tabs on. No Drive, no sign-in. |
| Drive files | Each Tab Hammer computer's full outline: live, hibernated, names, groups, trash | `identity` permission, OAuth client ID, signed-in Chrome profile |

Both ship in this PR, device tabs built first. When a Chrome Sync device and a Tab Hammer computer are the same machine, the Tab Hammer entry is the one shown (fuller outline). They're linked by name: the Tab Hammer computer's name, defaulted from its Chrome Sync device name when one can be inferred, else the platform ("Mac").

`chrome.sessions` has no change event for synced devices, so it's re-read whenever the picker opens and while a device is being viewed.

### The picker

A small "This computer ▾" dropdown in the fixed header. It lists:
- **This computer** (the normal, editable outline). Its name is renameable here.
- **Checkpoints…** under this computer.
- Each other Tab Hammer computer, with "synced 5 min ago".
- Each Chrome Sync-only device (iPhone, iPad, other browsers).
- **Sign in to sync** when Drive sync is configured but not signed in, or a status line when it's off or failing.

Picking anything but This computer swaps the outline list for that device's outline, read-only, with a banner naming it and a way back. In that view:
- **Open here** (double-click or Enter, or a hover button) on a window or tab opens a copy on this computer: new Tab Hammer IDs, live. For Chrome Sync-only devices it uses `chrome.sessions.restore` where it can, else opens the URLs.
- **Restore all** (Tab Hammer computers and checkpoints): every window of that outline that isn't already in this computer's outline (by Tab Hammer ID) comes in as hibernated, at the bottom. It adds, never replaces. For another computer this is the "take over" of a reinstalled or replaced machine, and it then retires that computer's file (after a confirmation in the banner).
- **Forget** (other Tab Hammer computers only): deletes that computer's file from Drive. If that computer is still alive, it simply re-uploads.

The parallel UX session is building a header menu (SKULL-842). The picker stays small and self-contained so it can be folded into that menu later.

### Cadence

- **Push** this computer's file about 10s after the outline last changed (debounced), and on worker startup if there are unpushed changes.
- **Pull** the other computers' files on startup, when the picker opens, while viewing a remote computer, and every 5 minutes (`chrome.alarms`). Listing first, so only files whose Drive modified time changed get downloaded.

### Offline and signed out

Everything local works exactly as today. Pushes are retried later (a dirty flag persisted in `chrome.storage.local`). The picker still shows each Tab Hammer computer's last downloaded outline (cached locally) with its age, and Chrome Sync devices as Chrome reports them.

### Self-restore

If this computer's outline is empty at startup (fresh IndexedDB) and its own file exists in Drive, the outline is restored from that file: every window hibernated (Chrome IDs are meaningless), trash kept. A checkpoint is taken first (of the empty state, trivially) and of the file. If the install ID itself was lost, it's a new computer, and the old one shows in the picker for Restore all.

### Checkpoints

- A checkpoint is a dated snapshot of this computer's exported outline. Kept both locally (IndexedDB, works without sign-in) and in Drive (`checkpoint-<installId>-<date>.json`).
- One a day when the outline changed. Retention: 14 daily, then 8 weekly.
- An extra checkpoint before anything drastic: a push that would drop more than half of the previously pushed windows, a Restore all, a self-restore.
- Viewing a checkpoint is the same read-only view as another device, with its date and window/tab counts. Open here and Restore all work the same way.

### Validation

Every file is validated against the sync schema (version, shape, field types) before it's uploaded or read in. A file that fails is skipped and reported in the picker's status line, never applied. A file from a newer schema version is shown as "needs a newer Tab Hammer" and not read.

### File format

```json
{
  "schemaVersion": 1,
  "installId": "…",
  "computerName": "Mac",
  "platform": "mac",
  "updatedAt": 1730851200000,
  "windows": [ /* exportOutline()'s SyncWindow[], trash included */ ]
}
```

Checkpoints use the same shape plus `checkpointAt`.

## Tests

- **Unit (pure):** schema validation (good, malformed, newer version); Restore all (adds missing, skips present IDs, all hibernated, trash handling, no mutation of existing windows); Open-here copy (fresh IDs, groups kept); checkpoint retention (daily/weekly pruning across month and year edges, the drastic-drop trigger); device list assembly (Tab Hammer computer preferred over the same-named Chrome Sync device, self excluded, sort); push debounce and retry with a fake clock; self-restore conditions.
- **Sync engine against an in-memory `SyncBackend`:** two simulated installs pushing and pulling; offline backend (throws) then recovery; a corrupt remote file is skipped; forget and take-over.
- **E2E (real Chromium, headless):** two installs (two profiles) against one fake backend served by the test: install A's hibernated window appears in B's picker; Open here copies it live; Restore all brings A's windows in hibernated; a checkpoint view restores a deleted window. Chrome Sync devices can't be produced headless, so the picker's device-tab path is covered by unit tests with a stubbed `chrome.sessions`.

## Left to the builder

Module and message names, the exact debounce and alarm periods, how the fake backend is injected in e2e, the icon for the picker, and commit split.
