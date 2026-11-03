import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.ts';
import { faviconPassthrough } from './build/faviconPassthrough.ts';

// `npm run dev` writes to one fixed folder outside the repo, shared by the root checkout and every
// worktree. Chrome loads it once; switching trees is just restarting the dev server in another tree
// (the running extension reloads itself when the server comes back). `npm run build` keeps writing
// dist/, and the gate's build:e2e overrides outDir with dist-e2e/.
const DEV_OUT_DIR =
  process.env.TAB_HAMMER_DEV_DIR ?? path.join(os.homedir(), '.tab-hammer', 'dist');

export default defineConfig(({ command }) => ({
  plugins: [react(), crx({ manifest }), faviconPassthrough()],
  build: {
    ...(command === 'serve' && { outDir: DEV_OUT_DIR, emptyOutDir: true }),
    rollupOptions: {
      input: { view: 'src/view/index.html' },
    },
  },
  server: { port: 5174, strictPort: true },
}));
