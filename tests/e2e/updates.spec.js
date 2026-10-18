// End-to-end tests for the gear menu and app updates: the real app and
// its service worker in headless Chromium. The test server
// (tests/e2e/serve.js) simulates a deploy by changing the version
// stamped into sw.js.
//
// Run: npm run test:e2e
//
// Not covered (device-only): how iPadOS suspends, kills and relaunches
// home-screen apps around an update.

import { test, expect } from '@playwright/test';
import { setVisibility } from './helpers.js';

const INITIAL_VERSION = '0123456789abcdef0123456789abcdef01234567-20261018131500';
const NEW_VERSION = 'fedcba9876543210fedcba9876543210fedcba98-20261019090000';

async function setServerState(page, params) {
  const query = new URLSearchParams(params).toString();
  const res = await page.request.get(`/__test__/state?${query}`);
  expect(res.ok()).toBe(true);
}

// Opens the app and waits until the service worker controls the page
// (an installed app, as on the iPad — not a first-ever visit).
async function openInstalledApp(page) {
  await page.goto('/index.html');
  await page.locator('.pp-canvas').waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

const gear = (page) => page.getByRole('button', { name: 'Settings' });
const panel = (page) => page.getByRole('dialog', { name: 'Settings' });
const versionText = (page) => page.locator('.pp-settings__version');
const statusText = (page) => page.locator('.pp-settings__status');

async function drawStroke(page) {
  const box = await page.locator('.pp-canvas').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 12 });
  await page.mouse.up();
}

async function paintedPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.pp-layer--active');
    const d = c.getContext('2d').getImageData(700, 440, 520, 200).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
}

test.beforeEach(async ({ page }) => {
  await setServerState(page, { version: INITIAL_VERSION, slowInstallMs: 0 });
});

test.afterAll(async ({ request }) => {
  await request.get(`/__test__/state?version=${INITIAL_VERSION}&slowInstallMs=0`);
});

test('the rail has a gear instead of Clear, and the panel opens and closes', async ({ page }) => {
  await openInstalledApp(page);
  await expect(page.locator('.pp-tool-rail').getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);

  await expect(panel(page)).toBeHidden();
  await gear(page).click();
  await expect(panel(page)).toBeVisible();

  // Tap outside (on the canvas area) closes it, like the color picker.
  await page.locator('.pp-canvas-area').click({ position: { x: 20, y: 20 } });
  await expect(panel(page)).toBeHidden();
});

test('the panel shows which build is running', async ({ page }) => {
  await openInstalledApp(page);
  await gear(page).click();
  await expect(versionText(page)).toHaveText(/^0123456 · /);
});

test('Check for updates with nothing new says up to date', async ({ page }) => {
  await openInstalledApp(page);
  await gear(page).click();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(statusText(page)).toHaveText("You're up to date.");
});

test('Check for updates finds a new deploy, applies it and reloads into it', async ({ page }) => {
  await openInstalledApp(page);
  await setServerState(page, { version: NEW_VERSION });

  await gear(page).click();
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Check for updates' }).click(),
  ]);
  await page.locator('.pp-canvas').waitFor();

  await gear(page).click();
  await expect(versionText(page)).toHaveText(/^fedcba9 · /);
});

test('an update removes the old version\'s cache but never other apps\' caches', async ({ page }) => {
  await openInstalledApp(page);
  // A cache belonging to another app on the same origin (GitHub Pages
  // serves all of an account's projects from one origin).
  await page.evaluate(() => caches.open('some-other-app').then((c) => c.put('/x', new Response('x'))));
  await setServerState(page, { version: NEW_VERSION });

  await gear(page).click();
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Check for updates' }).click(),
  ]);
  await page.locator('.pp-canvas').waitFor();

  const keys = (await page.evaluate(() => caches.keys())).sort();
  expect(keys).toEqual([`parapara-${NEW_VERSION}`, 'some-other-app']);
});

test('returning to the foreground checks for updates and shows the toast', async ({ page }) => {
  await openInstalledApp(page);
  await setServerState(page, { version: NEW_VERSION });

  // Simulate leaving and coming back to the app.
  await setVisibility(page, 'visible');

  await expect(page.locator('#pp-update-toast')).toBeVisible({ timeout: 10000 });
});

test('an update that is mid-download when the app opens still shows the toast', async ({ page, context }) => {
  await openInstalledApp(page);
  // A new deploy whose install is slow, started from a second tab, so
  // the download is already underway *before* the app (re)opens.
  //
  // Caveat: in Chromium this passes even without updater.js's explicit
  // `watch(reg.installing)` — Chromium still notifies the reopened
  // page. So this guards the behavior, but doesn't prove that line is
  // needed; it's there for WebKit (iPad), which can't be tested here.
  await setServerState(page, { version: NEW_VERSION, slowInstallMs: 1000 });
  const other = await context.newPage();
  await other.goto('/index.html');
  await other.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
    if (!reg.installing) throw new Error('expected an install to be in progress');
  });
  await other.close();

  await page.reload();
  await page.locator('.pp-canvas').waitFor();
  // The browser fetches only a few files at a time, so a 1 s delay per
  // file makes the install take ~6 s.
  await expect(page.locator('#pp-update-toast')).toBeVisible({ timeout: 20000 });
});

test('the toast Refresh button applies the update', async ({ page }) => {
  await openInstalledApp(page);
  await setServerState(page, { version: NEW_VERSION });
  await setVisibility(page, 'visible');
  const refresh = page.locator('#pp-update-toast').getByRole('button', { name: 'Refresh' });
  await refresh.waitFor({ timeout: 10000 });

  await Promise.all([page.waitForEvent('load'), refresh.click()]);
  await page.locator('.pp-canvas').waitFor();
  await gear(page).click();
  await expect(versionText(page)).toHaveText(/^fedcba9 · /);
});

test('a stroke made just before an update is not lost', async ({ page }) => {
  await openInstalledApp(page);
  await setServerState(page, { version: NEW_VERSION });
  await drawStroke(page);
  const painted = await paintedPixels(page);
  expect(painted).toBeGreaterThan(200);

  // Immediately — well inside the 500 ms autosave debounce.
  await gear(page).click();
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Check for updates' }).click(),
  ]);
  await page.locator('.pp-canvas').waitFor();

  await expect.poll(() => paintedPixels(page)).toBe(painted);
});

test('Fresh reload re-downloads the app but keeps the drawing and other apps\' caches', async ({ page }) => {
  await openInstalledApp(page);
  await drawStroke(page);
  const painted = await paintedPixels(page);

  // A cache belonging to some other app on the same origin (GitHub
  // Pages serves all of an account's projects from one origin).
  await page.evaluate(() => caches.open('some-other-app').then((c) => c.put('/x', new Response('x'))));

  await gear(page).click();
  await Promise.all([
    page.waitForEvent('load'),
    page.getByRole('button', { name: 'Fresh reload' }).click(),
  ]);
  await page.locator('.pp-canvas').waitFor();

  // Drawing kept (and the stroke was flushed first).
  await expect.poll(() => paintedPixels(page)).toBe(painted);

  const keys = await page.evaluate(() => caches.keys());
  expect(keys).toContain('some-other-app');

  // The app re-registers its service worker after the fresh load.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
});

test('Clear drawing in the panel clears and closes the panel', async ({ page }) => {
  await openInstalledApp(page);
  await drawStroke(page);
  expect(await paintedPixels(page)).toBeGreaterThan(200);

  await gear(page).click();
  await page.getByRole('button', { name: 'Clear drawing' }).click();

  expect(await paintedPixels(page)).toBe(0);
  await expect(panel(page)).toBeHidden();
});
