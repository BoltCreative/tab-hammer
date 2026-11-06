import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Every test launches its own throwaway Chromium profile, so tests run in parallel, and CI's
  // shards split by test rather than by file.
  fullyParallel: true,
  // CI runners do nothing else, so one worker per core. Locally, half the cores, leaving the rest
  // for the developer, who keeps working while the gate runs.
  workers: process.env.CI ? '100%' : '50%',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  retries: 0,
});
