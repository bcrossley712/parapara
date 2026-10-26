// End-to-end tests for the frame strip's picture thumbnails (step
// 4a-ii): each tile shows its frame — paper, the frame's photo unless
// Hide images is on, then the layers — and keeps its number; tiles
// follow strokes, undo, shared-layer visibility (every frame's tile)
// and the photo. They come from the flattened-frame cache, so these
// also cover its invalidation end to end (its rules are unit-tested in
// tests/unit/frame-cache.test.js).
//
// Run: npm run test:e2e
//
// Not covered here (device-only): whether rebuilding in the background
// is ever felt while drawing, and how long a long animation's tiles
// take to fill in on the iPad.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, closeLayersPanel } from './helpers.js';

const tiles = (page) => page.locator('.pp-frame-strip__tile');
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });

async function settled(page) {
  await expect(addFrameBtn(page)).toBeEnabled();
}

async function addFrame(page) {
  await settled(page);
  const before = await tiles(page).count();
  await addFrameBtn(page).click();
  await expect(tiles(page)).toHaveCount(before + 1);
  await settled(page);
}

async function goToFrame(page, n) {
  await settled(page);
  await page.getByRole('button', { name: `Frame ${n}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Frame ${n}`, exact: true })).toHaveClass(/is-current/);
  await settled(page);
}

// A mouse stroke in canvas-pixel coordinates.
async function stroke(page, x1, y1, x2, y2) {
  const reopen = await closeLayersPanel(page);
  const box = await page.locator('.pp-canvas').boundingBox();
  const sx = (x) => box.x + (x / 1920) * box.width;
  const sy = (y) => box.y + (y / 1080) * box.height;
  await page.mouse.move(sx(x1), sy(y1));
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(sx(x1 + ((x2 - x1) * i) / 20), sy(y1 + ((y2 - y1) * i) / 20));
  }
  await page.mouse.up();
  await reopen();
}

// What tile `n` (1-based) shows: null if it has no picture yet, else
// counts of pixels that are dark (the default ink), red (the test
// photo's left half) and white (paper), and whether its left half or
// right half holds the ink.
function tilePixels(page, n) {
  return page.evaluate((index) => {
    const tile = document.querySelectorAll('.pp-frame-strip__tile')[index];
    const canvas = tile?.querySelector('canvas');
    if (!canvas || !canvas.width) return null;
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let dark = 0;
    let red = 0;
    let white = 0;
    let darkLeft = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r < 110 && g < 110 && b < 110) {
        dark++;
        if (((i / 4) % width) < width / 2) darkLeft++;
      } else if (r > 200 && g < 120 && b < 120) {
        red++;
      } else if (r > 245 && g > 245 && b > 245) {
        white++;
      }
    }
    return { dark, red, white, darkLeft, total: width * height };
  }, n - 1);
}

const darkIn = async (page, n) => (await tilePixels(page, n))?.dark ?? -1;

test('a tile shows its frame and keeps its number; a new frame starts as blank paper', async ({ page }) => {
  await openApp(page);
  await settled(page);
  // A thick stroke on the left half of frame 1.
  await page.locator('.pp-tool-rail input[type="range"]').fill('60');
  await stroke(page, 200, 300, 800, 800);
  await expect.poll(() => darkIn(page, 1)).toBeGreaterThan(20);
  const one = await tilePixels(page, 1);
  expect(one.darkLeft).toBe(one.dark); // where she drew it
  await expect(tiles(page).nth(0)).toHaveText('1');
  await expect(tiles(page).nth(0)).toHaveClass(/has-picture/);

  await addFrame(page);
  await expect.poll(() => tilePixels(page, 2)).not.toBeNull();
  const two = await tilePixels(page, 2);
  expect(two.dark).toBe(0);
  expect(two.white).toBe(two.total);
  await expect(tiles(page).nth(1)).toHaveText('2');
  // Frame 1's tile keeps its drawing after moving off it.
  expect(await darkIn(page, 1)).toBeGreaterThan(20);
});

test('undo and redo update the tile', async ({ page }) => {
  await openApp(page);
  await settled(page);
  await page.locator('.pp-tool-rail input[type="range"]').fill('60');
  await stroke(page, 300, 300, 1500, 700);
  await expect.poll(() => darkIn(page, 1)).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => darkIn(page, 1)).toBe(0);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(() => darkIn(page, 1)).toBeGreaterThan(20);
});

test("hiding a layer updates every frame's tile, and showing it brings them back", async ({ page }) => {
  await openApp(page);
  await settled(page);
  await page.locator('.pp-tool-rail input[type="range"]').fill('60');
  await stroke(page, 300, 300, 1500, 700);
  await addFrame(page);
  await stroke(page, 300, 700, 1500, 300);
  await expect.poll(() => darkIn(page, 1)).toBeGreaterThan(20);
  await expect.poll(() => darkIn(page, 2)).toBeGreaterThan(20);

  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Hide Layer 1' }).click();
  await expect.poll(() => darkIn(page, 1)).toBe(0);
  await expect.poll(() => darkIn(page, 2)).toBe(0);

  await page.getByRole('button', { name: 'Show Layer 1' }).click();
  await expect.poll(() => darkIn(page, 1)).toBeGreaterThan(20);
  await expect.poll(() => darkIn(page, 2)).toBeGreaterThan(20);
});

test("a tile shows its frame's photo unless Hide images is on", async ({ page }) => {
  await openApp(page);
  await settled(page);
  // A 200×100 PNG, left half red, right half blue.
  const base64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(100, 0, 100, 100);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.locator('.pp-image-btn').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Add image' }).click();
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') });
  await page.locator('.pp-reference-bar').getByRole('button', { name: 'Done' }).click();
  await settled(page);
  // The photo comes in at 50% over white, so its red reads as pink.
  const pinkish = async () => page.evaluate(() => {
    const canvas = document.querySelectorAll('.pp-frame-strip__tile')[0]?.querySelector('canvas');
    if (!canvas) return 0;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 230 && data[i + 1] > 90 && data[i + 1] < 170 && data[i + 2] > 90 && data[i + 2] < 170) n++;
    }
    return n;
  });
  await expect.poll(pinkish).toBeGreaterThan(100);

  await page.locator('.pp-image-btn').click();
  await page.getByRole('menuitem', { name: 'Hide images' }).click();
  await expect.poll(pinkish).toBe(0);
});

test('tiles are drawn again after reopening the project', async ({ page }) => {
  await openApp(page);
  await settled(page);
  await page.locator('.pp-tool-rail input[type="range"]').fill('60');
  await stroke(page, 300, 300, 1500, 700);
  await addFrame(page);
  await goToFrame(page, 1);
  await expect.poll(() => darkIn(page, 1)).toBeGreaterThan(20);
  // Wait for the stroke to be saved (the tile came from the live
  // canvas, which can be ahead of storage), then reload.
  await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('parapara');
    open.onsuccess = () => {
      const req = open.result.transaction('blobs').objectStore('blobs').count();
      req.onsuccess = () => resolve(req.result);
    };
  }))).toBeGreaterThan(0);
  await reloadApp(page);
  await settled(page);
  await expect.poll(() => darkIn(page, 1)).toBeGreaterThan(20);
  await expect.poll(() => tilePixels(page, 2)).not.toBeNull();
  expect(await darkIn(page, 2)).toBe(0);
});
