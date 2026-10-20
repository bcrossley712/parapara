// End-to-end tests for the reference image (step 3a): adding one from
// the frame menu through the photo picker, adjust mode (drag, pinch,
// opacity, Delete, Replace, Done, and tapping another control to
// commit), undo/redo, Hide images, fill and the eyedropper seeing it,
// the gallery thumbnail, and copy frame / duplicate project sharing
// or copying it.
//
// Run: npm run test:e2e
//
// Not covered here (device-only): the iPad's photo picker (Photos vs
// Files, HEIC), memory with big photos, and how adjusting feels with
// fingers and the stylus.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, readDb } from './helpers.js';

const tiles = (page) => page.locator('.pp-frame-strip__tile');
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const bar = (page) => page.locator('.pp-reference-bar');
const rail = (page) => page.locator('.pp-tool-rail');
const refImage = (page) => page.locator('.pp-reference__image');
const undoBtn = (page) => page.getByRole('button', { name: 'Undo' });
const redoBtn = (page) => page.getByRole('button', { name: 'Redo' });

// A 200×100 PNG: left half red, right half blue. Fit to the 1920×1080
// canvas it's 1920×960, centered: y 60–1020, red for x < 960.
async function testImage(page) {
  const base64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(100, 0, 100, 100);
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

async function settled(page) {
  await expect(addFrameBtn(page)).toBeEnabled();
}

async function openFrameMenu(page) {
  await settled(page);
  await page.locator('.pp-frame-strip__tile.is-current').click();
  await expect(page.locator('.pp-frame-menu')).toBeVisible();
}

// Frame menu → Add image → the picker → adjust mode on the new image.
async function addImage(page) {
  await openFrameMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Add image' }).click();
  await (await chooser).setFiles(await testImage(page));
  await expect(bar(page)).toBeVisible();
  await expect(refImage(page)).toHaveCount(1);
  await settled(page);
}

async function done(page) {
  await bar(page).getByRole('button', { name: 'Done' }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(rail(page)).toBeVisible();
}

// The open frame's saved record (by its tile's position: a new
// project's saved currentFrameId can lag behind).
async function savedFrame(page) {
  const project = (await readDb(page, 'projects'))[0];
  const index = Number(await page.locator('.pp-frame-strip__tile.is-current').textContent()) - 1;
  return readDb(page, 'frames', project.frames[index]);
}

async function waitForSavedImage(page, check) {
  await expect.poll(async () => check((await savedFrame(page))?.image ?? null)).toBe(true);
}

// Two #rrggbb colors within `tolerance` per channel.
function expectNear(actual, expected, tolerance = 3) {
  const ch = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const a = ch(actual);
  const e = ch(expected);
  const ok = a.every((v, i) => Math.abs(v - e[i]) <= tolerance);
  expect(ok, `${actual} should be within ${tolerance} of ${expected}`).toBe(true);
}

// Canvas-pixel point -> screen point (view not moved).
async function screenPoint(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

async function drag(page, from, to) {
  const a = await screenPoint(page, from.x, from.y);
  const b = await screenPoint(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

async function tapCanvas(page, x, y) {
  const p = await screenPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}

// What the eyedropper picks at a canvas point.
async function pick(page, x, y) {
  const swatch = page.locator('.pp-color-swatch');
  await swatch.click();
  await page.getByRole('button', { name: 'Eyedropper' }).click();
  await tapCanvas(page, x, y);
  await expect(swatch).not.toHaveClass(/is-picking/);
  await swatch.click();
  const hex = await page.locator('.pp-color-picker__hex-input').inputValue();
  await page.locator('.pp-tool-rail').click({ position: { x: 5, y: 400 } });
  return `#${hex.toLowerCase()}`;
}

function activeLayerAlpha(page, x, y) {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector('.pp-layer--active').getContext('2d');
    return c.getImageData(px, py, 1, 1).data[3];
  }, [x, y]);
}

test('Add image opens the picker, places the photo at 50% in adjust mode, and Done saves it as one undo step', async ({ page }) => {
  await openApp(page);
  await addImage(page);
  await expect(rail(page)).toBeHidden();
  await expect(bar(page)).toContainText('Opacity 50%');
  // Undo/redo are off while adjusting.
  await expect(undoBtn(page)).toBeDisabled();

  await done(page);
  await waitForSavedImage(page, (img) => img !== null);
  const { image } = await savedFrame(page);
  expect(image).toMatchObject({ x: 960, y: 540, scale: 9.6, rotation: 0, opacity: 0.5 });
  const blob = await readDb(page, 'blobs', image.blobRef);
  expect(blob.type).toBe('image/jpeg'); // an opaque PNG is saved as JPEG

  // Survives a reload; the menu now says Adjust image.
  await reloadApp(page);
  await expect(refImage(page)).toHaveCount(1);
  await openFrameMenu(page);
  await expect(page.getByRole('menuitem', { name: 'Adjust image' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Hide images' })).toBeVisible();
});

test('undo takes the image out and redo puts it back', async ({ page }) => {
  await openApp(page);
  await addImage(page);
  await done(page);
  await undoBtn(page).click();
  await expect(refImage(page)).toHaveCount(0);
  await waitForSavedImage(page, (img) => img === null);
  await redoBtn(page).click();
  await expect(refImage(page)).toHaveCount(1);
  await waitForSavedImage(page, (img) => img?.x === 960);
});

test('dragging in adjust mode moves the image, not the drawing; undo puts it back', async ({ page }) => {
  await openApp(page);
  await addImage(page);
  await done(page);
  const before = (await savedFrame(page)).image;

  await openFrameMenu(page);
  await page.getByRole('menuitem', { name: 'Adjust image' }).click();
  await expect(bar(page)).toBeVisible();
  await drag(page, { x: 800, y: 500 }, { x: 1000, y: 400 });
  // Nothing drawn on the layer.
  expect(await activeLayerAlpha(page, 900, 450)).toBe(0);
  await done(page);
  await waitForSavedImage(page, (img) => Math.abs(img.x - 1160) < 3 && Math.abs(img.y - 440) < 3);
  expect((await savedFrame(page)).image.blobRef).toBe(before.blobRef);

  await undoBtn(page).click();
  await waitForSavedImage(page, (img) => img.x === 960 && img.y === 540);
});

test('two fingers scale the image in adjust mode', async ({ page }) => {
  await openApp(page);
  await addImage(page);
  const cdp = await page.context().newCDPSession(page);
  const a = await screenPoint(page, 860, 540);
  const b = await screenPoint(page, 1060, 540);
  const a2 = await screenPoint(page, 760, 540);
  const b2 = await screenPoint(page, 1160, 540);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((p, id) => ({ id, x: p.x, y: p.y })),
  });
  await touch('touchStart', [a]);
  await touch('touchStart', [a, b]);
  for (let i = 1; i <= 5; i++) {
    const t = i / 5;
    await touch('touchMove', [
      { x: a.x + (a2.x - a.x) * t, y: a.y },
      { x: b.x + (b2.x - b.x) * t, y: b.y },
    ]);
  }
  await touch('touchEnd', []);
  await done(page);
  await waitForSavedImage(page, (img) => Math.abs(img.scale - 19.2) < 0.1 && Math.abs(img.x - 960) < 2);
});

test('opacity, Delete and Replace in the adjust bar', async ({ page }) => {
  await openApp(page);
  await addImage(page);
  const slider = bar(page).getByRole('slider', { name: 'Image opacity' });
  await slider.fill('80');
  await expect(bar(page)).toContainText('Opacity 80%');
  await done(page);
  await waitForSavedImage(page, (img) => img?.opacity === 0.8);
  const first = (await savedFrame(page)).image.blobRef;

  // Replace: a new stored image, placed fresh; one undo goes back.
  await openFrameMenu(page);
  await page.getByRole('menuitem', { name: 'Adjust image' }).click();
  const chooser = page.waitForEvent('filechooser');
  await bar(page).getByRole('button', { name: 'Replace' }).click();
  await (await chooser).setFiles(await testImage(page));
  await expect(bar(page)).toContainText('Opacity 50%');
  await done(page);
  await waitForSavedImage(page, (img) => img.blobRef !== first && img.opacity === 0.5);
  await undoBtn(page).click();
  await waitForSavedImage(page, (img) => img.blobRef === first && img.opacity === 0.8);

  // Delete: gone, and undoable.
  await openFrameMenu(page);
  await page.getByRole('menuitem', { name: 'Adjust image' }).click();
  await bar(page).getByRole('button', { name: 'Delete' }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(refImage(page)).toHaveCount(0);
  await waitForSavedImage(page, (img) => img === null);
  await undoBtn(page).click();
  await expect(refImage(page)).toHaveCount(1);
  await waitForSavedImage(page, (img) => img?.blobRef === first);
});

test('tapping another control while adjusting commits, and that control still works', async ({ page }) => {
  await openApp(page);
  await addImage(page);
  await drag(page, { x: 800, y: 500 }, { x: 900, y: 500 });
  // Add frame: commits the image on frame 1, then adds frame 2.
  await addFrameBtn(page).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(2);
  await settled(page);
  await expect(refImage(page)).toHaveCount(0); // frame 2 has none
  const frames = await readDb(page, 'frames');
  const withImage = frames.filter((f) => f.image);
  expect(withImage).toHaveLength(1);
  expect(Math.abs(withImage[0].image.x - 1060)).toBeLessThan(3);
});

test('fill stops at the photo and the eyedropper picks it; Hide images takes it out of both and is remembered', async ({ page }) => {
  await openApp(page);
  await addImage(page);
  await done(page);

  // 50% red over white paper — within a step or two, since the image is
  // stored as JPEG (flat colors can shift slightly).
  expectNear(await pick(page, 480, 540), '#ff7f7f');

  await page.getByRole('button', { name: 'Fill', exact: true }).click();
  await tapCanvas(page, 480, 540);
  await expect.poll(() => activeLayerAlpha(page, 480, 540)).toBe(255);
  expect(await activeLayerAlpha(page, 1440, 540)).toBe(0); // the blue half
  expect(await activeLayerAlpha(page, 480, 30)).toBe(0);   // off the photo
  await undoBtn(page).click();
  await expect.poll(() => activeLayerAlpha(page, 480, 540)).toBe(0);

  await openFrameMenu(page);
  await page.getByRole('menuitem', { name: 'Hide images' }).click();
  await expect(refImage(page)).toBeHidden();
  expect(await pick(page, 480, 540)).toBe('#ffffff');
  await expect.poll(async () => (await readDb(page, 'projects'))[0].referenceHidden).toBe(true);

  await reloadApp(page);
  await expect(refImage(page)).toBeHidden();
  // Adjusting shows them again.
  await openFrameMenu(page);
  await page.getByRole('menuitem', { name: 'Adjust image' }).click();
  await expect(refImage(page)).toBeVisible();
  await done(page);
  await expect.poll(async () => (await readDb(page, 'projects'))[0].referenceHidden).toBe(false);
});

test('the gallery thumbnail shows the image; copy frame shares it; duplicate project copies it', async ({ page }) => {
  await openApp(page);
  await addImage(page);
  await done(page);

  // Copy frame: the new frame points at the same stored image.
  await openFrameMenu(page);
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(tiles(page)).toHaveCount(2);
  await settled(page);
  await expect(refImage(page)).toHaveCount(1);
  const frames = await readDb(page, 'frames');
  expect(frames).toHaveLength(2);
  expect(frames[0].image.blobRef).toBe(frames[1].image.blobRef);

  await page.getByRole('button', { name: 'Gallery' }).click();
  await page.locator('.pp-gallery').waitFor();
  const project = (await readDb(page, 'projects'))[0];
  const thumbRed = await page.evaluate(async (id) => {
    const rec = await new Promise((resolve, reject) => {
      const req = indexedDB.open('parapara');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const r = req.result.transaction('blobs').objectStore('blobs').get(`thumb-${id}`);
        r.onsuccess = () => { req.result.close(); resolve(r.result); };
      };
    });
    const bmp = await createImageBitmap(new Blob([rec.buffer], { type: rec.type }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const [r, g, b] = ctx.getImageData(c.width / 4, c.height / 2, 1, 1).data;
    return { r, g, b };
  }, project.id);
  expect(thumbRed.r).toBeGreaterThan(245);
  expect(thumbRed.g).toBeGreaterThan(100);
  expect(thumbRed.g).toBeLessThan(160);

  // Duplicate project: its own copy of the image, shared by both frames.
  await page.getByRole('button', { name: 'More for Animation 1', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect.poll(async () => (await readDb(page, 'projects')).length).toBe(2);
  const all = await readDb(page, 'frames');
  const copyFrames = all.filter((f) => f.projectId !== project.id);
  expect(copyFrames).toHaveLength(2);
  const copyRef = copyFrames[0].image.blobRef;
  expect(copyRef).not.toBe(frames[0].image.blobRef);
  expect(copyFrames[1].image.blobRef).toBe(copyRef);
  expect(await readDb(page, 'blobs', copyRef)).not.toBeNull();
});

test('in adjust mode a two-finger tap leaves the image alone and a double-tap still resets the view', async ({ page }) => {
  await openApp(page);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((p, id) => ({ id, x: p.x, y: p.y })),
  });
  const transform = () => page.locator('.pp-canvas').evaluate((c) => c.style.transform);

  // Zoom the view in first (normal two-finger pinch).
  const a = await screenPoint(page, 900, 540);
  const b = await screenPoint(page, 1020, 540);
  await touch('touchStart', [a]);
  await touch('touchStart', [a, b]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [{ x: a.x - i * 15, y: a.y }, { x: b.x + i * 15, y: b.y }]);
  }
  await touch('touchEnd', []);
  await expect.poll(transform).not.toContain('scale(1)');

  await addImage(page);
  const tap = async () => {
    await touch('touchStart', [a]);
    await touch('touchStart', [a, b]);
    await touch('touchEnd', []);
  };
  await tap();
  await tap();
  await expect.poll(transform).toContain('scale(1)');
  await done(page);
  await waitForSavedImage(page, (img) => img?.x === 960 && img.y === 540 && img.scale === 9.6);
});

// An image of `w`×`h` made in the page; `transparent` leaves a clear
// corner.
async function madeImage(page, w, h, transparent) {
  const base64 = await page.evaluate(([w, h, transparent]) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3a7';
    ctx.fillRect(0, 0, w, h);
    if (transparent) ctx.clearRect(0, 0, w / 4, h / 4);
    return c.toDataURL('image/png').split(',')[1];
  }, [w, h, transparent]);
  return { name: 'made.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

async function importFile(page, file) {
  await openFrameMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Add image|Adjust image/ }).click();
  if (await bar(page).count()) {
    // Already has one: Replace from the adjust bar.
    const replace = page.waitForEvent('filechooser');
    await bar(page).getByRole('button', { name: 'Replace' }).click();
    await (await replace).setFiles(file);
  } else {
    await (await chooser).setFiles(file);
  }
  await expect(bar(page)).toBeVisible();
  await settled(page);
  await done(page);
}

async function storedImage(page) {
  let image = null;
  await expect.poll(async () => {
    image = (await savedFrame(page))?.image ?? null;
    return image !== null;
  }).toBe(true);
  // Decoded in the page: the stored ArrayBuffer doesn't survive the
  // trip out to the test.
  const stored = await page.evaluate((ref) => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const r = req.result.transaction('blobs').objectStore('blobs').get(ref);
      r.onsuccess = async () => {
        req.result.close();
        const rec = r.result;
        const bmp = await createImageBitmap(new Blob([rec.buffer], { type: rec.type }));
        resolve({ type: rec.type, width: bmp.width, height: bmp.height });
      };
    };
  }), image.blobRef);
  return { ...stored, image };
}

test('a big photo is shrunk to the canvas size and saved as JPEG; only a transparent image stays PNG', async ({ page }) => {
  await openApp(page);
  await importFile(page, await madeImage(page, 4000, 3000, false));
  let stored = await storedImage(page);
  expect(stored).toMatchObject({ type: 'image/jpeg', width: 1920, height: 1440 });
  expect(stored.image.scale).toBe(0.75); // 1440 px tall fits 1080

  await page.getByRole('button', { name: 'Add frame' }).click();
  await settled(page);
  await importFile(page, await madeImage(page, 400, 300, true));
  stored = await storedImage(page);
  expect(stored).toMatchObject({ type: 'image/png', width: 400, height: 300 });
});
