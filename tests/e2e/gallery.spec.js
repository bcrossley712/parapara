// End-to-end tests for step 2d: the project gallery — create, open,
// rename, delete (with the custom confirm), thumbnails of frame 1,
// switching screens, and relaunching where she left off.
//
// Run: npm run test:e2e
//
// Not covered (device-only): how the switch between gallery and editor
// feels on the iPad, gallery scrolling by touch, and thumbnail time on
// a large frame.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, readDb, setVisibility, waitForToolSettings } from './helpers.js';

const galleryBtn = (page) => page.getByRole('button', { name: 'Gallery', exact: true });
const newBtn = (page) => page.getByRole('button', { name: 'New animation' });
const cards = (page) => page.locator('.pp-gallery-card');
const card = (page, name) => cards(page).filter({ has: page.locator('.pp-gallery-card__name', { hasText: name }) });
const dialog = (page) => page.locator('.pp-dialog');

// Every test: the app must never fall back to a native dialog.
test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => {
    throw new Error(`Native dialog shown: ${d.type()} "${d.message()}"`);
  });
});

async function drawStroke(page, dy = 0) {
  const box = await page.locator('.pp-canvas').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2 + dy;
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 12 });
  await page.mouse.up();
}

// Painted pixels on the active layer (whole canvas).
function paintedPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.pp-layer--active');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
}

// Dark pixels in a card's thumbnail image (0 if it has none yet).
function thumbnailInk(page, name) {
  return card(page, name).locator('.pp-gallery-card__thumb img').evaluate(async (img) => {
    if (!img.getAttribute('src')) return 0;
    await img.decode().catch(() => {});
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n++;
    return n;
  });
}

async function toGallery(page) {
  await galleryBtn(page).click();
  await page.locator('.pp-gallery').waitFor();
}

test('a fresh install opens on an empty gallery, and New animation opens the editor', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('.pp-gallery')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.locator('.pp-gallery__hint')).toBeVisible();

  await newBtn(page).click();
  await expect(page.locator('.pp-canvas')).toBeVisible();
  await expect(page.locator('.pp-gallery')).toHaveCount(0);

  const projects = await readDb(page, 'projects');
  expect(projects.map((p) => p.name)).toEqual(['Animation 1']);
});

test('Gallery goes back to the gallery, with a thumbnail of the drawing', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  await toGallery(page);

  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, 'Animation 1').locator('.pp-gallery-card__meta')).toHaveText('1 frame');
  await expect.poll(() => thumbnailInk(page, 'Animation 1')).toBeGreaterThan(50);
  // The editor is gone, canvas and all.
  await expect(page.locator('.pp-canvas')).toHaveCount(0);
  await expect(page.locator('.pp-layer')).toHaveCount(0);
});

test('the thumbnail is frame 1, even after drawing on another frame', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Add frame' }).click();
  await expect(page.getByRole('button', { name: 'Frame 2' })).toHaveAttribute('aria-current', 'true');
  await drawStroke(page);
  await toGallery(page);
  await expect(card(page, 'Animation 1').locator('.pp-gallery-card__meta')).toHaveText('2 frames');
  // Frame 1 is blank, so no ink — the stroke was on frame 2.
  await expect.poll(async () => {
    const src = await card(page, 'Animation 1').locator('img').getAttribute('src');
    return src ? thumbnailInk(page, 'Animation 1') : -1;
  }).toBe(0);
});

test('a new animation gets the next number and opens blank; tool settings carry over', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await waitForToolSettings(page, { tool: 'erase' });
  await toGallery(page);

  await newBtn(page).click();
  await page.locator('.pp-canvas').waitFor();
  expect(await paintedPixels(page)).toBe(0);
  await expect(page.getByRole('button', { name: 'Erase', exact: true })).toHaveClass(/is-active/);
  // Undo history belongs to the project that was open.
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();

  await toGallery(page);
  const names = await page.locator('.pp-gallery-card__name').allTextContents();
  expect(names).toEqual(['Animation 2', 'Animation 1']); // newest first
});

test('opening a card shows its drawing; undo history starts fresh', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  await toGallery(page);
  await newBtn(page).click();
  await page.locator('.pp-canvas').waitFor();
  await toGallery(page);

  await card(page, 'Animation 1').locator('.pp-gallery-card__thumb').click();
  await page.locator('.pp-canvas').waitFor();
  expect(await paintedPixels(page)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
});

test('relaunch reopens where she left off: the editor on the last project, or the gallery', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  await toGallery(page);
  await newBtn(page).click();
  await page.locator('.pp-canvas').waitFor();

  // Left in the editor on the blank Animation 2.
  await reloadApp(page);
  expect(await paintedPixels(page)).toBe(0);

  await toGallery(page);
  await expect.poll(async () => (await readDb(page, 'meta', 'uiState'))?.value?.screen).toBe('gallery');
  await page.reload();
  await expect(page.locator('.pp-gallery')).toBeVisible();
  await expect(cards(page)).toHaveCount(2);

  // And back into Animation 1, which is then where a relaunch goes.
  await card(page, 'Animation 1').locator('.pp-gallery-card__thumb').click();
  await page.locator('.pp-canvas').waitFor();
  await expect.poll(async () => (await readDb(page, 'meta', 'uiState'))?.value?.screen).toBe('editor');
  await reloadApp(page);
  expect(await paintedPixels(page)).toBeGreaterThan(0);
});

test('tapping a name renames it in a custom dialog; Cancel changes nothing', async ({ page }) => {
  await openApp(page);
  await toGallery(page);

  await page.getByRole('button', { name: 'Rename Animation 1' }).click();
  await expect(dialog(page)).toBeVisible();
  await page.locator('.pp-dialog__input').fill('Walk cycle');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(card(page, 'Animation 1')).toHaveCount(1);

  await page.getByRole('button', { name: 'Rename Animation 1' }).click();
  // A blank name can't be saved.
  await page.locator('.pp-dialog__input').fill('   ');
  await expect(dialog(page).getByRole('button', { name: 'Rename' })).toBeDisabled();
  await page.locator('.pp-dialog__input').fill('  Walk cycle ');
  await page.locator('.pp-dialog__input').press('Enter');
  await expect(card(page, 'Walk cycle')).toHaveCount(1);

  await page.reload();
  await expect(card(page, 'Walk cycle')).toHaveCount(1);
});

test('Rename from the ⋯ menu works too', async ({ page }) => {
  await openApp(page);
  await toGallery(page);
  await page.getByRole('button', { name: 'More for Animation 1' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.locator('.pp-dialog__input').fill('Bouncing ball');
  await dialog(page).getByRole('button', { name: 'Rename' }).click();
  await expect(card(page, 'Bouncing ball')).toHaveCount(1);
});

test('Delete asks first; Cancel keeps it, Delete removes it and all its data', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  await toGallery(page);
  await newBtn(page).click();
  await page.locator('.pp-canvas').waitFor();
  await toGallery(page);
  const [keep, gone] = ['Animation 2', 'Animation 1'];
  const goneId = await card(page, gone).getAttribute('data-project-id');

  await page.getByRole('button', { name: `More for ${gone}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(dialog(page)).toContainText(gone);
  await expect(dialog(page)).toContainText("can't be undone");
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(cards(page)).toHaveCount(2);

  // Tapping outside the dialog cancels as well.
  await page.getByRole('button', { name: `More for ${gone}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.mouse.click(5, 300);
  await expect(dialog(page)).toHaveCount(0);
  await expect(cards(page)).toHaveCount(2);

  await page.getByRole('button', { name: `More for ${gone}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await dialog(page).getByRole('button', { name: 'Delete' }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, keep)).toHaveCount(1);

  const projects = await readDb(page, 'projects');
  expect(projects.map((p) => p.name)).toEqual([keep]);
  const frames = await readDb(page, 'frames');
  expect(frames.some((f) => f.projectId === goneId)).toBe(false);
  const blobs = await readDb(page, 'blobs');
  expect(blobs.some((b) => b.projectId === goneId)).toBe(false);

  await page.reload();
  await expect(cards(page)).toHaveCount(1);
});

test('deleting the last animation leaves the empty gallery', async ({ page }) => {
  await openApp(page);
  await toGallery(page);
  await page.getByRole('button', { name: 'More for Animation 1' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await dialog(page).getByRole('button', { name: 'Delete' }).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.locator('.pp-gallery__hint')).toBeVisible();
  await page.reload();
  await expect(page.locator('.pp-gallery')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
});

test('a project without a thumbnail gets one drawn in the gallery', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  await toGallery(page);
  await expect.poll(() => thumbnailInk(page, 'Animation 1')).toBeGreaterThan(50);

  // Remove the stored thumbnail, as for a project from before 2d.
  const id = await card(page, 'Animation 1').getAttribute('data-project-id');
  await page.evaluate((projectId) => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onsuccess = () => {
      const tx = req.result.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete(`thumb-${projectId}`);
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), id);

  await page.reload();
  await expect.poll(() => thumbnailInk(page, 'Animation 1')).toBeGreaterThan(50);
  await expect.poll(async () => Boolean(await readDb(page, 'blobs', `thumb-${id}`))).toBe(true);
});

test('hiding the app updates the thumbnail', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  const id = (await readDb(page, 'projects'))[0].id;
  await setVisibility(page, 'hidden');
  await expect.poll(async () => Boolean(await readDb(page, 'blobs', `thumb-${id}`))).toBe(true);
});

test('the gallery has the gear menu, without the editor-only actions', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('.pp-gallery').waitFor();
  await page.getByRole('button', { name: 'Settings' }).click();
  const panel = page.getByRole('dialog', { name: 'Settings' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Check for updates' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Fill all layers' })).toHaveCount(0);
  await page.locator('.pp-gallery').click({ position: { x: 20, y: 400 } });
  await expect(panel).toBeHidden();
});

// iPadOS 26 blurs the top of a home-screen app whenever nothing fixed
// and solid sits at the top edge — even for a moment — and keeps the
// blur until relaunch. The blur itself only shows on the device; this
// guards the two things that prevent it.
test('screens sit in one fixed dark #app that switching never empties or replaces', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);

  const app = page.locator('#app');
  await expect(app).toHaveCSS('position', 'fixed');
  await expect(app).toHaveCSS('background-color', 'rgb(58, 50, 38)');
  // #app is the only fixed box at the top edge — a screen's own shell
  // isn't, so switching screens never replaces it.
  await expect(page.locator('.pp-app-shell')).toHaveCSS('position', 'absolute');

  await page.evaluate(() => {
    const root = document.getElementById('app');
    window.__appWasEmpty = false;
    new MutationObserver(() => {
      if (root.childElementCount === 0) window.__appWasEmpty = true;
    }).observe(root, { childList: true });
  });
  await galleryBtn(page).click();
  await page.locator('.pp-gallery').waitFor();
  expect(await page.evaluate(() => window.__appWasEmpty)).toBe(false);
  await expect(page.locator('.pp-app-shell')).toHaveCSS('position', 'absolute');
});
