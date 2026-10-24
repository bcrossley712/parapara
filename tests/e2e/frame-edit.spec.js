// End-to-end tests for step 4d: deleting a frame (frame menu, no
// confirm, undoable, never the last one), reordering frames by
// long-press and drag on the strip (undoable, she stays on her frame),
// and Copy / Paste in the layer menu (a layer's drawing into any layer,
// on this frame or another, pasted on top, undoable, refused on a
// locked layer).
//
// Run: npm run test:e2e
//
// Not covered (device-only): how the long-press feels with her stylus,
// whether iPadOS lets go of the strip's scroll once a tile lifts (the
// strip's touchmove listener), the auto-scroll speed near the strip's
// ends with many frames, and that no callout or text selection appears
// on a held tile.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, readDb, savedDrawingBytes, waitForDrawingSave, layersSettled, openLayerMenu, layerMenu, layerMenuItem } from './helpers.js';

const tiles = (page) => page.locator('.pp-frame-strip__tile');
const tile = (page, n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const menu = (page) => page.locator('.pp-frame-menu');
const menuItem = (page, name) => page.getByRole('menuitem', { name, exact: true });
const banner = (page) => page.locator('.pp-banner');
const undo = (page) => page.getByRole('button', { name: 'Undo' }).click();
const redo = (page) => page.getByRole('button', { name: 'Redo' }).click();

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => {
    throw new Error(`Native dialog shown: ${d.type()} "${d.message()}"`);
  });
});

const settled = (page) => expect(addFrameBtn(page)).toBeEnabled();

async function currentFrame(page) {
  await settled(page);
  return Number(await page.locator('.pp-frame-strip__tile.is-current').textContent());
}

async function addFrame(page) {
  const before = await tiles(page).count();
  await addFrameBtn(page).click();
  await expect(tiles(page)).toHaveCount(before + 1);
  await settled(page);
}

async function goToFrame(page, n) {
  await settled(page);
  if (await tile(page, n).getAttribute('aria-current') !== 'true') await tile(page, n).click();
  await expect(tile(page, n)).toHaveClass(/is-current/);
  await settled(page);
}

async function openMenu(page) {
  await settled(page);
  await page.locator('.pp-frame-strip__tile.is-current').click();
  await expect(menu(page)).toBeVisible();
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

// Is the active layer painted at canvas pixel (x, y)?
function paintedAt(page, x, y) {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector('.pp-layer--active').getContext('2d');
    return c.getImageData(px, py, 1, 1).data[3] > 0;
  }, [x, y]);
}

const tileIds = (page) => tiles(page).evaluateAll((els) => els.map((e) => e.dataset.frameId));
const savedOrder = async (page) => (await readDb(page, 'projects'))[0]?.frames;

// Three frames, each with one mark at its own height (200, 500, 800).
// Returns their ids in order; she ends on frame 3.
async function threeMarkedFrames(page) {
  await openApp(page);
  await stroke(page, 200);
  await addFrame(page);
  await stroke(page, 500);
  await addFrame(page);
  await stroke(page, 800);
  await settled(page);
  return tileIds(page);
}

// Long-press tile `from`, wait until it lifts, drag it onto tile `to`
// (by its number before the move) and let go.
async function dragTile(page, from, to) {
  await settled(page);
  const a = await tile(page, from).boundingBox();
  const b = await tile(page, to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await expect(tile(page, from)).toHaveClass(/is-lifted/);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.is-lifted')).toHaveCount(0);
}

// --- delete ---

test('the last frame offers no Delete; with two it does', async ({ page }) => {
  await openApp(page);
  await openMenu(page);
  await expect(menuItem(page, 'Duplicate')).toBeVisible();
  await expect(menuItem(page, 'Delete')).toHaveCount(0);
  await tile(page, 1).click(); // closes it
  await addFrame(page);
  await openMenu(page);
  await expect(menuItem(page, 'Delete')).toBeVisible();
});

test('Delete takes the frame out and lands on the one before; undo and redo work and it is saved', async ({ page }) => {
  const [f1, f2, f3] = await threeMarkedFrames(page);
  await goToFrame(page, 2);
  await openMenu(page);
  await menuItem(page, 'Delete').click();
  await expect(tiles(page)).toHaveCount(2);
  expect(await tileIds(page)).toEqual([f1, f3]);
  expect(await currentFrame(page)).toBe(1);
  expect(await paintedAt(page, 900, 200)).toBe(true);

  // Undo puts it back where it was, with its drawing, and shows it.
  await undo(page);
  await expect(tiles(page)).toHaveCount(3);
  expect(await tileIds(page)).toEqual([f1, f2, f3]);
  expect(await currentFrame(page)).toBe(2);
  expect(await paintedAt(page, 900, 500)).toBe(true);

  await redo(page);
  await expect(tiles(page)).toHaveCount(2);
  expect(await tileIds(page)).toEqual([f1, f3]);

  await expect.poll(() => savedOrder(page)).toEqual([f1, f3]);
  await reloadApp(page);
  await expect(tiles(page)).toHaveCount(2);
  await goToFrame(page, 2);
  expect(await paintedAt(page, 900, 800)).toBe(true);
  expect(await paintedAt(page, 900, 500)).toBe(false);
});

test('deleting frame 1 lands on the new first frame', async ({ page }) => {
  const [, f2, f3] = await threeMarkedFrames(page);
  await goToFrame(page, 1);
  await openMenu(page);
  await menuItem(page, 'Delete').click();
  await expect(tiles(page)).toHaveCount(2);
  expect(await tileIds(page)).toEqual([f2, f3]);
  expect(await currentFrame(page)).toBe(1);
  expect(await paintedAt(page, 900, 500)).toBe(true);
});

// --- reorder ---

test('long-press and drag moves a frame; she stays on her frame; undo, redo and reload keep it right', async ({ page }) => {
  const [f1, f2, f3] = await threeMarkedFrames(page);
  // She's on frame 3; move frame 1 to the end.
  await dragTile(page, 1, 3);
  expect(await tileIds(page)).toEqual([f2, f3, f1]);
  // Still on the frame she was on (f3, now number 2).
  expect(await currentFrame(page)).toBe(2);
  expect(await paintedAt(page, 900, 800)).toBe(true);
  // The drop didn't open the menu or switch frames.
  await expect(menu(page)).toHaveCount(0);

  await undo(page);
  expect(await tileIds(page)).toEqual([f1, f2, f3]);
  expect(await currentFrame(page)).toBe(3);
  await redo(page);
  expect(await tileIds(page)).toEqual([f2, f3, f1]);

  await expect.poll(() => savedOrder(page)).toEqual([f2, f3, f1]);
  await reloadApp(page);
  expect(await tileIds(page)).toEqual([f2, f3, f1]);
  await goToFrame(page, 3);
  expect(await paintedAt(page, 900, 200)).toBe(true);
});

test('dragging the current frame moves it and keeps it current, with no menu', async ({ page }) => {
  const [f1, f2, f3] = await threeMarkedFrames(page);
  await dragTile(page, 3, 1);
  expect(await tileIds(page)).toEqual([f3, f1, f2]);
  expect(await currentFrame(page)).toBe(1);
  await expect(menu(page)).toHaveCount(0);
  expect(await paintedAt(page, 900, 800)).toBe(true);
});

test('a quick drag without the long-press moves nothing', async ({ page }) => {
  const ids = await threeMarkedFrames(page);
  const a = await tile(page, 1).boundingBox();
  const b = await tile(page, 3).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('.is-lifted')).toHaveCount(0);
  expect(await tileIds(page)).toEqual(ids);
  expect(await currentFrame(page)).toBe(3);
});

test('a move updates the onion ghosts without a frame switch', async ({ page }) => {
  await threeMarkedFrames(page);
  await page.getByRole('button', { name: 'Onion skin', exact: true }).click();
  // On frame 3 the ghost is frame 2's mark (y 500). After moving frame
  // 1 to just before her, the ghost is frame 1's (y 200).
  // The ghost canvas is in canvas pixels and exists only while ghosts show.
  const ghostAt = (y) => page.evaluate((py) => {
    const c = document.querySelector('.pp-onion');
    return c ? c.getContext('2d').getImageData(900, py, 1, 1).data[3] > 0 : false;
  }, y);
  await expect.poll(() => ghostAt(500)).toBe(true);
  await dragTile(page, 1, 2);
  await expect.poll(() => ghostAt(200)).toBe(true);
  await expect.poll(() => ghostAt(500)).toBe(false);
});

// --- copy / paste drawing (the layer menu) ---

const layerIdsTopFirst = (page) => page.locator('.pp-layers__row').evaluateAll((els) => els.map((e) => e.dataset.layerId));
function paintedOn(page, layerId, x, y) {
  return page.evaluate(([id, px, py]) => {
    const c = document.querySelector(`.pp-layer[data-layer-id="${id}"]`);
    return c.getContext('2d').getImageData(px, py, 1, 1).data[3] > 0;
  }, [layerId, x, y]);
}
async function selectLayer(page, id) {
  await page.locator(`.pp-layers__row[data-layer-id="${id}"] .pp-layers__name`).click();
  await expect(page.locator(`.pp-layers__row[data-layer-id="${id}"]`)).toHaveClass(/is-active/);
}

test('the frame menu has no copy or paste (they are layer actions)', async ({ page }) => {
  await openApp(page);
  await addFrame(page);
  await openMenu(page);
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Duplicate', 'Delete']);
});

test('Paste puts a layer\'s drawing into another layer on the same frame, on top; undoable', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300); // Layer 1
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Add layer' }).click();
  await layersSettled(page);
  await stroke(page, 600); // Layer 2
  const [l2, l1] = await layerIdsTopFirst(page);

  await selectLayer(page, l1);
  await layerMenu(page, 'Copy');
  await expect(banner(page)).toContainText('Copied Layer 1');
  await selectLayer(page, l2);
  await layerMenu(page, 'Paste');
  expect(await paintedOn(page, l2, 900, 300)).toBe(true);
  expect(await paintedOn(page, l2, 900, 600)).toBe(true); // on top, not replaced
  expect(await paintedOn(page, l1, 900, 300)).toBe(true); // the source is untouched
  expect(await paintedOn(page, l1, 900, 600)).toBe(false);

  await undo(page);
  expect(await paintedOn(page, l2, 900, 300)).toBe(false);
  expect(await paintedOn(page, l2, 900, 600)).toBe(true);
});

test('Paste works on another frame too; undo and redo; saved; the clipboard ends with the project', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300);
  await addFrame(page);
  await stroke(page, 600);

  await openLayerMenu(page);
  await expect(layerMenuItem(page, 'Paste')).toBeDisabled(); // nothing copied yet
  await goToFrame(page, 1);
  await layerMenu(page, 'Copy');

  await goToFrame(page, 2);
  const before = await savedDrawingBytes(page);
  await layerMenu(page, 'Paste');
  expect(await paintedAt(page, 900, 300)).toBe(true);
  expect(await paintedAt(page, 900, 600)).toBe(true);

  await undo(page);
  expect(await paintedAt(page, 900, 300)).toBe(false);
  await redo(page);
  expect(await paintedAt(page, 900, 300)).toBe(true);

  await waitForDrawingSave(page, before);
  await reloadApp(page);
  await goToFrame(page, 2);
  expect(await paintedAt(page, 900, 300)).toBe(true);
  expect(await paintedAt(page, 900, 600)).toBe(true);
  await openLayerMenu(page);
  await expect(layerMenuItem(page, 'Paste')).toBeDisabled();
});

test('copying a blank layer says so and copies nothing', async ({ page }) => {
  await openApp(page);
  await layerMenu(page, 'Copy');
  await expect(banner(page)).toContainText('nothing to copy');
  await openLayerMenu(page);
  await expect(layerMenuItem(page, 'Paste')).toBeDisabled();
});

test('a locked layer refuses a paste', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300);
  await layerMenu(page, 'Copy');
  await addFrame(page);
  await page.getByRole('button', { name: 'Lock Layer 1' }).click();
  await layerMenu(page, 'Paste');
  await expect(banner(page)).toContainText('locked');
  expect(await paintedAt(page, 900, 300)).toBe(false);
  await undo(page); // the add frame, not a paste
  await expect(tiles(page)).toHaveCount(1);
});

test('a paste right after erasing still paints (the eraser\'s mode does not carry over)', async ({ page }) => {
  await openApp(page);
  await stroke(page, 300);
  await layerMenu(page, 'Copy');
  await addFrame(page);
  // Erase somewhere else; the layer's context is left in erase mode.
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await stroke(page, 900);
  await layerMenu(page, 'Paste');
  expect(await paintedAt(page, 900, 300)).toBe(true);
});
