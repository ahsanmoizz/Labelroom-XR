import { defineConfig } from '@playwright/test';
// Each suite starts its own loopback-only server and browser. These checks use
// synthetic services; they do not target production or require provider tokens.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  outputDir: process.env.LABELXR_E2E_OUTPUT_DIR || 'test-results',
  reporter: process.env.CI ? 'line' : 'list',
});
