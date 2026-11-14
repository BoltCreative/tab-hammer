import { defineManifest } from '@crxjs/vite-plugin';
import {
  DRIVE_SCOPE,
  GOOGLE_OAUTH_CLIENT_ID,
  STORE_GOOGLE_OAUTH_CLIENT_ID,
} from './shared/syncConfig.ts';

const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

// `npm run build:store` (TAB_HAMMER_STORE=1): the Chrome Web Store upload. The store refuses a
// manifest `key` and assigns its own extension ID, so that build leaves the key out and signs in
// to Drive with the OAuth client made for the store's ID instead of the dev one.
const STORE = Boolean(process.env.TAB_HAMMER_STORE);
const OAUTH_CLIENT_ID = STORE ? STORE_GOOGLE_OAUTH_CLIENT_ID : GOOGLE_OAUTH_CLIENT_ID;

// The release version, bumped by `npm run release` (scripts/release.ts at the repo root), together
// with every package.json.
const RELEASE = '0.1.1';
// CI's store uploads (.github/workflows/release.yml) add a fourth part, TAB_HAMMER_BUILD: main's
// commit count, so every upload is above the last one (the store refuses a reused version) without
// a commit to bump it. Chrome allows each part 0 to 65535.
const BUILD = process.env.TAB_HAMMER_BUILD;
if (BUILD !== undefined && !(/^(0|[1-9]\d{0,4})$/.test(BUILD) && Number(BUILD) <= 65535))
  throw new Error(`TAB_HAMMER_BUILD must be a whole number from 0 to 65535, not "${BUILD}"`);

export default defineManifest({
  manifest_version: 3,
  name: 'Tab Hammer',
  version: BUILD === undefined ? RELEASE : `${RELEASE}.${BUILD}`,
  description:
    'Every window, group, and tab as a live outline, in its own window or docked in the side panel.',
  // Pins the extension ID (lpnkidobhhpmokecbinbliomjehmndia) no matter which folder Chrome loads it
  // from, so storage, previews, and permission grants survive switching between the repo root and
  // worktrees. Only the public key; unpacked loading never needs the private half. Never in the
  // store build (see STORE above).
  ...(!STORE && {
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs4wQbuDs9/x62KnKFDHHTdP8GJQplCTUNzSIu4vCokje6D5LbFwDeVPbRzvpTKn6qiOXYwck+AcZtPCsXPGIyhDMDzQ/tyXWI60Kor4g4XeEsOp4kjZ070hL4o5NnudOJlX0rDmmN0q933qoLYRgH4/26BOPnFRpHRkrM4njnxL91k1Q9aH+wyjx2RYFj1Xdtk1g/xA5K116Cl+v6SCcbW6tZCKpYtMQp2hLdc4CCPYwTZeKtnF4G+0Z01M584t2dTyupVOyMBInWY4hr5Z04GiIPu6bk9wRzO2WK6hrg0UJwzj9uLwJxfgJS0xjqlBycZqXRpaxWopY6oxSLVp6awIDAQAB',
  }),
  // Why each permission (docs/store/listing.md has the store's justifications):
  // tabs: reading every tab's title and URL for the outline, and moving, closing, and opening tabs.
  // tabGroups: showing, renaming, and rearranging tab groups.
  // storage: settings, the panel layout, sync bookkeeping, and capture outcomes.
  // favicon: tab icons from Chrome's own favicon cache (chrome-extension://…/_favicon/), so no
  // page is fetched for them.
  // debugger: screenshots of background tabs (CDP Page.captureScreenshot), attached one tab at a
  // time and only during the Capture missing / Refresh all runs the user starts, never on hover.
  // It can't be optional: Chrome refuses chrome.permissions.request for debugger ("Only
  // permissions specified in the manifest may be requested") even when it's listed under
  // optional_permissions.
  // nativeMessaging: the bridge to Claude's MCP server (packages/mcp). The service worker connects
  // on its own at startup, so it must be granted up front.
  // system.display: reopening the view window on a visible screen if its saved spot is gone.
  // webNavigation: each tab's launch URL (its first committed address), for re-linking windows
  // Chrome restores to their saved rows. Its "Read your browsing history" warning is already
  // covered by tabs' warning, so it adds no install prompt line.
  // identity: the Chrome profile's Google sign-in (getAuthToken) for Drive sync. No install
  // warning; Google's consent screen asks for the Drive app-data scope the first time. Required,
  // not optional: a fresh install restores itself from Drive with a silent (non-interactive)
  // token, before the user has clicked anything.
  // alarms: pulling the other computers' outlines every 5 minutes. No install warning.
  // sidePanel: docked mode, the outline in Chrome's side panel (src/background/dock.ts). No
  // install warning.
  // contextMenus: the toolbar icon's right-click "Side panel: left or right…". No install warning.
  // "Copy all URLs" needs no clipboardWrite: navigator.clipboard.writeText from a click in the
  // view is allowed without it.
  permissions: [
    'tabs',
    'tabGroups',
    'storage',
    'favicon',
    'debugger',
    'nativeMessaging',
    'system.display',
    'webNavigation',
    'identity',
    'alarms',
    'sidePanel',
    'contextMenus',
  ],
  // sessions: the devices panel's Chrome Sync devices (chrome.sessions.getDevices, the open tabs on
  // the user's phones and other computers) and reopening them here. Optional because its install
  // warning ("Read your browsing history on all your signed-in devices") is the broadest one, for
  // a feature many people never open: the devices panel asks for it from a click
  // (src/view/chrome/permissions.ts), and the worker reads no devices until it's granted.
  optional_permissions: ['sessions'],
  // Drive sync's sign-in, only once a client ID is set (src/shared/syncConfig.ts): an empty
  // client ID never ships. The e2e build leaves it out too (TAB_HAMMER_NO_OAUTH), so tests can only
  // reach the fake Drive they serve, never Google. Without it the worker reports Drive sync off.
  ...(OAUTH_CLIENT_ID !== '' &&
    !process.env.TAB_HAMMER_NO_OAUTH && {
      oauth2: { client_id: OAUTH_CLIENT_ID, scopes: [DRIVE_SCOPE] },
    }),
  // Screenshots of each window's visible tab (captureVisibleTab) need host access to the page
  // being captured. The user can withhold it; the view then shows a banner to grant it.
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  // Rendered from icons/icon.svg by scripts/render-icons.ts.
  icons: ICONS,
  action: { default_title: 'Open Tab Hammer', default_icon: ICONS },
  // A keyboard shortcut for the toolbar click: it opens or focuses the standalone window, or,
  // docked, opens the side panel in the current window (openPanelOnActionClick covers it too).
  // Alt+Shift+T would be Chrome's own focus-the-toolbar key on Windows and Linux, where Chrome leaves
  // a clashing shortcut unset. Rebindable at chrome://extensions/shortcuts.
  commands: {
    _execute_action: {
      suggested_key: { default: 'Alt+Shift+H' },
      description: 'Open Tab Hammer, or bring it to the front',
    },
  },
  // The same view, docked (src/view/panel.html marks it as the panel surface).
  side_panel: { default_path: 'src/view/panel.html' },
});
