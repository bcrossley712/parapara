// End-to-end tests for the bare-bones frame strip (step 2c): adding a
// frame after the current one, switching frames, layers shared across
// frames, undo jumping to the frame it belongs to, undoable add frame,
// and reopening on the frame she was on.
//
// Run: npm run test:e2e
//
// Not covered here (device-only): how long a frame switch takes on the
// iPad (each switch saves the current frame and decodes the next one's
// layers), and how the strip scrolls under her finger.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, layersSettled, layerMenu } from './helpers.js';

const tiles = (page) => page.locator('.pp-frame-strip__tile');
const tile = (page, n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const undo = (page) => page.getByRole('button', { name: 'Undo' }).click();
const redo = (page) => page.getByRole('button', { name: 'Redo' }).click();

// Which frame number is current, once nothing is mid-change.
async function currentFrame(page) {
  await expect(addFrameBtn(page)).toBeEnabled();
  return Number(await page.locator('.pp-frame-strip__tile.is-current').textContent());
}

async function addFrame(page) {
  const before = await tiles(page).count();
  await addFrameBtn(page).click();
  await expect(tiles(page)).toHaveCount(before + 1);
  await expect(addFrameBtn(page)).toBeEnabled();
}

async function goToFrame(page, n) {
  await tile(page, n).click();
  await expect(tile(page, n)).toHaveClass(/is-current/);
  await expect(addFrameBtn(page)).toBeEnabled();
}

// A horizontal mouse stroke at canvas-pixel height y.
async function stroke(page, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  const sx = (x) => box.x + (x / 1920) * box.width;
  const sy = (v) => box.y + (v / 1080) * box.height;
  await page.mouse.move(sx(400), sy(y));
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(sx(400 + i * 50), sy(y));
  await page.mouse.up();
}

// Is the active layer painted at canvas-pixel (x, y)?
function paintedAt(page, x, y) {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector('.pp-layer--active').getContext('2d');
    return c.getImageData(px, py, 1, 1).data[3] > 0;
  }, [x, y]);
}

function savedRecords(page, store) {
  return page.evaluate((name) => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const r = req.result.transaction(name).objectStore(name).getAll();
      r.onsuccess = () => { req.result.close(); resolve(r.result); };
      r.onerror = () => { req.result.close(); reject(r.error); };
    };
  }), store);
}

test('add frame inserts a blank frame after the current one and moves onto it; each frame keeps its own drawing', async ({ page }) => {
  await openApp(page);
  await expect(tiles(page)).toHaveCount(1);
  await stroke(page, 300);

  await addFrame(page);
  expect(await currentFrame(page)).toBe(2);
  expect(await paintedAt(page, 900, 300)).toBe(false); // blank
  await stroke(page, 700);

  await goToFrame(page, 1);
  expect(await paintedAt(page, 900, 300)).toBe(true);
  expect(await paintedAt(page, 900, 700)).toBe(false);

  // From frame 1, a new frame lands between 1 and the old 2.
  await addFrame(page);
  expect(await currentFrame(page)).toBe(2);
  expect(await paintedAt(page, 900, 300)).toBe(false);
  expect(await paintedAt(page, 900, 700)).toBe(false);
  await goToFrame(page, 3);
  expect(await paintedAt(page, 900, 700)).toBe(true);
});

test('it reopens on the frame she was on, with every frame\'s drawing', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300);
  await addFrame(page);
  await stroke(page, 700);
  await addFrame(page);
  await goToFrame(page, 2);

  await expect.poll(async () => {
    const [project] = await savedRecords(page, 'projects');
    return project?.frames.indexOf(project.currentFrameId);
  }).toBe(1);
  await reloadApp(page);
  expect(await currentFrame(page)).toBe(2);
  expect(await paintedAt(page, 900, 700)).toBe(true);
  await goToFrame(page, 1);
  expect(await paintedAt(page, 900, 300)).toBe(true);
  await goToFrame(page, 3);
  expect(await paintedAt(page, 900, 300)).toBe(false);
});

test('undo of a stroke on another frame jumps to that frame and undoes it there', async ({ page }) => {
  await openApp(page);
  await addFrame(page);
  await goToFrame(page, 1);
  await stroke(page, 300);
  await goToFrame(page, 2);

  await undo(page);
  await expect.poll(() => currentFrame(page)).toBe(1);
  expect(await paintedAt(page, 900, 300)).toBe(false);

  await goToFrame(page, 2);
  await redo(page);
  await expect.poll(() => currentFrame(page)).toBe(1);
  expect(await paintedAt(page, 900, 300)).toBe(true);
});

test('undo removes an added frame and redo brings it back; the removed frame is not saved', async ({ page }) => {
  await openApp(page);
  await addFrame(page);
  expect(await currentFrame(page)).toBe(2);

  await undo(page);
  await expect(tiles(page)).toHaveCount(1);
  expect(await currentFrame(page)).toBe(1);
  await expect.poll(async () => (await savedRecords(page, 'frames')).length).toBe(1);

  await redo(page);
  await expect(tiles(page)).toHaveCount(2);
  expect(await currentFrame(page)).toBe(2);

  await undo(page);
  await expect(tiles(page)).toHaveCount(1);
  await reloadApp(page);
  await expect(tiles(page)).toHaveCount(1);
});

test('layers are shared: a layer added or hidden on one frame is on every frame', async ({ page }) => {
  await openApp(page);
  await addFrame(page);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Add layer' }).click();
  await expect(page.locator('.pp-layers__row')).toHaveCount(2);
  await layersSettled(page);
  const ids2 = await page.locator('.pp-layer').evaluateAll((els) => els.map((e) => e.dataset.layerId));

  await goToFrame(page, 1);
  const ids1 = await page.locator('.pp-layer').evaluateAll((els) => els.map((e) => e.dataset.layerId));
  expect(ids1).toEqual(ids2);
  await expect(page.locator('.pp-layers__row')).toHaveCount(2);

  await page.getByRole('button', { name: 'Hide Layer 1' }).click();
  await goToFrame(page, 2);
  await expect(page.locator(`.pp-layer[data-layer-id="${ids2[0]}"]`)).toHaveCSS('visibility', 'hidden');
  await expect(page.getByRole('button', { name: 'Show Layer 1' })).toBeVisible();

  // Every frame record has a slot for both layers.
  await expect.poll(async () => (await savedRecords(page, 'frames'))
    .every((f) => ids2.every((id) => f.bitmapRefs[id]))).toBe(true);
});

test('deleting a layer on one frame and undoing on another brings back both frames\' pixels', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Add layer' }).click();
  await layersSettled(page);
  await stroke(page, 300); // Layer 2, frame 1
  await addFrame(page);
  await stroke(page, 700); // Layer 2, frame 2

  await layerMenu(page, 'Delete');
  await expect(page.locator('.pp-layers__row')).toHaveCount(1);
  await goToFrame(page, 1);
  await undo(page); // brings Layer 2 back (on frame 1, where we are now)
  await expect(page.locator('.pp-layers__row')).toHaveCount(2);
  await layersSettled(page);
  expect(await paintedAt(page, 900, 300)).toBe(true);
  await goToFrame(page, 2);
  expect(await paintedAt(page, 900, 700)).toBe(true);
});
