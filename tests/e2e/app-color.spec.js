// End-to-end tests for the App color choice (after the light theme):
// the gear menu's swatches repaint the app, and the choice comes back
// after a relaunch. Each test starts with an empty database.
//
// Not covered (device-only): the status bar's text staying dark over
// each color's bars.
//
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, readDb } from './helpers.js';

const gear = (page) => page.getByRole('button', { name: 'Settings', exact: true });
const swatch = (page, name) => page.getByRole('group', { name: 'App color' }).getByRole('button', { name, exact: true });
const accent = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pp-accent').trim());

test('starts purple; a swatch repaints the app at once and is saved', async ({ page }) => {
  await openApp(page);
  expect(await accent(page)).toBe('#7a52c7');

  await gear(page).click();
  await expect(swatch(page, 'Purple')).toHaveAttribute('aria-pressed', 'true');
  await swatch(page, 'Pink').click();

  await expect(swatch(page, 'Pink')).toHaveAttribute('aria-pressed', 'true');
  await expect(swatch(page, 'Purple')).toHaveAttribute('aria-pressed', 'false');
  expect(await accent(page)).toBe('#c23d78');
  // The active tool, the bars and the status bar's color follow.
  await expect(page.getByRole('button', { name: 'Draw', exact: true })).toHaveCSS('background-color', 'rgb(194, 61, 120)');
  await expect(page.locator('#app')).toHaveCSS('background-color', 'rgb(252, 241, 246)');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#fcf1f6');

  await expect.poll(async () => (await readDb(page, 'meta', 'uiState'))?.value?.appColor).toBe('pink');
});

test('the choice comes back after a relaunch, in both screens', async ({ page }) => {
  await openApp(page);
  await gear(page).click();
  await swatch(page, 'Teal').click();
  await expect.poll(async () => (await readDb(page, 'meta', 'uiState'))?.value?.appColor).toBe('teal');

  await reloadApp(page);
  expect(await accent(page)).toBe('#127f7a');

  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.locator('.pp-gallery').waitFor();
  expect(await accent(page)).toBe('#127f7a');
  await gear(page).click();
  await expect(swatch(page, 'Teal')).toHaveAttribute('aria-pressed', 'true');
  // Back to purple from the gallery's gear.
  await swatch(page, 'Purple').click();
  expect(await accent(page)).toBe('#7a52c7');
  await expect.poll(async () => (await readDb(page, 'meta', 'uiState'))?.value?.appColor).toBe('purple');
});

test('the database wins over a stale localStorage copy', async ({ page }) => {
  await openApp(page);
  await gear(page).click();
  await swatch(page, 'Green').click();
  await expect.poll(async () => (await readDb(page, 'meta', 'uiState'))?.value?.appColor).toBe('green');
  await page.evaluate(() => localStorage.setItem('parapara-app-color', 'orange'));

  await reloadApp(page);
  await expect.poll(() => accent(page)).toBe('#2e7d32');
  expect(await page.evaluate(() => localStorage.getItem('parapara-app-color'))).toBe('green');
});
