import { defineManifest } from '@crxjs/vite-plugin';

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
  permissions: [
    'tabs',
    'tabGroups',
    'storage',
    'favicon',
    'debugger',
    'clipboardWrite',
    'nativeMessaging',
  ],
  // captureVisibleTab (hover previews) needs host access to the page being captured.
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  action: { default_title: 'Open Tab Hammer' },
});
