// End-to-end tests for the temporary activity log (gear menu →
// Developer → Activity log; storage/dev-log.js). Remove with the
// Developer section.
//
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, savedDrawingBytes, waitForDrawingSave } from './helpers.js';

async function stroke(page) {
  const box = await page.locator('.pp-canvas').boundingBox();
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 100 + i * 20, box.y + 100);
  await page.mouse.up();
}

async function openLog(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Activity log' }).click();
  return page.locator('.pp-dev-log__text');
}

test('the log records strokes, saves and frame loads, and survives a reload', async ({ page }) => {
  await openApp(page);
  const before = await savedDrawingBytes(page);
  await stroke(page);
  await waitForDrawingSave(page, before);
  await page.getByRole('button', { name: 'Add frame' }).click();
  await expect(page.locator('.pp-frame-strip__tile')).toHaveCount(2);

  let text = await openLog(page);
  await expect(text).toContainText(/ open project=\w+ frames=1/);
  await expect(text).toContainText(/ stroke tool=draw frame=f1#\w+ /);
  await expect(text).toContainText(/ save frame=f1#\w+ layer=\w+ bytes=\d+/);
  await expect(text).toContainText(/ show from=f1#\w+ to=f2#\w+ bytes=0/);

  await reloadApp(page);
  text = await openLog(page);
  await expect(text).toContainText(' stroke tool=draw');
  await expect(text).toContainText(' launch');
});

test('Clear empties the log', async ({ page }) => {
  await openApp(page);
  const text = await openLog(page);
  await expect(text).toContainText(' open ');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(text).toHaveText('Nothing logged yet.');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.pp-dev-log')).toHaveCount(0);
});
