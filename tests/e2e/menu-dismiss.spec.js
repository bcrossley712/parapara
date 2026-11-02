// End-to-end tests: a tap on the canvas while a menu or popover is open
// only closes it — nothing is drawn (Procreate's way). The layers panel
// counts too (a menu since 5c). The sound panel, which she works with
// open, doesn't: a tap draws as usual.
//
// Not covered here (device-only): how it feels with her stylus.

import { test, expect } from '@playwright/test';
import { openApp, openLayerMenu } from './helpers.js';

// Painted pixels across the layer canvases.
const ink = (page) => page.evaluate(() => {
  let n = 0;
  for (const canvas of document.querySelectorAll('.pp-layer')) {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n += 1;
  }
  return n;
});

// A tap on an empty part of the canvas (left of center, clear of the
// layers panel and the top-right menus).
async function tapCanvas(page) {
  const box = await page.locator('.pp-canvas-area').boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.45);
}

const menus = [
  {
    name: 'the color picker',
    open: (page) => page.locator('.pp-color-swatch').click(),
    shown: (page) => page.locator('.pp-color-picker:not(.pp-color-picker--hidden)'),
  },
  {
    name: 'the Image menu',
    open: (page) => page.locator('.pp-image-btn').click(),
    shown: (page) => page.locator('.pp-image-menu'),
  },
  {
    name: 'the Symmetry menu',
    open: (page) => page.locator('.pp-symmetry-btn').click(),
    shown: (page) => page.locator('.pp-symmetry-menu'),
  },
  {
    name: 'the frame menu',
    open: (page) => page.locator('.pp-frame-strip__tile.is-current').click(),
    shown: (page) => page.locator('.pp-frame-menu'),
  },
  {
    name: 'the layers panel',
    open: (page) => page.getByRole('button', { name: 'Layers', exact: true }).click(),
    shown: (page) => page.locator('.pp-layers:not(.pp-layers--hidden)'),
  },
  {
    name: 'the layer menu',
    open: (page) => openLayerMenu(page),
    shown: (page) => page.locator('.pp-layer-menu'),
  },
  {
    name: 'onion skin settings',
    open: (page) => page.getByRole('button', { name: 'Onion skin settings' }).click(),
    shown: (page) => page.locator('.pp-onion-panel'),
  },
  {
    name: 'the fps panel',
    open: (page) => page.locator('.pp-transport').getByRole('button', { name: 'Frames per second' }).click(),
    shown: (page) => page.locator('.pp-fps-panel'),
  },
  {
    name: 'the gear menu',
    open: (page) => page.getByRole('button', { name: 'Settings', exact: true }).click(),
    shown: (page) => page.locator('.pp-settings:not(.pp-settings--hidden)'),
  },
];

for (const menu of menus) {
  test(`a canvas tap with ${menu.name} open only closes it`, async ({ page }) => {
    await openApp(page);
    await menu.open(page);
    await expect(menu.shown(page)).toBeVisible();

    await tapCanvas(page);
    await expect(menu.shown(page)).toHaveCount(0);
    expect(await ink(page)).toBe(0);

    // With it closed, the next tap draws.
    await tapCanvas(page);
    await expect.poll(() => ink(page)).toBeGreaterThan(0);
  });
}

test('the sound panel doesn\'t count: a tap draws with it open', async ({ page }) => {
  await openApp(page);
  await page.locator('.pp-sound-btn').click();
  await expect(page.locator('.pp-sound-panel')).toBeVisible();
  await tapCanvas(page);
  await expect.poll(() => ink(page)).toBeGreaterThan(0);
  await expect(page.locator('.pp-sound-panel')).toBeVisible();
});

test('the layer menu and the layers panel close together on one canvas tap', async ({ page }) => {
  await openApp(page);
  await openLayerMenu(page);
  await tapCanvas(page);
  await expect(page.locator('.pp-layer-menu')).toHaveCount(0);
  await expect(page.locator('.pp-layers')).toBeHidden();
  expect(await ink(page)).toBe(0);
});

test('a canvas tap mid-rename closes the panel and keeps the typed name', async ({ page }) => {
  await openApp(page);
  await openLayerMenu(page);
  await page.locator('.pp-layer-menu').getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Layer name' }).fill('Sky');
  await tapCanvas(page);
  await expect(page.locator('.pp-layers')).toBeHidden();
  expect(await ink(page)).toBe(0);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.locator('.pp-layers__name')).toHaveText(['Sky']);
});

test('picking a layer keeps the panel open', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Add layer' }).click();
  await expect(page.locator('.pp-layers__row')).toHaveCount(2);
  const other = page.locator('.pp-layers__row:not(.is-active) .pp-layers__name');
  await other.click();
  await expect(page.locator('.pp-layers__row.is-active .pp-layers__name')).toHaveText('Layer 1');
  await expect(page.locator('.pp-layers')).toBeVisible();
});

test('a tap on another control closes the layers panel and still acts', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.locator('.pp-layers')).toBeVisible();
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(page.locator('.pp-layers')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Erase', exact: true })).toHaveClass(/is-active/);
});

test('the layers panel stays open while she moves between frames (the strip row)', async ({ page }) => {
  await openApp(page);
  const panel = page.locator('.pp-layers');
  const addFrame = page.getByRole('button', { name: 'Add frame' });
  const tile = (n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(panel).toBeVisible();

  await expect(addFrame).toBeEnabled();
  await addFrame.click();
  await expect(tile(2)).toHaveClass(/is-current/);
  await expect(panel).toBeVisible();

  await expect(addFrame).toBeEnabled();
  await tile(1).click();
  await expect(tile(1)).toHaveClass(/is-current/);
  await expect(panel).toBeVisible();

  await expect(addFrame).toBeEnabled();
  await page.getByRole('button', { name: 'Next frame' }).click();
  await expect(tile(2)).toHaveClass(/is-current/);
  await expect(panel).toBeVisible();

  // Anywhere else still closes it.
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(panel).toBeHidden();
});

// A long press on iOS selects the nearest text and offers Copy: nothing
// in the app is selectable (after 8b-i), except text boxes. Only the CSS
// can be checked here — iOS's own long press is device-only.
test('nothing is selectable except text boxes', async ({ page }) => {
  await openApp(page);
  const select = (locator) => locator.evaluate((el) => getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect);
  for (const sel of ['.pp-canvas-area', '.pp-tool-rail', '.pp-tool-btn', '.pp-brush-size', '.pp-top-bar']) {
    expect(await select(page.locator(sel).first()), sel).toBe('none');
  }
  await page.locator('.pp-color-swatch').click();
  const hex = page.locator('.pp-color-picker__hex-input');
  expect(await select(hex)).toBe('text');
  // And typing still works.
  await hex.fill('123456');
  await expect(hex).toHaveValue('123456');
});
