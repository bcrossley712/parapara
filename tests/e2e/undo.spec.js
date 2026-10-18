// End-to-end tests for step 2b (undo/redo): buttons, Clear, saving
// after undo, and the touch gestures. Mouse input for strokes (draws
// immediately); multi-touch goes through Chromium's CDP touch events,
// which arrive as pointerType 'touch' like the iPad's.
//
// Not covered here (device-only): whether iPadOS's own three-finger
// undo stays out of the way, and how the thresholds feel on her stylus.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, savedDrawingBytes, waitForDrawingSave } from './helpers.js';

const undoBtn = (page) => page.getByRole('button', { name: 'Undo' });
const redoBtn = (page) => page.getByRole('button', { name: 'Redo' });

// Painted (alpha > 0) pixels across the whole canvas.
function paintedPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.pp-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
}

// Maps canvas pixels (1920x1080) to screen points.
async function mapper(page) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return (x, y) => ({ x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height });
}

async function drawStroke(page, y = 550) {
  const at = await mapper(page);
  const start = at(600, y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i < 20; i++) {
    const p = at(600 + i * 30, y);
    await page.mouse.move(p.x, p.y);
  }
  await page.mouse.up();
}

async function pickTool(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
}

// --- multi-touch via CDP -------------------------------------------

// `timestamp` (seconds since epoch) lets a test say when a touch
// landed, independent of when CDP gets to send it — like a real touch
// queued while the main thread is busy (e.g. mid-fill).
async function touchSession(page) {
  const cdp = await page.context().newCDPSession(page);
  const down = new Map(); // id -> {x, y}
  const send = (type, timestamp) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: [...down.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y })),
    ...(timestamp === undefined ? {} : { timestamp }),
  });
  return {
    async start(id, p, timestamp) { down.set(id, p); await send('touchStart', timestamp); },
    async move(id, p) { down.set(id, p); await send('touchMove'); },
    async end(id) {
      down.delete(id);
      // touchEnd lists the points still down.
      await send('touchEnd');
    },
  };
}

// Three fingers down near (cx, cy), optionally moved by dx, then lifted.
async function threeFinger(page, dx = 0) {
  const t = await touchSession(page);
  const at = await mapper(page);
  const base = [at(800, 500), at(900, 520), at(1000, 500)];
  for (let i = 0; i < 3; i++) await t.start(i + 1, base[i]);
  if (dx) {
    for (let step = 1; step <= 6; step++) {
      for (let i = 0; i < 3; i++) {
        await t.move(i + 1, { x: base[i].x + (dx * step) / 6, y: base[i].y });
      }
    }
  }
  for (let i = 0; i < 3; i++) await t.end(i + 1);
}

async function twoFingerTap(page) {
  const t = await touchSession(page);
  const at = await mapper(page);
  await t.start(1, at(800, 500));
  await t.start(2, at(1000, 500));
  await t.end(1);
  await t.end(2);
}

const canvasTransform = (page) => page.locator('.pp-canvas').evaluate((c) => c.style.transform);

// --------------------------------------------------------------------

test('undo and redo buttons restore a stroke, and are disabled when there is nothing to do', async ({ page }) => {
  await openApp(page);
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();

  await drawStroke(page);
  const painted = await paintedPixels(page);
  expect(painted).toBeGreaterThan(500);
  await expect(undoBtn(page)).toBeEnabled();

  await undoBtn(page).click();
  expect(await paintedPixels(page)).toBe(0);
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeEnabled();

  await redoBtn(page).click();
  expect(await paintedPixels(page)).toBe(painted);
  await expect(redoBtn(page)).toBeDisabled();
});

test('undo restores the exact earlier pixels, not just blank', async ({ page }) => {
  await openApp(page);
  await drawStroke(page, 500);
  const afterFirst = await paintedPixels(page);
  await drawStroke(page, 520); // overlaps the first
  expect(await paintedPixels(page)).toBeGreaterThan(afterFirst);
  await undoBtn(page).click();
  expect(await paintedPixels(page)).toBe(afterFirst);
});

test('a new stroke after undo clears redo', async ({ page }) => {
  await openApp(page);
  await drawStroke(page, 500);
  await undoBtn(page).click();
  await expect(redoBtn(page)).toBeEnabled();
  await drawStroke(page, 700);
  await expect(redoBtn(page)).toBeDisabled();
});

test('fill is undoable', async ({ page }) => {
  await openApp(page);
  await pickTool(page, 'Fill');
  const at = await mapper(page);
  const p = at(100, 100);
  await page.mouse.click(p.x, p.y);
  expect(await paintedPixels(page)).toBe(1920 * 1080);
  await undoBtn(page).click();
  expect(await paintedPixels(page)).toBe(0);
});

test('Clear is undoable, and clearing a blank canvas adds no undo step', async ({ page }) => {
  await openApp(page);
  const clear = async () => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Clear drawing' }).click();
  };

  await clear();
  await expect(undoBtn(page)).toBeDisabled();

  await drawStroke(page);
  const painted = await paintedPixels(page);
  await clear();
  expect(await paintedPixels(page)).toBe(0);
  await undoBtn(page).click();
  expect(await paintedPixels(page)).toBe(painted);
});

test('undo is saved, and history does not survive a reload', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  await waitForDrawingSave(page, null);
  const withStroke = await savedDrawingBytes(page);

  await undoBtn(page).click();
  await waitForDrawingSave(page, withStroke);

  await reloadApp(page);
  expect(await paintedPixels(page)).toBe(0);
  await expect(undoBtn(page)).toBeDisabled();
  await expect(redoBtn(page)).toBeDisabled();
});

test('three-finger tap undoes; three-finger swipe right redoes, left undoes', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  const painted = await paintedPixels(page);

  await threeFinger(page);
  await expect.poll(() => paintedPixels(page)).toBe(0);

  await threeFinger(page, 200);
  await expect.poll(() => paintedPixels(page)).toBe(painted);

  await threeFinger(page, -200);
  await expect.poll(() => paintedPixels(page)).toBe(0);
});

test('three-finger gestures leave no marks and do not move the view', async ({ page }) => {
  await openApp(page);
  const before = await canvasTransform(page);
  await threeFinger(page);
  expect(await paintedPixels(page)).toBe(0);
  expect(await canvasTransform(page)).toBe(before);
  await expect(undoBtn(page)).toBeDisabled();
});

test('a touch fill that turns into a two-finger gesture is reverted and not added to history', async ({ page }) => {
  await openApp(page);
  await pickTool(page, 'Fill');
  const t = await touchSession(page);
  const at = await mapper(page);
  // The second finger lands 50 ms after the first, even though the
  // full-canvas fill keeps the page busy longer than that.
  const t0 = Date.now() / 1000;
  await t.start(1, at(800, 500), t0);
  await t.start(2, at(1000, 500), t0 + 0.05);
  await t.end(1);
  await t.end(2);
  expect(await paintedPixels(page)).toBe(0);
  await expect(undoBtn(page)).toBeDisabled();
});

test('a single two-finger tap does not reset the view; a double-tap does', async ({ page }) => {
  await openApp(page);
  // Pinch out to zoom in.
  const t = await touchSession(page);
  const at = await mapper(page);
  await t.start(1, at(900, 540));
  await t.start(2, at(1020, 540));
  for (let i = 1; i <= 8; i++) {
    const a = at(900 - i * 30, 540);
    const b = at(1020 + i * 30, 540);
    await t.move(1, a);
    await t.move(2, b);
  }
  await t.end(1);
  await t.end(2);
  const zoomed = await canvasTransform(page);
  expect(zoomed).not.toContain('scale(1)');

  await twoFingerTap(page);
  // Proving something *doesn't* happen — the view stays zoomed.
  expect(await canvasTransform(page)).toBe(zoomed);

  await twoFingerTap(page);
  await expect.poll(() => canvasTransform(page)).toContain('scale(1)');
});
