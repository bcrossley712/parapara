// End-to-end tests for the layers panel (step 2c): add, delete,
// reorder, visibility, lock, opacity, rename, the cap, undo of layer
// changes, and what's remembered across a reload.
//
// Run: npm run test:e2e
//
// Not covered here (device-only): how drag-to-reorder feels with the
// stylus, and canvas memory with 8 layers on the iPad (the gear menu's
// "Fill all layers" is for that).

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, savedDrawingBytes, waitForDrawingSave } from './helpers.js';

const rows = (page) => page.locator('.pp-layers__row');
const addBtn = (page) => page.getByRole('button', { name: 'Add layer' });

// Opens the panel if it isn't already (it's remembered open across a
// reload, so after reloadApp it usually is).
async function openPanel(page) {
  if (!(await page.locator('.pp-layers').isVisible())) {
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
  }
  await expect(page.locator('.pp-layers')).toBeVisible();
}

// Layer names as listed (top first).
const rowNames = (page) => page.locator('.pp-layers__name').allTextContents();

// Layer ids in stacking order (bottom first), from the canvas.
const stackIds = (page) =>
  page.locator('.pp-layer').evaluateAll((els) => els.map((e) => e.dataset.layerId));

const activeId = (page) =>
  page.locator('.pp-layer--active').getAttribute('data-layer-id');

async function addLayer(page) {
  const before = await rows(page).count();
  await addBtn(page).click();
  await expect(rows(page)).toHaveCount(before + 1);
  // The add finishes asynchronously; Rename is disabled until it does.
  await expect(page.getByRole('button', { name: 'Rename' })).toBeEnabled();
}

// A mouse stroke in canvas-pixel coordinates.
async function stroke(page, x1, y1, x2, y2) {
  const box = await page.locator('.pp-canvas').boundingBox();
  const sx = (x) => box.x + (x / 1920) * box.width;
  const sy = (y) => box.y + (y / 1080) * box.height;
  await page.mouse.move(sx(x1), sy(y1));
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(sx(x1 + ((x2 - x1) * i) / 20), sy(y1 + ((y2 - y1) * i) / 20));
  }
  await page.mouse.up();
}

// Painted pixel count on one layer canvas.
function painted(page, layerId) {
  return page.evaluate((id) => {
    const c = document.querySelector(`.pp-layer[data-layer-id="${id}"]`);
    if (!c) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  }, layerId);
}

function blobCount(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const r = db.transaction('blobs').objectStore('blobs').count();
      r.onsuccess = () => { db.close(); resolve(r.result); };
      r.onerror = () => { db.close(); reject(r.error); };
    };
  }));
}

function savedProject(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const r = db.transaction('projects').objectStore('projects').getAll();
      r.onsuccess = () => { db.close(); resolve(r.result[0] ?? null); };
      r.onerror = () => { db.close(); reject(r.error); };
    };
  }));
}

const undo = (page) => page.getByRole('button', { name: 'Undo' }).click();
const redo = (page) => page.getByRole('button', { name: 'Redo' }).click();

test('adding a layer puts it above the active one and draws there; both survive a reload', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  const first = await activeId(page);
  await stroke(page, 300, 300, 800, 400);

  await addLayer(page);
  expect(await rowNames(page)).toEqual(['Layer 2', 'Layer 1']);
  const second = await activeId(page);
  expect(second).not.toBe(first);
  expect(await stackIds(page)).toEqual([first, second]);
  await expect(rows(page).first()).toHaveClass(/is-active/);

  const firstPainted = await painted(page, first);
  await stroke(page, 300, 700, 800, 800);
  expect(await painted(page, first)).toBe(firstPainted);
  expect(await painted(page, second)).toBeGreaterThan(500);

  const bytes = await savedDrawingBytes(page);
  await waitForDrawingSave(page, bytes);
  await reloadApp(page);
  await openPanel(page);
  expect(await rowNames(page)).toEqual(['Layer 2', 'Layer 1']);
  expect(await activeId(page)).toBe(second);
  expect(await painted(page, first)).toBeGreaterThan(500);
  expect(await painted(page, second)).toBeGreaterThan(500);
});

test('undo removes an added layer and redo brings it back', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  await addLayer(page);
  const added = await activeId(page);

  await undo(page);
  await expect(rows(page)).toHaveCount(1);
  expect(await painted(page, added)).toBeNull();

  await redo(page);
  await expect(rows(page)).toHaveCount(2);
  await expect.poll(() => activeId(page)).toBe(added);
});

test('a deleted layer comes back with its drawing on undo, and is gone after redo and a reload', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  const bottom = await activeId(page);
  await addLayer(page);
  const top = await activeId(page);
  await stroke(page, 300, 300, 1200, 600);
  const drawn = await painted(page, top);
  expect(drawn).toBeGreaterThan(500);

  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect.poll(() => activeId(page)).toBe(bottom); // the layer below
  expect(await painted(page, top)).toBeNull();

  await undo(page);
  await expect(rows(page)).toHaveCount(2);
  await expect.poll(() => painted(page, top)).toBe(drawn);
  expect(await stackIds(page)).toEqual([bottom, top]);

  await redo(page);
  await expect(rows(page)).toHaveCount(1);

  // Its pixels stay in storage while undo might need them; the next
  // launch cleans them up.
  await expect.poll(async () => (await savedProject(page))?.layers.length).toBe(1);
  await reloadApp(page);
  await expect.poll(() => blobCount(page)).toBe(0); // bottom layer is blank
  await openPanel(page);
  await expect(rows(page)).toHaveCount(1);
});

test('the only layer cannot be deleted', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  await expect(page.getByRole('button', { name: 'Delete' })).toBeDisabled();
});

test('dragging a layer by its handle reorders it; undo puts it back; order is saved', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  const l1 = await activeId(page);
  await addLayer(page);
  const l2 = await activeId(page);
  await addLayer(page);
  const l3 = await activeId(page);
  expect(await rowNames(page)).toEqual(['Layer 3', 'Layer 2', 'Layer 1']);

  // Drag Layer 1 (bottom row) to the top.
  const handle = page.getByLabel('Reorder Layer 1');
  const hb = await handle.boundingBox();
  const topRow = await rows(page).first().boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - ((hb.y - topRow.y + 10) * i) / 10);
  }
  await page.mouse.up();

  expect(await rowNames(page)).toEqual(['Layer 1', 'Layer 3', 'Layer 2']);
  expect(await stackIds(page)).toEqual([l2, l3, l1]);

  await undo(page);
  expect(await stackIds(page)).toEqual([l1, l2, l3]);
  await redo(page);
  expect(await stackIds(page)).toEqual([l2, l3, l1]);

  await expect.poll(async () => (await savedProject(page))?.layers.map((l) => l.id)).toEqual([l2, l3, l1]);
  await reloadApp(page);
  expect(await stackIds(page)).toEqual([l2, l3, l1]);
});

test('opacity applies live, is one undo step, and is saved', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  const id = await activeId(page);
  const slider = page.getByRole('slider', { name: 'Layer opacity' });
  await slider.evaluate((el) => {
    for (const v of [80, 60, 40]) {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const layerEl = page.locator(`.pp-layer[data-layer-id="${id}"]`);
  await expect(layerEl).toHaveCSS('opacity', '0.4');
  await expect(page.locator('.pp-layers__opacity-text')).toHaveText('Opacity 40%');

  await undo(page);
  await expect(layerEl).toHaveCSS('opacity', '1');
  await expect(slider).toHaveValue('100');
  await redo(page);
  await expect(layerEl).toHaveCSS('opacity', '0.4');

  await expect.poll(async () => (await savedProject(page))?.layers[0].opacity).toBe(0.4);
  await reloadApp(page);
  await expect(layerEl).toHaveCSS('opacity', '0.4');
});

test('a locked or hidden layer refuses strokes with a notice; toggles are saved but not undoable', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  const id = await activeId(page);

  await page.getByRole('button', { name: 'Lock Layer 1' }).click();
  await stroke(page, 300, 300, 800, 400);
  expect(await painted(page, id)).toBe(0);
  // A fading banner, not a toast that needs OK: no button, and it goes
  // away on its own.
  const banner = page.locator('#pp-banner');
  await expect(banner).toContainText('locked');
  await expect(banner.locator('button')).toHaveCount(0);
  await expect(banner).toHaveCSS('pointer-events', 'none');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(banner).toHaveCount(0, { timeout: 5000 });

  await page.getByRole('button', { name: 'Unlock Layer 1' }).click();
  await page.getByRole('button', { name: 'Hide Layer 1' }).click();
  await expect(page.locator(`.pp-layer[data-layer-id="${id}"]`)).toHaveCSS('visibility', 'hidden');
  await stroke(page, 300, 300, 800, 400);
  expect(await painted(page, id)).toBe(0);
  await expect(page.locator('#pp-banner')).toContainText('hidden');

  await expect.poll(async () => (await savedProject(page))?.layers[0].visible).toBe(false);
  await reloadApp(page);
  await expect(page.locator(`.pp-layer[data-layer-id="${id}"]`)).toHaveCSS('visibility', 'hidden');
});

test('rename edits the name in place and it is saved', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  await page.getByRole('button', { name: 'Rename' }).click();
  const input = page.getByRole('textbox', { name: 'Layer name' });
  await expect(input).toBeFocused();
  await input.fill('Line art');
  await input.press('Enter');
  expect(await rowNames(page)).toEqual(['Line art']);

  // Escape cancels.
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('textbox', { name: 'Layer name' }).fill('Nope');
  await page.getByRole('textbox', { name: 'Layer name' }).press('Escape');
  expect(await rowNames(page)).toEqual(['Line art']);

  await expect.poll(async () => (await savedProject(page))?.layers[0].name).toBe('Line art');
  await reloadApp(page);
  await openPanel(page);
  expect(await rowNames(page)).toEqual(['Line art']);
});

test('undoing a stroke on another layer changes that layer, not the active one', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  const l1 = await activeId(page);
  await stroke(page, 300, 300, 800, 400);
  await addLayer(page);
  const l2 = await activeId(page);
  await stroke(page, 300, 700, 800, 800);
  const l2Painted = await painted(page, l2);

  // Make Layer 1 active, then undo twice: the Layer 2 stroke, then the
  // add. The Layer 1 stroke is next and lands on Layer 1.
  await page.locator(`.pp-layers__row[data-layer-id="${l1}"]`).click();
  await expect.poll(() => activeId(page)).toBe(l1);
  await undo(page);
  expect(await painted(page, l2)).toBe(0);
  await undo(page);
  await expect(rows(page)).toHaveCount(1);
  await undo(page);
  expect(await painted(page, l1)).toBe(0);
  expect(l2Painted).toBeGreaterThan(0);
});

test('the layer cap disables Add at 8, and the panel stays open across a reload', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  for (let i = 0; i < 7; i++) await addLayer(page);
  await expect(rows(page)).toHaveCount(8);
  await expect(addBtn(page)).toBeDisabled();

  await expect.poll(async () => (await savedProject(page))?.layers.length).toBe(8);
  await reloadApp(page);
  await expect(page.locator('.pp-layers')).toBeVisible(); // remembered open
  await expect(rows(page)).toHaveCount(8);

  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.locator('.pp-layers')).toBeHidden();
  await expect.poll(() => page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('parapara');
    req.onsuccess = () => {
      const r = req.result.transaction('meta').objectStore('meta').get('uiState');
      r.onsuccess = () => { req.result.close(); resolve(r.result?.value ?? null); };
    };
  }))).toMatchObject({ layersPanelOpen: false });
  await reloadApp(page);
  await expect(page.locator('.pp-layers')).toBeHidden();
});

test('fill stops at lines on another layer, through the real panel', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  const color = await activeId(page);
  await addLayer(page);
  const line = await activeId(page);
  // A closed box of strokes on the line layer. Each runs past the
  // corners: smoothing ends a stroke half a segment short of the last
  // point, which would leave gaps.
  await stroke(page, 500, 300, 1400, 300);
  await stroke(page, 1300, 200, 1300, 900);
  await stroke(page, 1400, 800, 500, 800);
  await stroke(page, 600, 900, 600, 200);

  await page.locator(`.pp-layers__row[data-layer-id="${color}"]`).click();
  await page.getByRole('button', { name: 'Fill', exact: true }).click();
  const box = await page.locator('.pp-canvas').boundingBox();
  await page.mouse.click(box.x + (950 / 1920) * box.width, box.y + (550 / 1080) * box.height);

  const inside = await page.evaluate((id) => {
    const c = document.querySelector(`.pp-layer[data-layer-id="${id}"]`).getContext('2d');
    return [c.getImageData(950, 550, 1, 1).data[3], c.getImageData(100, 100, 1, 1).data[3]];
  }, color);
  expect(inside).toEqual([255, 0]);
  expect(await painted(page, line)).toBeGreaterThan(0);
});

test('the developer fill tool reaches the layer cap and paints every layer', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Fill all layers' }).click();
  await expect(page.locator('.pp-layer')).toHaveCount(8);
  await expect.poll(async () => {
    const ids = await stackIds(page);
    const counts = await Promise.all(ids.map((id) => painted(page, id)));
    return counts.every((n) => n === 1920 * 1080);
  }, { timeout: 15000 }).toBe(true);
});
