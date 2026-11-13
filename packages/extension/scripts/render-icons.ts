// Renders the icon PNGs the manifest uses (icons/icon-<size>.png) from the committed SVGs, with
// the Chromium Playwright already installs for e2e. Run after editing either SVG:
//   npm run render-icons -w @tab-hammer/extension
// icon.svg is the full drawing (gradient tile, shadow, shaded hammer). icon-16.svg is a flat
// redraw on the 16px grid: at 16px the full drawing's thin handle falls between pixels and
// blurs. 32px keeps the full drawing, since Chrome draws the toolbar icon at 16pt, which is 32px
// on a Retina screen.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Keep in step with ICONS in src/manifest.ts.
const ICON_SOURCES = {
  16: 'icon-16.svg',
  32: 'icon.svg',
  48: 'icon.svg',
  128: 'icon.svg',
} as const;

const dir = path.resolve(import.meta.dirname, '../icons');
const browser = await chromium.launch({ channel: 'chromium' });
try {
  const page = await browser.newPage();
  for (const [size, source] of Object.entries(ICON_SOURCES)) {
    const svg = await readFile(path.join(dir, source), 'utf8');
    await page.setViewportSize({ width: Number(size), height: Number(size) });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: true });
  }
} finally {
  await browser.close();
}
