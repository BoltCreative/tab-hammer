import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Tab Hammer',
  version: '0.1.0',
  description: 'Every window, group, and tab as a live outline in its own window.',
  permissions: ['tabs', 'tabGroups', 'storage', 'favicon'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  action: { default_title: 'Open Tab Hammer' },
});
