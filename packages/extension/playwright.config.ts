import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Every test launches its own throwaway Chromium profile, so tests run in parallel, and CI's
  // shards split by test rather than by file.
  fullyParallel: true,
  // CI runners do nothing else, so one worker per core. Locally, a quarter of the cores: each worker
  // runs a whole Chromium (two for the sync tests), so more workers on a machine the developer is
  // still using don't finish sooner, they only starve each test until the slowest time out.
  workers: process.env.CI ? '100%' : '25%',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  // Hang guards, not speed limits. Every wait in the suite is on a state that is certain to arrive
  // (see AGENTS.md, Tests), so these only stop a test that is stuck; they sit far above any test's
  // real duration so a slow or busy machine can't fail one. Never tune them, and never set a
  // timeout on a single call: a test that gets anywhere near them is too big, so shrink it.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // No retries: a test that needs one is a test to fix or delete.
  retries: 0,
});
