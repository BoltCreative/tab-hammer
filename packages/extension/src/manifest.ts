import { defineManifest } from '@crxjs/vite-plugin';
import { DRIVE_SCOPE, GOOGLE_OAUTH_CLIENT_ID } from './shared/syncConfig.ts';

const ICONS = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png',
};

export default defineManifest({
  manifest_version: 3,
  name: 'Tab Hammer',
  version: '0.1.0',
  description: 'Every window, group, and tab as a live outline in its own window.',
  // Pins the extension ID (lpnkidobhhpmokecbinbliomjehmndia) no matter which folder Chrome loads it
  // from, so storage, previews, and permission grants survive switching between the repo root and
  // worktrees. Only the public key; unpacked loading never needs the private half.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs4wQbuDs9/x62KnKFDHHTdP8GJQplCTUNzSIu4vCokje6D5LbFwDeVPbRzvpTKn6qiOXYwck+AcZtPCsXPGIyhDMDzQ/tyXWI60Kor4g4XeEsOp4kjZ070hL4o5NnudOJlX0rDmmN0q933qoLYRgH4/26BOPnFRpHRkrM4njnxL91k1Q9aH+wyjx2RYFj1Xdtk1g/xA5K116Cl+v6SCcbW6tZCKpYtMQp2hLdc4CCPYwTZeKtnF4G+0Z01M584t2dTyupVOyMBInWY4hr5Z04GiIPu6bk9wRzO2WK6hrg0UJwzj9uLwJxfgJS0xjqlBycZqXRpaxWopY6oxSLVp6awIDAQAB',
  // debugger: on-demand hover previews of background tabs (CDP Page.captureScreenshot).
  // clipboardWrite: the window menu's "Copy all URLs".
  // nativeMessaging: the bridge to Claude's MCP server (packages/mcp).
  // history: deleting previews when the user clears Chrome's browsing history.
  // system.display: reopening the view window on a visible screen if its saved spot is gone.
  // webNavigation: each tab's launch URL (its first committed address), for re-linking windows
  // Chrome restores to their saved rows. Its "Read your browsing history" warning is already
  // covered by history's (and tabs') warning, so it adds no install prompt line.
  // sessions: the device picker's other devices (chrome.sessions.getDevices, Chrome Sync's open
  // tabs on the user's phones and other computers) and reopening them here. Adds the install
  // warning "Read your browsing history on all your signed-in devices".
  // identity: the Chrome profile's Google sign-in (getAuthToken) for Drive sync. No install
  // warning; Google's consent screen asks for the Drive app-data scope the first time.
  // alarms: pulling the other computers' outlines every 5 minutes. No install warning.
  permissions: [
    'tabs',
    'tabGroups',
    'storage',
    'favicon',
    'debugger',
    'clipboardWrite',
    'nativeMessaging',
    'history',
    'system.display',
    'webNavigation',
    'sessions',
    'identity',
    'alarms',
  ],
  // Drive sync's sign-in, only once a client ID is set (src/shared/syncConfig.ts): an empty
  // client ID never ships. The e2e build leaves it out too (TAB_HAMMER_NO_OAUTH), so tests can only
  // reach the fake Drive they serve, never Google.
  ...(GOOGLE_OAUTH_CLIENT_ID !== '' &&
    !process.env.TAB_HAMMER_NO_OAUTH && {
      oauth2: { client_id: GOOGLE_OAUTH_CLIENT_ID, scopes: [DRIVE_SCOPE] },
    }),
  // captureVisibleTab (hover previews) needs host access to the page being captured.
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  // Rendered from icons/icon.svg by scripts/render-icons.ts.
  icons: ICONS,
  action: { default_title: 'Open Tab Hammer', default_icon: ICONS },
});
