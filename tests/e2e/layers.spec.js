// End-to-end tests for step 2c's layer foundations (pass 1): layers
// shared across frames, one <canvas> per layer, the version-1 → 2
// database migration, and fill reading every visible layer while
// writing only the active one. There's no layers panel yet, so these
// seed the database directly and open the app on it.
//
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, closeLayersPanel } from './helpers.js';

// Creates the app's database before the app ever opens it. Runs on a
// plain same-origin page (the manifest), so the app's own startup
// can't race it. `version` 1 or 2; `rects` maps a blob id to a filled
// or outlined rectangle to encode as that layer's PNG.
async function seedDatabase(page, { version, projects, frames, rects }) {
  await page.goto('/manifest.json');
  await page.evaluate(async ({ version, projects, frames, rects }) => {
    const blobs = [];
    for (const [id, r] of Object.entries(rects)) {
      const c = new OffscreenCanvas(1920, 1080);
      const ctx = c.getContext('2d');
      if (r.outline) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = r.outline;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      } else {
        ctx.fillStyle = r.color ?? '#000000';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      const blob = await c.convertToBlob({ type: 'image/png' });
      blobs.push({ id, projectId: projects[0].id, type: 'image/png', buffer: await blob.arrayBuffer() });
    }
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('parapara', version);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('frames', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        db.createObjectStore('blobs', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        db.createObjectStore('meta', { keyPath: 'key' });
        const tx = req.transaction;
        for (const p of projects) tx.objectStore('projects').put(p);
        for (const f of frames) tx.objectStore('frames').put(f);
        for (const b of blobs) tx.objectStore('blobs').put(b);
        tx.objectStore('meta').put({ key: 'lastProjectId', value: projects[0].id });
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
  }, { version, projects, frames, rects });
}

// RGBA of one pixel on a layer canvas (by layer id, or the active one).
function pixel(page, x, y, layerId = null) {
  return page.evaluate(([x, y, id]) => {
    const c = id
      ? document.querySelector(`.pp-layer[data-layer-id="${id}"]`)
      : document.querySelector('.pp-layer--active');
    return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
  }, [x, y, layerId]);
}

function blobBytes(page, id) {
  return page.evaluate((key) => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const r = db.transaction('blobs').objectStore('blobs').get(key);
      r.onsuccess = () => { db.close(); resolve(r.result ? r.result.buffer.byteLength : null); };
      r.onerror = () => { db.close(); reject(r.error); };
    };
  }), id);
}

async function tapCanvas(page, x, y) {
  const reopen = await closeLayersPanel(page);
  const box = await page.locator('.pp-canvas').boundingBox();
  await page.mouse.click(box.x + (x / 1920) * box.width, box.y + (y / 1080) * box.height);
  await reopen();
}

const baseProject = {
  name: 'Untitled', createdAt: 1, updatedAt: 1,
  canvas: { width: 1920, height: 1080 }, fps: 12, audioClips: [],
};

test('a drawing saved before the layer change still opens', async ({ page }) => {
  // Version 1: the frame carried its own layer list.
  await seedDatabase(page, {
    version: 1,
    projects: [{ ...baseProject, id: 'p1', frames: ['f1'] }],
    frames: [{
      id: 'f1', projectId: 'p1', image: null, activeLayerId: 'L1',
      layers: [{ id: 'L1', name: 'Layer 1', bitmapRef: 'b1', visible: true, opacity: 1, locked: false }],
    }],
    rects: { b1: { x: 800, y: 400, w: 300, h: 200 } },
  });

  await openApp(page);
  expect(await pixel(page, 950, 500)).toEqual([0, 0, 0, 255]);
  expect((await pixel(page, 200, 200))[3]).toBe(0);

  // Drawing on it saves to the same bitmap as before.
  const before = await blobBytes(page, 'b1');
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  const box = await page.locator('.pp-canvas').boundingBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 80);
  await page.mouse.up();
  await expect.poll(() => blobBytes(page, 'b1')).not.toBe(before);
});

test('layers stack in order, fill stops at lines on another layer, and only the edited layer is saved', async ({ page }) => {
  // Version 2: a blank "color" layer (active, bottom) under a "line"
  // layer with a rectangle outline.
  await seedDatabase(page, {
    version: 2,
    projects: [{
      ...baseProject, id: 'p1', frames: ['f1'], activeLayerId: 'color',
      layers: [
        { id: 'color', name: 'Color', visible: true, opacity: 1, locked: false },
        { id: 'line', name: 'Line', visible: true, opacity: 1, locked: false },
      ],
    }],
    frames: [{ id: 'f1', projectId: 'p1', image: null, bitmapRefs: { color: 'b-color', line: 'b-line' } }],
    rects: { 'b-line': { x: 600, y: 300, w: 700, h: 500, outline: 10 } },
  });

  await openApp(page);
  const ids = await page.locator('.pp-layer').evaluateAll((els) => els.map((e) => e.dataset.layerId));
  expect(ids).toEqual(['color', 'line']); // bottom first, so line art is on top
  await expect(page.locator('.pp-layer--active')).toHaveAttribute('data-layer-id', 'color');

  const lineBytes = await blobBytes(page, 'b-line');
  await page.getByRole('button', { name: 'Fill', exact: true }).click();
  await tapCanvas(page, 950, 550);

  // Inside the outline: filled, on the color layer only.
  expect((await pixel(page, 950, 550, 'color'))[3]).toBe(255);
  expect((await pixel(page, 950, 550, 'line'))[3]).toBe(0);
  // Outside the outline: untouched — the fill saw the line layer.
  expect((await pixel(page, 200, 200, 'color'))[3]).toBe(0);

  await expect.poll(() => blobBytes(page, 'b-color')).not.toBeNull();
  expect(await blobBytes(page, 'b-line')).toBe(lineBytes);

  await reloadApp(page);
  expect((await pixel(page, 950, 550, 'color'))[3]).toBe(255);
  expect((await pixel(page, 200, 200, 'color'))[3]).toBe(0);
  expect((await pixel(page, 600, 550, 'line'))[3]).toBe(255);
});

test('hidden layers are not shown and fill ignores them', async ({ page }) => {
  await seedDatabase(page, {
    version: 2,
    projects: [{
      ...baseProject, id: 'p1', frames: ['f1'], activeLayerId: 'color',
      layers: [
        { id: 'color', name: 'Color', visible: true, opacity: 1, locked: false },
        { id: 'line', name: 'Line', visible: false, opacity: 0.5, locked: false },
      ],
    }],
    frames: [{ id: 'f1', projectId: 'p1', image: null, bitmapRefs: { color: 'b-color', line: 'b-line' } }],
    rects: { 'b-line': { x: 600, y: 300, w: 700, h: 500, outline: 10 } },
  });

  await openApp(page);
  const line = page.locator('.pp-layer[data-layer-id="line"]');
  await expect(line).toHaveCSS('visibility', 'hidden');
  await expect(line).toHaveCSS('opacity', '0.5');

  await page.getByRole('button', { name: 'Fill', exact: true }).click();
  await tapCanvas(page, 950, 550);
  // The hidden outline doesn't contain the fill.
  expect((await pixel(page, 200, 200, 'color'))[3]).toBe(255);
});
