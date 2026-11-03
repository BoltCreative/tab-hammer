// Renders icons/icon.svg to the PNG sizes the manifest uses (icons/icon-<size>.png), with the
// Chromium Playwright already installs for e2e. Run after editing the SVG:
//   npm run render-icons -w @tab-hammer/extension
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Keep in step with ICONS in src/manifest.ts.
const ICON_SIZES = [16, 32, 48, 128] as const;

const dir = path.resolve(import.meta.dirname, '../icons');
const svg = await readFile(path.join(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch({ channel: 'chromium' });
try {
  const page = await browser.newPage();
  for (const size of ICON_SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: true });
  }
} finally {
  await browser.close();
}
