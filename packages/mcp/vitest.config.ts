import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    // The installer tests deploy the built package (dist/), as `npx tab-hammer-mcp` would.
    globalSetup: ['src/__tests__/buildPackage.setup.ts'],
  },
});
