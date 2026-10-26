// Shared helpers for the e2e specs.
//
// Rule (see PROJECT_NOTES.md "Testing"): don't sleep a fixed time
// waiting for something to happen — wait for the thing itself, with
// expect.poll / waitFor. Fixed sleeps pad every run and compound as
// tests are added. The only acceptable fixed wait is proving something
// *doesn't* happen (there's nothing to poll for).

import { expect } from '@playwright/test';

// Opens the app into the editor. A fresh install starts on the empty
// gallery (2d), so this makes a new animation from there; an install
// that was left in the editor reopens it.
export async function openApp(page) {
  await page.goto('/index.html');
  await page.locator('.pp-canvas, .pp-gallery').first().waitFor();
  if (await page.locator('.pp-gallery').count()) {
    await page.getByRole('button', { name: 'New animation' }).click();
  }
  await page.locator('.pp-canvas').waitFor();
}

export async function reloadApp(page) {
  await page.reload();
  await page.locator('.pp-canvas').waitFor();
}

// Simulates the app going to the background / coming back.
export async function setVisibility(page, state) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

// Reads one record from the app's IndexedDB, straight from the page.
export function readDb(page, storeName, key) {
  return page.evaluate(([store, k]) => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); resolve(null); return; }
      const tx = db.transaction(store);
      const r = k === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(k);
      r.onsuccess = () => { db.close(); resolve(r.result ?? null); };
      r.onerror = () => { db.close(); reject(r.error); };
    };
  }), [storeName, key]);
}

// A fingerprint of the saved drawing (total PNG bytes across saved
// layer bitmaps, not thumbnails), or null if nothing is saved yet. Changes whenever a
// new save lands.
export async function savedDrawingBytes(page) {
  const records = await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('blobs')) { db.close(); resolve([]); return; }
      const r = db.transaction('blobs').objectStore('blobs').getAll();
      // Gallery thumbnails aren't the drawing.
      r.onsuccess = () => {
        db.close();
        resolve(r.result.filter((rec) => !rec.id.startsWith('thumb-')).map((rec) => rec.buffer.byteLength));
      };
      r.onerror = () => { db.close(); reject(r.error); };
    };
  }));
  return records.length ? records.reduce((a, b) => a + b, 0) : null;
}

// Waits until the saved drawing differs from `before` (a previous
// savedDrawingBytes value) — i.e. a new autosave has landed.
export async function waitForDrawingSave(page, before, options = {}) {
  await expect.poll(() => savedDrawingBytes(page), options).not.toBe(before);
}

export function savedToolSettings(page) {
  return readDb(page, 'meta', 'toolSettings').then((r) => r?.value ?? null);
}

// Waits until the saved tool settings include `expected` (a partial
// object, e.g. { tool: 'smudge' }).
export async function waitForToolSettings(page, expected, options = {}) {
  await expect.poll(() => savedToolSettings(page), options).toMatchObject(expected);
}

// --- the layer menu (tap the active layer's row) ---

// The layers panel isn't mid-change: the opacity slider is enabled
// (off while busy). Stands in for "the footer's buttons are enabled"
// from before the layer menu.
export const layersSettled = (page) => expect(page.getByLabel('Layer opacity')).toBeEnabled();

// Opens the layers panel if needed, then the active layer's menu.
export async function openLayerMenu(page) {
  if (!(await page.locator('.pp-layers').isVisible())) {
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
  }
  await layersSettled(page);
  if (!(await page.locator('.pp-layer-menu').isVisible())) {
    await page.locator('.pp-layers__row.is-active .pp-layers__name').click();
  }
  await expect(page.locator('.pp-layer-menu')).toBeVisible();
}

// An item in the layer menu (open it first).
export const layerMenuItem = (page, name) => page.locator('.pp-layer-menu').getByRole('menuitem', { name, exact: true });

// Opens the menu and picks `name`.
export async function layerMenu(page, name) {
  await openLayerMenu(page);
  await layerMenuItem(page, name).click();
}

// The layers panel is a menu (after 5c): a canvas touch with it open
// only closes it. Drawing helpers close it first, as she would, and
// reopen it after if it was open — `await reopen()` (a no-op if it
// wasn't), so tests written for the old always-open panel still flow.
export async function closeLayersPanel(page) {
  const open = page.locator('.pp-layers:not(.pp-layers--hidden)');
  if (await open.count() === 0) return async () => {};
  const button = page.getByRole('button', { name: 'Layers', exact: true });
  await button.click();
  await expect(open).toHaveCount(0);
  return async () => {
    await button.click();
    await expect(open).toHaveCount(1);
  };
}

// Opens the layers panel if it's closed (a tap outside it closes it).
export async function openLayersPanel(page) {
  const open = page.locator('.pp-layers:not(.pp-layers--hidden)');
  if (await open.count() === 0) await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(open).toHaveCount(1);
}
