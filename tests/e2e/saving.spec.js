// End-to-end tests for step 2a (saving): the real app in headless
// Chromium. Each test gets a fresh browser context, so it starts with
// an empty database and no service worker.
//
// Run: npm run test:e2e
//
// Not covered here (device-only): whether iOS keeps the data across a
// full relaunch, whether storage persistence is granted, and whether
// the background save finishes before iPadOS suspends the app.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, setVisibility, savedDrawingBytes, waitForDrawingSave } from './helpers.js';

// Counts painted (non-transparent) canvas pixels in a box around where
// drawStroke() draws. The canvas is transparent where nothing is
// drawn (the white comes from CSS), so alpha > 0 means "painted."
async function paintedPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.pp-canvas');
    const d = c.getContext('2d').getImageData(500, 400, 900, 300).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
}

// A horizontal mouse stroke across the middle of the canvas, given in
// canvas-pixel coordinates (1920x1080) and mapped to screen points.
// Mouse input draws immediately (no touch gesture window), which keeps
// the test deterministic.
async function drawStroke(page) {
  const box = await page.locator('.pp-canvas').boundingBox();
  const sx = (x) => box.x + (x / 1920) * box.width;
  const sy = (y) => box.y + (y / 1080) * box.height;
  await page.mouse.move(sx(600), sy(550));
  await page.mouse.down();
  for (let i = 1; i < 30; i++) {
    await page.mouse.move(sx(600 + i * 25), sy(550 + (i % 5) * 4));
  }
  await page.mouse.up();
}

test('a drawing survives a reload', async ({ page }) => {
  await openApp(page);
  expect(await paintedPixels(page)).toBe(0);

  await drawStroke(page);
  const painted = await paintedPixels(page);
  expect(painted).toBeGreaterThan(500);

  await waitForDrawingSave(page, null);
  await reloadApp(page);

  // PNG round-trip is lossless; allow a sliver for edge resampling.
  await expect.poll(async () => Math.abs((await paintedPixels(page)) - painted))
    .toBeLessThan(painted * 0.02);
});

test('hiding the app saves immediately, without waiting for the debounce', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  const painted = await paintedPixels(page);

  await setVisibility(page, 'hidden');
  // Must land well inside the 500 ms debounce, or it was the debounce
  // that saved it, not the hide.
  await waitForDrawingSave(page, null, { timeout: 300 });
  await reloadApp(page);

  await expect.poll(() => paintedPixels(page)).toBe(painted);
});

test('Clear is saved like any other edit', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  await waitForDrawingSave(page, null);
  const withStroke = await savedDrawingBytes(page);

  // Clear lives in the gear menu (moved off the rail — no undo yet).
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Clear drawing' }).click();
  await waitForDrawingSave(page, withStroke);
  await reloadApp(page);

  await expect.poll(() => paintedPixels(page)).toBe(0);
});

test('reloading reuses one project instead of creating new ones', async ({ page }) => {
  await openApp(page);
  await reloadApp(page);
  await reloadApp(page);

  const count = await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const q = req.result.transaction('projects').objectStore('projects').count();
      q.onsuccess = () => resolve(q.result);
    };
  }));
  expect(count).toBe(1);
});

test('without storage, drawing still works and a notice explains saving is off', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: undefined });
  });
  await openApp(page);

  await expect(page.locator('#pp-notice-toast')).toBeVisible();
  await drawStroke(page);
  expect(await paintedPixels(page)).toBeGreaterThan(500);
});

test('first launch does not reload the page when the service worker takes control', async ({ page }) => {
  let loads = 0;
  page.on('load', () => { loads++; });
  await openApp(page);
  // Give the service worker time to install, activate and claim.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 5000 });
  // The one acceptable fixed wait: proving a reload *doesn't* happen
  // (there's nothing to poll for).
  await page.waitForTimeout(500);
  expect(loads).toBe(1);
});

test('no errors in the console during normal use', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await openApp(page);
  await drawStroke(page);
  await waitForDrawingSave(page, null);
  await reloadApp(page);

  expect(errors).toEqual([]);
});
