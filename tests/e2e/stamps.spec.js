// End-to-end tests for stamp tips (8e): Web, Star and Heart in the
// brush panel; a tap places one, a drag leaves a spaced trail, one
// undo step per stroke; Erase stamps too; symmetry mirrors them; the
// tip is remembered. The spacing math is in tests/unit/brush.test.js.
//
// Not covered here (device-only): how the shapes look to her, and
// whether the tip list still fits the panel comfortably on her iPad.

import { test, expect } from '@playwright/test';
import {
  openApp, reloadApp, waitForToolSettings, setBrushSize, expectBrushSize,
  brushPanel, openBrushPanel, closeBrushPanel, pickTip,
} from './helpers.js';

const toolButton = (page, name) => page.getByRole('button', { name, exact: true });
const undoBtn = (page) => page.getByRole('button', { name: 'Undo', exact: true });

async function canvasToPage(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

async function tapAt(page, x, y) {
  const p = await canvasToPage(page, x, y);
  await page.mouse.click(p.x, p.y);
}

async function drag(page, x1, y1, x2, y2, steps = 40) {
  const a = await canvasToPage(page, x1, y1);
  const b = await canvasToPage(page, x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }
  await page.mouse.up();
}

// The painted box and pixel count of the active layer (optionally only
// inside a box).
const ink = (page, area = null) => page.evaluate((box) => {
  const c = document.querySelector('.pp-layer--active');
  const { x: bx, y: by, w, h } = box ?? { x: 0, y: 0, w: c.width, h: c.height };
  const d = c.getContext('2d').getImageData(bx, by, w, h).data;
  let count = 0;
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] === 0) continue;
      count += 1;
      minX = Math.min(minX, bx + x);
      maxX = Math.max(maxX, bx + x);
      minY = Math.min(minY, by + y);
      maxY = Math.max(maxY, by + y);
    }
  }
  return { count, minX, maxX, minY, maxY };
}, area);

// Separate runs of paint along one row (each stamp is one run there).
const runsOnRow = (page, y) => page.evaluate((py) => {
  const c = document.querySelector('.pp-layer--active');
  const d = c.getContext('2d').getImageData(0, py, c.width, 1).data;
  let runs = 0;
  let inside = false;
  for (let i = 3; i < d.length; i += 4) {
    const on = d[i] > 0;
    if (on && !inside) runs += 1;
    inside = on;
  }
  return runs;
}, y);

test('the brush panel lists Web, Star and Heart after the other tips', async ({ page }) => {
  await openApp(page);
  await openBrushPanel(page, 'Draw');
  const labels = await brushPanel(page).locator('.pp-brush-panel__tip').allTextContents();
  expect(labels).toEqual(['Pen', 'Pencil', 'Chalk', 'Chisel', 'Paintbrush', 'Soft', 'Web', 'Star', 'Heart']);
  // The whole panel stays on screen.
  const panel = await brushPanel(page).boundingBox();
  const viewport = page.viewportSize();
  expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height);
  await closeBrushPanel(page, 'Draw');
});

test('a tap places one upright star, inside its size', async ({ page }) => {
  await openApp(page);
  await pickTip(page, 'Draw', 'Star');
  await expect(toolButton(page, 'Draw')).toContainText('Star');
  await setBrushSize(page, 80);
  await tapAt(page, 600, 500);
  await expect(undoBtn(page)).toBeEnabled();
  const box = await ink(page);
  expect(box.count).toBeGreaterThan(500);
  expect(box.maxX - box.minX).toBeLessThanOrEqual(82);
  expect(box.maxY - box.minY).toBeLessThanOrEqual(82);
  // Upright: the top point is narrow, the bottom has two feet.
  expect(await runsOnRow(page, box.minY + 6)).toBe(1);
  expect(await runsOnRow(page, box.maxY - 3)).toBe(2);
});

test('a drag leaves spaced hearts, one Undo takes them all', async ({ page }) => {
  await openApp(page);
  await pickTip(page, 'Draw', 'Heart');
  await setBrushSize(page, 40);
  await drag(page, 200, 500, 800, 500);
  await expect(undoBtn(page)).toBeEnabled();
  // 600 px at a heart every 50 px (1.25 × 40): the first plus 12.
  const runs = await runsOnRow(page, 500);
  expect(runs).toBeGreaterThanOrEqual(11);
  expect(runs).toBeLessThanOrEqual(14);

  await undoBtn(page).click();
  await expect.poll(async () => (await ink(page)).count).toBe(0);
});

test('stamps are spaced the same however fast she drags', async ({ page }) => {
  await openApp(page);
  await pickTip(page, 'Draw', 'Star');
  await setBrushSize(page, 40);
  await drag(page, 200, 300, 800, 300, 150); // many small moves
  await drag(page, 200, 700, 800, 700, 6);   // a few long ones
  expect(Math.abs((await runsOnRow(page, 300)) - (await runsOnRow(page, 700)))).toBeLessThanOrEqual(1);
});

test('Erase stamps too: a star-shaped hole', async ({ page }) => {
  await openApp(page);
  await setBrushSize(page, 120);
  await drag(page, 300, 500, 900, 500);
  await expect(undoBtn(page)).toBeEnabled();
  const area = { x: 540, y: 440, w: 120, h: 120 };
  const full = await ink(page, area);

  await toolButton(page, 'Erase').click();
  await pickTip(page, 'Erase', 'Star');
  await setBrushSize(page, 100);
  await tapAt(page, 600, 500);
  await expect.poll(async () => (await ink(page, area)).count).toBeLessThan(full.count);
  const after = await ink(page, area);
  // Not a round hole: the corners of the star's box keep their paint.
  expect(after.count).toBeGreaterThan(full.count * 0.35);
  const corner = await ink(page, { x: 552, y: 452, w: 6, h: 6 });
  expect(corner.count).toBe(36);
});

test('symmetry mirrors a stamp', async ({ page }) => {
  await openApp(page);
  await page.locator('.pp-symmetry-btn').click();
  await page.locator('.pp-symmetry-menu').getByRole('menuitemradio', { name: 'Vertical', exact: true }).click();
  await pickTip(page, 'Draw', 'Heart');
  await setBrushSize(page, 60);
  await tapAt(page, 400, 500);
  await expect(undoBtn(page)).toBeEnabled();
  const left = await ink(page, { x: 0, y: 0, w: 960, h: 1080 });
  const right = await ink(page, { x: 960, y: 0, w: 960, h: 1080 });
  // The same heart on the other side (antialiased edges can differ by
  // a pixel where the copy lands between pixels).
  expect(Math.abs(right.count - left.count)).toBeLessThan(left.count * 0.05);
  expect(Math.abs(right.minX - (1919 - left.maxX))).toBeLessThanOrEqual(2);
  expect(Math.abs(right.minY - left.minY)).toBeLessThanOrEqual(1);
});

test('the stamp tip and its size are remembered', async ({ page }) => {
  await openApp(page);
  await pickTip(page, 'Draw', 'Web');
  await setBrushSize(page, 90);
  await waitForToolSettings(page, { tips: { draw: 'web' }, tipSettings: { draw: { web: { size: 90 } } } });
  await reloadApp(page);
  await expect(toolButton(page, 'Draw')).toContainText('Web');
  await expectBrushSize(page, 90);
});
