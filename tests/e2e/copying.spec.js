// End-to-end tests for step 2e's copying: copy frame (from the menu on
// the current frame tile), copy layer (layers panel), and duplicate
// project (gallery ⋯ menu). Each copy must be independent of its
// source, undoable where the original action is, and survive a reload.
//
// Run: npm run test:e2e
//
// Not covered (device-only): how long copy layer takes on the iPad with
// many frames (one stored-image copy per frame), and how the frame menu
// feels under her finger.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, readDb } from './helpers.js';

const tiles = (page) => page.locator('.pp-frame-strip__tile');
const tile = (page, n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const rows = (page) => page.locator('.pp-layers__row');
const undo = (page) => page.getByRole('button', { name: 'Undo' }).click();
const redo = (page) => page.getByRole('button', { name: 'Redo' }).click();

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => {
    throw new Error(`Native dialog shown: ${d.type()} "${d.message()}"`);
  });
});

// Nothing mid-change: the strip's add tile is enabled again.
const settled = (page) => expect(addFrameBtn(page)).toBeEnabled();

async function currentFrame(page) {
  await settled(page);
  return Number(await page.locator('.pp-frame-strip__tile.is-current').textContent());
}

async function goToFrame(page, n) {
  await settled(page);
  // Tapping the current tile would open its menu instead.
  if (await tile(page, n).getAttribute('aria-current') !== 'true') await tile(page, n).click();
  await expect(tile(page, n)).toHaveClass(/is-current/);
  await settled(page);
}

async function duplicateFrame(page) {
  const before = await tiles(page).count();
  await page.locator('.pp-frame-strip__tile.is-current').click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(tiles(page)).toHaveCount(before + 1);
  await settled(page);
}

async function openLayers(page) {
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.locator('.pp-layers')).toBeVisible();
}

async function addLayer(page) {
  const before = await rows(page).count();
  await page.getByRole('button', { name: 'Add layer' }).click();
  await expect(rows(page)).toHaveCount(before + 1);
  await expect(page.getByRole('button', { name: 'Rename' })).toBeEnabled();
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

// Is the layer (the active one by default) painted at canvas pixel (x, y)?
function paintedAt(page, x, y, layerId = null) {
  return page.evaluate(([px, py, id]) => {
    const sel = id ? `.pp-layer[data-layer-id="${id}"]` : '.pp-layer--active';
    const c = document.querySelector(sel).getContext('2d');
    return c.getImageData(px, py, 1, 1).data[3] > 0;
  }, [x, y, layerId]);
}

const layerIds = (page) => page.locator('.pp-layer').evaluateAll((els) => els.map((e) => e.dataset.layerId));
const activeLayerId = (page) => page.locator('.pp-layer--active').getAttribute('data-layer-id');

// --- copy frame ---

test('Duplicate on the current frame copies every layer after it and moves onto the copy', async ({ page }) => {
  await openApp(page);
  await openLayers(page);
  await stroke(page, 300); // Layer 1
  await addLayer(page);
  await stroke(page, 700); // Layer 2
  await page.getByRole('button', { name: 'Layers', exact: true }).click(); // close
  const [l1, l2] = await layerIds(page);

  await duplicateFrame(page);
  expect(await currentFrame(page)).toBe(2);
  expect(await paintedAt(page, 900, 300, l1)).toBe(true);
  expect(await paintedAt(page, 900, 700, l2)).toBe(true);

  // The copy is independent: drawing on it leaves frame 1 alone.
  await stroke(page, 500);
  await goToFrame(page, 1);
  expect(await paintedAt(page, 900, 500, l2)).toBe(false);

  // It lands right after the frame it came from.
  await duplicateFrame(page);
  expect(await currentFrame(page)).toBe(2);
  expect(await paintedAt(page, 900, 500, l2)).toBe(false);
  await goToFrame(page, 3);
  expect(await paintedAt(page, 900, 500, l2)).toBe(true);

  await reloadApp(page);
  await expect(tiles(page)).toHaveCount(3);
  await goToFrame(page, 2);
  expect(await paintedAt(page, 900, 300, l1)).toBe(true);
  expect(await paintedAt(page, 900, 700, l2)).toBe(true);
});

test('a stroke not yet saved is in the copy', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300);
  // Straight away, inside the autosave debounce.
  await duplicateFrame(page);
  expect(await paintedAt(page, 900, 300)).toBe(true);
  await goToFrame(page, 1);
  expect(await paintedAt(page, 900, 300)).toBe(true);
});

test('undo takes a copied frame out and redo brings it back with its drawing', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300);
  await duplicateFrame(page);

  await undo(page);
  await expect(tiles(page)).toHaveCount(1);
  expect(await currentFrame(page)).toBe(1);

  await redo(page);
  await expect(tiles(page)).toHaveCount(2);
  expect(await currentFrame(page)).toBe(2);
  expect(await paintedAt(page, 900, 300)).toBe(true);
});

test('the frame menu opens only on the current tile and closes on a tap elsewhere', async ({ page }) => {
  await openApp(page);
  await addFrameBtn(page).click();
  await expect(tiles(page)).toHaveCount(2);
  await settled(page);

  await tile(page, 1).click(); // not current: just moves there
  await expect(tile(page, 1)).toHaveClass(/is-current/);
  await expect(page.locator('.pp-frame-menu')).toHaveCount(0);

  await settled(page);
  await tile(page, 1).click(); // current: opens the menu
  await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
  await tile(page, 1).click(); // again: closes it
  await expect(page.locator('.pp-frame-menu')).toHaveCount(0);

  await tile(page, 1).click();
  await expect(page.locator('.pp-frame-menu')).toHaveCount(1);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.locator('.pp-frame-menu')).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(2);
});

// --- copy layer ---

test('Duplicate layer copies its drawing on every frame, above it, unlocked, and is undoable', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300); // frame 1
  await addFrameBtn(page).click();
  await expect(tiles(page)).toHaveCount(2);
  await settled(page);
  await stroke(page, 700); // frame 2
  await openLayers(page);
  const [source] = await layerIds(page);
  await page.getByRole('button', { name: 'Lock Layer 1' }).click();

  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Rename' })).toBeEnabled();
  await expect(rows(page).first()).toContainText('Layer 1 copy'); // top row = above
  const copy = await activeLayerId(page);
  expect(copy).not.toBe(source);
  expect(await layerIds(page)).toEqual([source, copy]);
  await expect(page.getByRole('button', { name: 'Lock Layer 1 copy' })).toBeVisible(); // unlocked
  expect(await paintedAt(page, 900, 700, copy)).toBe(true);

  // Independent: drawing on the copy leaves the source alone.
  await stroke(page, 500);
  expect(await paintedAt(page, 900, 500, source)).toBe(false);

  await goToFrame(page, 1);
  expect(await paintedAt(page, 900, 300, copy)).toBe(true);

  await reloadApp(page);
  await expect(page.locator('.pp-layer')).toHaveCount(2);
  // Whichever frame it reopens on, both frames' copies were saved.
  await goToFrame(page, 1);
  expect(await paintedAt(page, 900, 300, copy)).toBe(true);
  await goToFrame(page, 2);
  expect(await paintedAt(page, 900, 700, copy)).toBe(true);
  expect(await paintedAt(page, 900, 500, source)).toBe(false);
});

test('undo removes a copied layer and redo brings it back with its drawing', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300);
  await openLayers(page);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Rename' })).toBeEnabled();
  const copy = await activeLayerId(page);

  await undo(page);
  await expect(rows(page)).toHaveCount(1);
  await redo(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Rename' })).toBeEnabled();
  expect(await activeLayerId(page)).toBe(copy);
  expect(await paintedAt(page, 900, 300, copy)).toBe(true);
});

test('Duplicate layer is off at the layer cap', async ({ page }) => {
  await openApp(page);
  await openLayers(page);
  for (let i = 1; i < 8; i++) await addLayer(page);
  await expect(page.getByRole('button', { name: 'Duplicate', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Duplicate', exact: true })).toBeEnabled();
});

// --- duplicate project ---

test('Duplicate in the gallery makes an independent copy, first in the list', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.locator('.pp-gallery').waitFor();
  const originalId = await page.locator('.pp-gallery-card').first().getAttribute('data-project-id');

  await page.getByRole('button', { name: 'More for Animation 1' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  const names = page.locator('.pp-gallery-card__name');
  await expect(names).toHaveText(['Animation 1 copy', 'Animation 1']);
  await expect(page.locator('.pp-gallery')).toBeVisible(); // stays on the gallery

  // Delete the original: the copy keeps its drawing.
  await page.getByRole('button', { name: 'More for Animation 1', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.locator('.pp-dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(names).toHaveText(['Animation 1 copy']);
  expect(await readDb(page, 'projects', originalId)).toBeNull();

  await page.getByRole('button', { name: 'Open Animation 1 copy' }).click();
  await page.locator('.pp-canvas').waitFor();
  expect(await paintedAt(page, 900, 300)).toBe(true);
});
