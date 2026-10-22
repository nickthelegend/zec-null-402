import { defineConfig } from '@playwright/test';

// Real Google Chrome (channel: 'chrome') against the real Kippu stack from ./stack.sh. Nothing is mocked:
// the gateway checks the published deposit on Zcash testnet with its viewing key, and the anchor is read
// from lightwalletd with the published anchor viewing key.
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    channel: 'chrome',
    headless: true,
    video: 'on',
    trace: 'on',
    screenshot: 'on',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    // The gateway spec claims the one published deposit on one gateway database, so it runs once (desktop).
    { name: 'mobile', testIgnore: /gateway\.spec/, use: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
});
