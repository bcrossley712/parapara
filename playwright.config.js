// Playwright config for the end-to-end tests in tests/e2e/.
// Dev/test tooling only — not part of the app, not published.
//
// Serves the repo with a tiny Node static server (tests/e2e/serve.js)
// so there's no Python or extra package dependency, and runs the real
// app in headless Chromium at the 9th-gen iPad's landscape viewport.

import { defineConfig, devices } from '@playwright/test';

const PORT = 8765;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  // One test at a time: the update tests change the test server's
  // simulated deploy version, which every open page would notice.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1080, height: 810 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1080, height: 810 } } },
  ],
  webServer: {
    command: `node tests/e2e/serve.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
