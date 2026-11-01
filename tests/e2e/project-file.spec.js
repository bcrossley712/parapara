// End-to-end tests for step 7a: a whole project as one file — Save as
// file from a gallery card's ⋯ menu (Share is a download in this
// browser), and Import in the gallery's top bar making a new card from
// it. The packing itself is unit-tested (tests/unit/project-file.test.js).
//
// Run: npx playwright test project-file
//
// Not covered (device-only): the iOS share sheet offering Save to
// Files / AirDrop for a .parapara file, what the iOS file picker shows
// with no `accept`, and memory while packing a big project.

import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openApp } from './helpers.js';

const cards = (page) => page.locator('.pp-gallery-card');
const card = (page, name) => cards(page).filter({ has: page.locator('.pp-gallery-card__name', { hasText: name }) });
const dialog = (page) => page.locator('.pp-dialog');
const tiles = (page) => page.locator('.pp-frame-strip__tile');

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => {
    throw new Error(`Native dialog shown: ${d.type()} "${d.message()}"`);
  });
});

async function drawStroke(page) {
  const box = await page.locator('.pp-canvas').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy, { steps: 12 });
  await page.mouse.up();
}

function paintedPixels(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.pp-layer--active');
    if (!c) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
}

async function toGallery(page) {
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.locator('.pp-gallery').waitFor();
}

async function saveAsFile(page, name) {
  await card(page, name).getByRole('button', { name: `More for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Save as file' }).click();
  await expect(dialog(page)).toContainText('Your file is ready');
  const downloading = page.waitForEvent('download');
  await dialog(page).getByRole('button', { name: 'Share' }).click();
  const download = await downloading;
  await expect(dialog(page)).toHaveCount(0);
  return { name: download.suggestedFilename(), path: await download.path() };
}

async function importFile(page, filePath) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await (await chooser).setFiles(filePath);
}

test('Save as file, then Import, makes a second card that opens with the drawing and frames', async ({ page }) => {
  await openApp(page);
  await drawStroke(page);
  await page.getByRole('button', { name: 'Add frame' }).click();
  await expect(tiles(page)).toHaveCount(2);
  await tiles(page).first().click();
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(100);
  const drawn = await paintedPixels(page);
  await toGallery(page);

  const saved = await saveAsFile(page, 'Animation 1');
  expect(saved.name).toBe('Animation 1.parapara');
  const bytes = await readFile(saved.path);
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]); // a zip

  await importFile(page, saved.path);
  await expect(cards(page)).toHaveCount(2);
  // Same name, as Procreate imports; the new one is first.
  await expect(cards(page).first().locator('.pp-gallery-card__name')).toHaveText('Animation 1');
  await expect(cards(page).first().locator('.pp-gallery-card__meta')).toHaveText('2 frames');
  const ids = await cards(page).evaluateAll((els) => els.map((el) => el.dataset.projectId));
  expect(ids[0]).not.toBe(ids[1]);

  await cards(page).first().locator('.pp-gallery-card__thumb').click();
  await expect(tiles(page)).toHaveCount(2);
  await expect.poll(() => paintedPixels(page)).toBe(drawn);
});

test('importing a file that isn’t a Parapara! file says so and adds nothing', async ({ page }) => {
  await openApp(page);
  await toGallery(page);
  const dir = await mkdtemp(path.join(tmpdir(), 'pp-import-'));
  const notProject = path.join(dir, 'notes.txt');
  await writeFile(notProject, 'just some text');
  await importFile(page, notProject);
  await expect(page.locator('.pp-toast--notice .pp-toast__text')).toHaveText("This isn't a Parapara! file.");
  await expect(cards(page)).toHaveCount(1);
});

test('the ⋯ menu offers Save as file before Delete', async ({ page }) => {
  await openApp(page);
  await toGallery(page);
  await card(page, 'Animation 1').getByRole('button', { name: 'More for Animation 1' }).click();
  await expect(page.locator('.pp-gallery-menu').getByRole('menuitem'))
    .toHaveText(['Rename', 'Duplicate', 'Save as file', 'Delete']);
});
