// End-to-end tests for the shape tools (8d): the rail's Shape button
// and panel, each shape's outline drawn live and placed on lift, Perfect,
// a tap placing nothing, one undo step per shape, and the two-step
// triangle — its waiting base, what keeps it (two fingers) and what
// drops it (Undo, a rail tap), and that it never reaches storage.
// Mouse input for shapes (draws immediately); two fingers go through
// CDP touch events, as in undo.spec.js.
//
// Not covered here (device-only): stylus feel, and whether a big Chalk
// or Soft oval keeps up while dragging on her iPad.

import { test, expect } from '@playwright/test';
import {
  openApp, reloadApp, closeLayersPanel, savedDrawingBytes, waitForDrawingSave, waitForToolSettings,
} from './helpers.js';

const undoBtn = (page) => page.getByRole('button', { name: 'Undo' });
const redoBtn = (page) => page.getByRole('button', { name: 'Redo' });
const shapeBtn = (page) => page.locator('.pp-shape-btn');
const shapePanel = (page) => page.locator('.pp-shape-panel');
const perfectSwitch = (page) => shapePanel(page).getByRole('switch', { name: 'Perfect' });

// Maps canvas pixels (1920×1080) to screen points.
async function mapper(page) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return (x, y) => ({ x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height });
}

// Picks the Shape tool with `shape` ('Line', 'Rectangle', 'Oval',
// 'Triangle') and Perfect on or off, then closes the layers panel so
// canvas touches draw.
async function useShape(page, shape, { perfect = false } = {}) {
  await closeLayersPanel(page);
  if (!(await shapeBtn(page).evaluate((b) => b.classList.contains('is-active')))) {
    await shapeBtn(page).click();
  }
  await shapeBtn(page).click();
  await expect(shapePanel(page)).toBeVisible();
  const on = (await perfectSwitch(page).getAttribute('aria-checked')) === 'true';
  if (on !== perfect) await perfectSwitch(page).click();
  await expect(perfectSwitch(page)).toHaveAttribute('aria-checked', String(perfect));
  await shapePanel(page).getByRole('menuitemradio', { name: shape, exact: true }).click();
  await expect(shapePanel(page)).toHaveCount(0);
  await expect(shapeBtn(page)).toContainText(shape);
}

// A mouse drag in canvas pixels, through `via` points if given.
async function drag(page, from, to, { via = [] } = {}) {
  const at = await mapper(page);
  const a = at(...from);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  let prev = from;
  for (const next of [...via, to]) {
    for (let i = 1; i <= 10; i++) {
      const p = at(prev[0] + ((next[0] - prev[0]) * i) / 10, prev[1] + ((next[1] - prev[1]) * i) / 10);
      await page.mouse.move(p.x, p.y);
    }
    prev = next;
  }
  await page.mouse.up();
}

async function tap(page, point) {
  const at = await mapper(page);
  const p = at(...point);
  await page.mouse.click(p.x, p.y);
}

// The active layer's paint: how many pixels, their box, and how many
// fall inside `inside` ({ x, y, w, h }) if given.
function ink(page, inside = null) {
  return page.evaluate((r) => {
    const c = document.querySelector('.pp-layer--active');
    const { width: w, height: h } = c;
    const d = c.getContext('2d').getImageData(0, 0, w, h).data;
    let count = 0;
    let within = 0;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] === 0) continue;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) within++;
      }
    }
    return { count, within, box: count ? { minX, minY, maxX, maxY } : null };
  }, inside);
}

// Box edges within `tol` px of the expected ones.
function expectBox(box, [minX, minY, maxX, maxY], tol = 6) {
  expect(box).not.toBeNull();
  expect(Math.abs(box.minX - minX)).toBeLessThanOrEqual(tol);
  expect(Math.abs(box.minY - minY)).toBeLessThanOrEqual(tol);
  expect(Math.abs(box.maxX - maxX)).toBeLessThanOrEqual(tol);
  expect(Math.abs(box.maxY - maxY)).toBeLessThanOrEqual(tol);
}

const nextFrame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));

test('the Shape button picks the tool first, then opens its panel; the shape and Perfect are remembered', async ({ page }) => {
  await openApp(page);
  await expect(shapeBtn(page)).toContainText('Line');
  await shapeBtn(page).click();
  await expect(shapeBtn(page)).toHaveClass(/is-active/);
  await expect(shapePanel(page)).toHaveCount(0); // first tap only picks it
  await shapeBtn(page).click();
  await expect(shapePanel(page)).toBeVisible();
  await expect(shapePanel(page).getByRole('menuitemradio')).toHaveText(['Line', 'Rectangle', 'Oval', 'Triangle']);
  await perfectSwitch(page).click(); // the switch keeps the panel open
  await expect(perfectSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await shapePanel(page).getByRole('menuitemradio', { name: 'Oval' }).click();
  await expect(shapePanel(page)).toHaveCount(0);
  await expect(shapeBtn(page)).toContainText('Oval');
  await waitForToolSettings(page, { tool: 'shape', shape: 'oval', shapePerfect: true });

  await reloadApp(page);
  await expect(shapeBtn(page)).toHaveClass(/is-active/);
  await expect(shapeBtn(page)).toContainText('Oval');
  await shapeBtn(page).click();
  await expect(perfectSwitch(page)).toHaveAttribute('aria-checked', 'true');
});

test('a rectangle is an outline corner to corner, one undo step', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Rectangle');
  await drag(page, [400, 300], [900, 700]);
  await expect(undoBtn(page)).toBeEnabled();
  const placed = await ink(page, { x: 450, y: 350, w: 400, h: 300 });
  expectBox(placed.box, [400, 300, 900, 700]);
  expect(placed.within).toBe(0); // outline only
  await undoBtn(page).click();
  expect((await ink(page)).count).toBe(0);
  await redoBtn(page).click();
  expect((await ink(page)).count).toBe(placed.count);
});

test('a shape follows the drag and a shrinking one leaves nothing behind', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Rectangle');
  const at = await mapper(page);
  const a = at(400, 300);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    const p = at(400 + i * 110, 300 + i * 60);
    await page.mouse.move(p.x, p.y);
  }
  await nextFrame(page);
  await nextFrame(page);
  expectBox((await ink(page)).box, [400, 300, 1500, 900]); // live, mid-drag
  const back = at(600, 500);
  await page.mouse.move(back.x, back.y);
  await page.mouse.up();
  expectBox((await ink(page)).box, [400, 300, 600, 500]);
  // The undo box is the final shape's, and taking it away leaves blank.
  await undoBtn(page).click();
  expect((await ink(page)).count).toBe(0);
});

test('an oval grows from its center', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Oval');
  await drag(page, [960, 540], [1160, 640]);
  const placed = await ink(page, { x: 900, y: 500, w: 120, h: 80 });
  expectBox(placed.box, [760, 440, 1160, 640]);
  expect(placed.within).toBe(0);
});

test('Perfect: a square, a circle, and a line snapped level', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Rectangle', { perfect: true });
  await drag(page, [400, 300], [700, 500]);
  expectBox((await ink(page)).box, [400, 300, 700, 600]);
  await undoBtn(page).click();

  await useShape(page, 'Oval', { perfect: true });
  await drag(page, [960, 540], [1060, 600]);
  expectBox((await ink(page)).box, [860, 440, 1060, 640]);
  await undoBtn(page).click();

  await useShape(page, 'Line', { perfect: true });
  await drag(page, [300, 500], [900, 540]);
  const line = (await ink(page)).box;
  expectBox(line, [300, 500, 900, 500]);
});

test('a tap with no drag places nothing', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Rectangle');
  await tap(page, [800, 500]);
  expect((await ink(page)).count).toBe(0);
  await expect(undoBtn(page)).toBeDisabled();
  await useShape(page, 'Triangle');
  await tap(page, [800, 500]);
  expect((await ink(page)).count).toBe(0);
  await expect(undoBtn(page)).toBeDisabled(); // no base waiting either
});

test('symmetry mirrors a shape', async ({ page }) => {
  await openApp(page);
  await page.locator('.pp-symmetry-btn').click();
  await page.locator('.pp-symmetry-menu').getByRole('menuitemradio', { name: 'Vertical' }).click();
  await useShape(page, 'Rectangle');
  await drag(page, [200, 300], [500, 600]);
  const left = await ink(page, { x: 0, y: 0, w: 960, h: 1080 });
  expect(left.within).toBeGreaterThan(0);
  // The mirror copy is the same size (its edges can differ by a few
  // anti-aliased pixels — mirrored positions land on different
  // sub-pixels).
  const right = left.count - left.within;
  expect(Math.abs(right - left.within)).toBeLessThan(left.within * 0.1);
  expectBox((await ink(page)).box, [200, 300, 1720, 600]);
  await undoBtn(page).click();
  expect((await ink(page)).count).toBe(0);
});

test('a triangle is a base, then a third corner — placed as one undo step', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Triangle');
  await drag(page, [500, 700], [900, 700]);
  const base = await ink(page);
  expectBox(base.box, [500, 700, 900, 700]);
  // The base waits: Undo is usable though nothing's in the history.
  await expect(undoBtn(page)).toBeEnabled();

  await drag(page, [700, 650], [650, 300]);
  const placed = await ink(page, { x: 640, y: 560, w: 60, h: 60 });
  expectBox(placed.box, [500, 300, 900, 700]);
  expect(placed.within).toBe(0);
  await undoBtn(page).click();
  expect((await ink(page)).count).toBe(0);
  await expect(undoBtn(page)).toBeDisabled();
  await redoBtn(page).click();
  expect((await ink(page)).count).toBe(placed.count);
});

test('a tap on the corner step places the corner there', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Triangle');
  await drag(page, [500, 700], [900, 700]);
  await tap(page, [600, 400]);
  expectBox((await ink(page)).box, [500, 400, 900, 700]);
});

test('a perfect triangle is even-sided, pointing to the side she taps', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Triangle', { perfect: true });
  await drag(page, [500, 500], [900, 510]); // snaps level
  const h = 200 * Math.sqrt(3);
  await tap(page, [1200, 600]); // below the base, anywhere
  expectBox((await ink(page)).box, [500, 500, 900, 500 + h]);
  await undoBtn(page).click();

  await drag(page, [500, 700], [900, 700]);
  await tap(page, [300, 650]); // above
  expectBox((await ink(page)).box, [500, 700 - h, 900, 700]);
});

test('Undo while the base waits takes away only the base', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Triangle');
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await drag(page, [300, 200], [1500, 220]); // an earlier freehand line
  const before = await ink(page);
  await shapeBtn(page).click();
  await drag(page, [500, 700], [900, 700]);
  expect((await ink(page)).count).toBeGreaterThan(before.count);
  await undoBtn(page).click();
  expect((await ink(page)).count).toBe(before.count);
  await expect(undoBtn(page)).toBeEnabled(); // the line is still undoable
  await undoBtn(page).click();
  expect((await ink(page)).count).toBe(0);
});

test('a tap outside the canvas drops the waiting base, unsaved and not undoable', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Triangle');
  await drag(page, [500, 700], [900, 700]);
  expect((await ink(page)).count).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  expect((await ink(page)).count).toBe(0);
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();
});

test('two fingers on the canvas keep the waiting base', async ({ page }) => {
  await openApp(page);
  await useShape(page, 'Triangle');
  await drag(page, [500, 700], [900, 700]);
  const base = await ink(page);

  const cdp = await page.context().newCDPSession(page);
  const at = await mapper(page);
  const down = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: [...down.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y })),
  });
  // The first finger starts the corner step; the second makes it a
  // pinch, which puts the base back as it was.
  down.set(1, at(700, 300));
  await send('touchStart');
  down.set(2, at(1100, 300));
  await send('touchStart');
  down.set(2, at(1200, 300));
  await send('touchMove');
  down.delete(1);
  await send('touchEnd');
  down.delete(2);
  await send('touchEnd');

  const after = await ink(page);
  expect(after.count).toBe(base.count);
  expect(after.box).toEqual(base.box);
  // Still waiting: the next press places the corner.
  // (The pinch moved the view; tap measures the canvas again.)
  await tap(page, [700, 400]);
  expectBox((await ink(page)).box, [500, 400, 900, 700]);
});

test("a waiting base never reaches storage, even when a save runs while it waits", async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await useShape(page, 'Triangle');
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  // Time stands still from here, so the line's save (300 ms after it)
  // can't run until the base is down.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const saved = await savedDrawingBytes(page);
  await drag(page, [300, 200], [1500, 220]);
  const line = await ink(page);
  await shapeBtn(page).click();
  await drag(page, [500, 700], [900, 700]);
  expect((await ink(page)).count).toBeGreaterThan(line.count);
  await page.clock.runFor(2000);
  await waitForDrawingSave(page, saved);
  await page.clock.resume();

  await reloadApp(page);
  expect((await ink(page)).count).toBe(line.count);
});
