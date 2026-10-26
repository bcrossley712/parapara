// End-to-end tests for the lost-canvas guard (after 4c). On her iPad a
// layer canvas lost its pixels while she was drawing — it read back
// blank and stayed blank — though storage still held the drawing. The
// next save would have written blank over it. These simulate that
// (the real iOS failure can't happen in desktop Chromium) and check:
// the save is refused and the layer reloaded from storage, a canvas
// that stays blank is swapped for a fresh one on a frame load, coming
// back to the app checks too, and erasing on purpose still saves.
//
// Run: npm run test:e2e
//
// Device-only: whether iPadOS's real failure looks like these
// simulations (a canvas emptied, and one that ignores drawImage).

import { test, expect } from '@playwright/test';
import { openApp, savedDrawingBytes, waitForDrawingSave, setVisibility } from './helpers.js';

const toast = (page) => page.locator('.pp-toast__text');
const banner = (page) => page.locator('.pp-banner');
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const tile = (page, n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });

// A horizontal mouse stroke at canvas-pixel height y, from x0 to x1.
async function stroke(page, y, x0 = 300, x1 = 1600) {
  const box = await page.locator('.pp-canvas').boundingBox();
  const sx = (x) => box.x + (x / 1920) * box.width;
  const sy = (v) => box.y + (v / 1080) * box.height;
  await page.mouse.move(sx(x0), sy(y));
  await page.mouse.down();
  const steps = 25;
  for (let i = 1; i <= steps; i++) await page.mouse.move(sx(x0 + ((x1 - x0) * i) / steps), sy(y));
  await page.mouse.up();
}

// A drawing that covers plenty of the layer, saved.
async function drawAndSave(page) {
  for (const y of [200, 300, 400, 500, 600, 700]) {
    const before = await savedDrawingBytes(page);
    await stroke(page, y);
    await waitForDrawingSave(page, before);
  }
  return savedDrawingBytes(page);
}

function paintedAt(page, x, y) {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector('.pp-layer--active').getContext('2d');
    return c.getImageData(px, py, 1, 1).data[3] > 0;
  }, [x, y]);
}

// What iOS did: the layer's pixels vanish. With `stuck`, the canvas
// also ignores being drawn into again (it stayed blank on her iPad).
function loseActiveCanvas(page, { stuck = false } = {}) {
  return page.evaluate((keepStuck) => {
    const el = document.querySelector('.pp-layer--active');
    const c = el.getContext('2d');
    c.clearRect(0, 0, el.width, el.height);
    if (keepStuck) {
      c.drawImage = () => {};
      c.putImageData = () => {};
    }
    el.dataset.testLost = '1';
  }, stuck);
}

// The activity log as saved (pagehide writes it out now; it's batched).
async function logText(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  return page.evaluate(() => (JSON.parse(localStorage.getItem('parapara-dev-log') ?? '[]')).join('\n'));
}

test('a save from a canvas that lost its pixels is refused, and the layer is reloaded', async ({ page }) => {
  await openApp(page);
  const saved = await drawAndSave(page);

  await loseActiveCanvas(page);
  expect(await paintedAt(page, 900, 400)).toBe(false);

  // Her next stroke, somewhere else, onto the blank canvas.
  await stroke(page, 950, 300, 600);

  await expect(toast(page)).toContainText('loaded again from your last save');
  // The stored drawing was never replaced.
  expect(await savedDrawingBytes(page)).toBe(saved);
  // It's back on screen, on a fresh canvas; the stroke onto the blank
  // canvas is gone (it was never saved).
  await expect.poll(() => paintedAt(page, 900, 400)).toBe(true);
  expect(await paintedAt(page, 450, 950)).toBe(false);
  await expect(page.locator('.pp-layer[data-test-lost]')).toHaveCount(0);
  expect(await page.locator('.pp-layer').count()).toBe(1);

  // Drawing carries on and saves normally afterwards.
  await page.locator('.pp-toast button').click();
  const before = await savedDrawingBytes(page);
  await stroke(page, 950, 300, 600);
  await waitForDrawingSave(page, before);
  expect(await savedDrawingBytes(page)).toBeGreaterThan(saved);

  const log = await logText(page);
  expect(log).toContain('save-refused');
  expect(log).toContain('recover');
  // What else was going on (dev only): full-size canvases in the page
  // / all canvases, playback state, onion skin.
  expect(log).toMatch(/save-refused .*canvases=\d+\/\d+ play=idle onion=off/);
  expect(log).toMatch(/recover .*canvases=\d+\/\d+ play=idle onion=off/);
  // Memory leads (undo MB, frame cache frames/MB, canvases not freed).
  expect(log).toMatch(/recover .* onion=off undo=\d+\.\d cache=\d+\/\d+\.\d made=\d+/);
  expect(log).toMatch(/ open .* made=\d+/);
});

test('a canvas that stays blank is swapped for a fresh one when the frame loads', async ({ page }) => {
  await openApp(page);
  await drawAndSave(page);

  await loseActiveCanvas(page, { stuck: true });
  await addFrameBtn(page).click();
  await expect(tile(page, 2)).toHaveClass(/is-current/);
  await expect(addFrameBtn(page)).toBeEnabled();
  await tile(page, 1).click();
  await expect(tile(page, 1)).toHaveClass(/is-current/);
  await expect(addFrameBtn(page)).toBeEnabled();

  await expect(banner(page)).toContainText('loaded again');
  expect(await paintedAt(page, 900, 400)).toBe(true);
  await expect(page.locator('.pp-layer[data-test-lost]')).toHaveCount(0);
  expect(await page.locator('.pp-layer').count()).toBe(1);
});

test('coming back to the app checks the canvas', async ({ page }) => {
  await openApp(page);
  const saved = await drawAndSave(page);

  await loseActiveCanvas(page);
  await setVisibility(page, 'hidden');
  await setVisibility(page, 'visible');

  await expect(toast(page)).toContainText('loaded again');
  await expect.poll(() => paintedAt(page, 900, 400)).toBe(true);
  expect(await savedDrawingBytes(page)).toBe(saved);
});

test('erasing the whole drawing on purpose still saves', async ({ page }) => {
  await openApp(page);
  await drawAndSave(page);
  const drawn = await storedPaintedPixels(page);
  expect(drawn).toBeGreaterThan(1000);

  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await page.locator('input[type="range"]').first().fill('60');
  for (const y of [200, 300, 400, 500, 600, 700]) {
    const before = await savedDrawingBytes(page);
    await stroke(page, y, 200, 1700);
    await waitForDrawingSave(page, before);
  }

  // Storage holds the erased drawing: (almost) nothing left.
  expect(await storedPaintedPixels(page)).toBeLessThan(drawn / 100);
  await expect(toast(page)).toHaveCount(0);
  const log = await logText(page);
  expect(log).not.toContain('save-refused');
});

// An erase leaves the layer's context in 'destination-out'. A frame load
// right after it used to draw the saved drawing in that mode — erasing
// it onto a blank canvas. A real drawing tripped the guard (a needless
// fresh canvas and banner); a tiny one showed blank, and the next save
// wrote over it (robot test seed 115).
async function eraseOnNewFrame(page) {
  await addFrameBtn(page).click();
  await expect(tile(page, 2)).toHaveClass(/is-current/);
  await expect(addFrameBtn(page)).toBeEnabled();
  let before = await savedDrawingBytes(page);
  await stroke(page, 800, 600, 1400);
  await waitForDrawingSave(page, before);
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  before = await savedDrawingBytes(page);
  await stroke(page, 800, 700, 1000);
  await waitForDrawingSave(page, before);
  await tile(page, 1).click();
  await expect(tile(page, 1)).toHaveClass(/is-current/);
  await expect(addFrameBtn(page)).toBeEnabled();
}

test('a frame opened right after an erase shows its drawing', async ({ page }) => {
  await openApp(page);
  await drawAndSave(page);
  await eraseOnNewFrame(page);

  expect(await paintedAt(page, 900, 400)).toBe(true);
  const log = await logText(page);
  expect(log).not.toContain('load-renewed');
  await expect(banner(page)).toHaveCount(0);
});

test('a tiny drawing opened right after an erase is still there', async ({ page }) => {
  await openApp(page);
  const before = await savedDrawingBytes(page);
  await stroke(page, 400, 913, 917); // a dot: below the guard's size on purpose
  await waitForDrawingSave(page, before);
  await eraseOnNewFrame(page);

  expect(await paintedAt(page, 915, 400)).toBe(true);
});

// Painted pixels in the stored bitmaps (thumbnails aside), decoded.
function storedPaintedPixels(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const r = db.transaction('blobs').objectStore('blobs').getAll();
      r.onerror = () => reject(r.error);
      r.onsuccess = async () => {
        db.close();
        let painted = 0;
        for (const rec of r.result.filter((x) => !x.id.startsWith('thumb-'))) {
          const bitmap = await createImageBitmap(new Blob([rec.buffer], { type: rec.type }));
          const c = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = c.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
        }
        resolve(painted);
      };
    };
  }));
}
