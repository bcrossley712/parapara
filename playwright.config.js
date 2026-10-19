// Playwright config for the end-to-end tests in tests/e2e/.
// Dev/test tooling only — not part of the app, not published.
//
// Serves the repo with a tiny Node static server (tests/e2e/serve.js)
// so there's no Python or extra package dependency, and runs the real
// app in headless Chromium at the 9th-gen iPad's landscape viewport.

import { defineConfig, devices } from '@playwright/test';

const PORT = 8765;

// Parallel since 2e (the suite passed ~1.7 min serially). Two groups:
// - 'app': everything but the update tests, fully parallel — each test
//   gets its own browser context, so its own IndexedDB and service
//   worker; nothing shared.
// - 'updates': the update tests change the test server's simulated
//   deploy version (serve.js /__test__/state), which every open page
//   would notice — so they run alone, one at a time, after 'app' is
//   done. A failing 'app' test therefore skips them; fix that first.
export default defineConfig({
  testDir: 'tests/e2e',
  // Two workers by default — the Claude sandbox has 2 CPUs, and canvas
  // work gets flaky when oversubscribed. E2E_WORKERS overrides.
  workers: Number(process.env.E2E_WORKERS) || 2,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1080, height: 810 },
  },
  projects: [
    {
      name: 'app',
      testIgnore: /updates\.spec\.js/,
      fullyParallel: true,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1080, height: 810 } },
    },
    {
      name: 'updates',
      testMatch: /updates\.spec\.js/,
      fullyParallel: false,
      dependencies: ['app'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1080, height: 810 } },
    },
  ],
  webServer: {
    command: `node tests/e2e/serve.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
