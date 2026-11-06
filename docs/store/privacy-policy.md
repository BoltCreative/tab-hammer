# Tab Hammer privacy policy

_Last updated: 2026-11-06_

Tab Hammer is a Chrome extension that shows your windows, tab groups, and tabs as an outline. It is
published by Bolt Creative. This policy describes every piece of data Tab Hammer handles, where it
goes, and how to delete it.

**The short version:** Tab Hammer has no server and no analytics. Nothing is ever sent to Bolt
Creative. Your data stays in your browser, except what you choose to put in your own Google Drive
(optional sync) or hand to Claude Code on your own computer (optional Claude bridge).

## What Tab Hammer stores on your computer

All of this lives in your Chrome profile, in Tab Hammer's own extension storage (IndexedDB and
`chrome.storage`), and is readable only by Tab Hammer:

- **Your outline:** your windows, tab groups, and tabs: each tab's address (URL) and title, each
  group's name and colour, any names you give windows, hibernated windows and tabs, and the Recently
  closed list (kept for seven days).
- **Tab previews:** screenshots of pages, taken when a page is on screen in a window, or when you
  run Capture missing or Refresh all. A preview is kept as long as a window in your outline (open,
  hibernated, or recently closed) still has a tab at that address, and deleted after that.
- **Settings and bookkeeping:** where the Tab Hammer window sits, the preview panel's size, this
  computer's name for sync, sync status, and the outcome of recent screenshot attempts.
- **Sync cache and checkpoints** (if you use sync or the devices panel): local copies of your other
  computers' outlines, and dated snapshots ("checkpoints") of this computer's outline.

**Incognito:** Tab Hammer never takes or stores screenshots of incognito pages. Chrome doesn't let
extensions see incognito windows at all unless you turn on "Allow in Incognito" for Tab Hammer in
`chrome://extensions`; if you do, incognito windows appear in your outline (and in sync, if it's on)
like any other window, but are still never screenshotted.

## Optional: sync through your Google Drive

If you sign in to sync, Tab Hammer uses your Chrome profile's Google account (through Chrome's own
sign-in, `chrome.identity`) with one permission: `drive.appdata`. That gives Tab Hammer a hidden
app-data folder in **your own** Google Drive, and nothing else: it cannot see, read, or change any
of your other Drive files.

Into that folder Tab Hammer writes:

- one file per computer with that computer's outline: tab addresses and titles, group names and
  colours, window names, hibernated and recently closed windows, the computer's name, and its
  operating system (for example "mac");
- checkpoints: dated snapshots of the same outline.

Previews (screenshots) are **never** uploaded. Tab Hammer talks directly to Google's Drive API
(`www.googleapis.com`) from your browser; there is no Tab Hammer server in between. Google's
handling of your Drive is covered by Google's own privacy policy.

Tab Hammer's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Optional: your other Chrome Sync devices

The devices panel can show the tabs open on your phone and other computers, as Chrome Sync reports
them (`chrome.sessions`). Tab Hammer only reads them after you click "Show your phones and other
Chrome Sync devices" and grant Chrome's permission. They are shown read-only and are not stored or
uploaded by Tab Hammer; Chrome Sync itself is Google's service.

## Optional: the Claude bridge

If you install Tab Hammer's MCP server for Claude Code (a separate install step; nothing happens
without it), Claude Code on your computer can list, open, move, group, and close your tabs. The
extension talks to a small helper program on your computer through Chrome's native messaging, and
that helper talks to Claude Code over a local socket in your home folder. Nothing in this path goes
through the network or to Bolt Creative.

What Claude Code does with the tab titles and addresses it reads is up to Claude Code and the
model provider you use with it, under their own terms. It only reads them when it uses Tab Hammer's
tools in a conversation. Hibernated and recently closed rows are never shared with it.

## What Tab Hammer does not do

- No analytics, telemetry, crash reporting, advertising, or tracking.
- No remote code: everything Tab Hammer runs ships inside the extension.
- No data sold or shared with anyone. Nothing is sent to Bolt Creative.
- Tab Hammer does not read page contents, form data, passwords, cookies, or Chrome's browsing
  history (only the addresses and titles of the tabs in your outline). Screenshots are images of
  how a page looks, stored only on your computer.

## Deleting your data

- **Previews:** Actions menu → Clear previews.
- **Everything on this computer:** remove Tab Hammer from `chrome://extensions`. Chrome deletes all
  of its storage, outline, previews, and settings included.
- **Drive sync data:** in Google Drive, open Settings → Manage apps, find Tab Hammer, and choose
  Options → Delete hidden app data. To stop syncing, also choose Disconnect from Drive.
- **Chrome Sync devices access:** in `chrome://extensions`, open Tab Hammer's Details and remove
  the permission, or remove the extension.

## Changes

This policy is published at <https://boltcreative.com/tab-hammer/privacy>. If it changes, the new
version will be published there with a new date.

## Contact

Questions about this policy: support@boltcreative.com.
