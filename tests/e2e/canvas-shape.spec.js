// End-to-end tests for canvas shapes (after 8b-ii): New animation asks
// Landscape, Portrait or Square; the project keeps that size for life,
// and the menu highlights her last pick. Each test starts with an empty
// database. A portrait video's size is checked in export.spec.js.
//
// Not covered (device-only): a tall video playing upright in Photos
// and where she shares it; how a portrait canvas feels with the iPad
// held either way.
//
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';
import { reloadApp, readDb, newAnimation } from './helpers.js';

const newBtn = (page) => page.getByRole('button', { name: 'New animation' });
const shapeMenu = (page) => page.getByRole('menu', { name: 'Canvas shape' });
const shapeItem = (page, name) => shapeMenu(page).getByRole('menuitem', { name });
const galleryBtn = (page) => page.getByRole('button', { name: 'Gallery', exact: true });

// The drawing canvas's own size (its bitmap), not its size on screen.
const canvasPixels = (page) => page.locator('.pp-canvas canvas').first()
  .evaluate((c) => [c.width, c.height]);

async function savedCanvas(page) {
  const projects = await readDb(page, 'projects');
  return projects.map((p) => [p.name, p.canvas.width, p.canvas.height]);
}

test('New animation offers three shapes; landscape is highlighted at first, and a tap elsewhere closes it', async ({ page }) => {
  await page.goto('/index.html');
  await newBtn(page).click();
  await expect(shapeMenu(page).getByRole('menuitem')).toHaveText(['Landscape', 'Portrait', 'Square']);
  await expect(shapeItem(page, 'Landscape')).toHaveClass(/is-current/);
  await expect(shapeItem(page, 'Portrait')).not.toHaveClass(/is-current/);

  await page.locator('.pp-gallery__title').click();
  await expect(shapeMenu(page)).toHaveCount(0);
  // Tapping the tile again also closes it.
  await newBtn(page).click();
  await newBtn(page).click();
  await expect(shapeMenu(page)).toHaveCount(0);
  expect(await readDb(page, 'projects')).toEqual([]);
});

test('a portrait animation is 1080×1920 everywhere, and stays so after a relaunch', async ({ page }) => {
  await page.goto('/index.html');
  await newAnimation(page, 'Portrait');
  await page.locator('.pp-canvas').waitFor();

  expect(await canvasPixels(page)).toEqual([1080, 1920]);
  await expect.poll(() => savedCanvas(page)).toEqual([['Animation 1', 1080, 1920]]);
  // On screen it's taller than wide, and its frame tile is narrow.
  const box = await page.locator('.pp-canvas').boundingBox();
  expect(box.height).toBeGreaterThan(box.width * 1.7);
  await expect(page.locator('.pp-frame-strip__tile').first()).toHaveCSS('width', '36px');

  await reloadApp(page);
  expect(await canvasPixels(page)).toEqual([1080, 1920]);
});

test('square is 1080×1080; the menu remembers her last pick across a relaunch', async ({ page }) => {
  await page.goto('/index.html');
  await newAnimation(page, 'Square');
  await page.locator('.pp-canvas').waitFor();
  expect(await canvasPixels(page)).toEqual([1080, 1080]);

  await galleryBtn(page).click();
  await newBtn(page).click();
  await expect(shapeItem(page, 'Square')).toHaveClass(/is-current/);
  await shapeItem(page, 'Landscape').click();
  await page.locator('.pp-canvas').waitFor();
  expect(await canvasPixels(page)).toEqual([1920, 1080]);
  await expect.poll(async () => (await readDb(page, 'meta', 'uiState'))?.value?.newShape).toBe('landscape');

  await galleryBtn(page).click();
  await newBtn(page).click();
  await shapeItem(page, 'Portrait').click();
  await page.locator('.pp-canvas').waitFor();
  await expect.poll(async () => (await readDb(page, 'meta', 'uiState'))?.value?.newShape).toBe('portrait');

  await reloadApp(page);
  await galleryBtn(page).click();
  await newBtn(page).click();
  await expect(shapeItem(page, 'Portrait')).toHaveClass(/is-current/);
  expect((await savedCanvas(page)).sort()).toEqual([
    ['Animation 1', 1080, 1080],
    ['Animation 2', 1920, 1080],
    ['Animation 3', 1080, 1920],
  ]);
});
