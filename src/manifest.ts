import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Tab Hammer',
  version: '0.1.0',
  description: 'Every window, group, and tab as a live outline in its own window.',
  // debugger: on-demand hover previews of background tabs (CDP Page.captureScreenshot).
  permissions: ['tabs', 'tabGroups', 'storage', 'favicon', 'debugger'],
  // captureVisibleTab (hover previews) needs host access to the page being captured.
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  action: { default_title: 'Open Tab Hammer' },
});
