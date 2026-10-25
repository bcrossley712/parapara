// End-to-end tests: a tap on the canvas while a menu or popover is open
// only closes it — nothing is drawn (Procreate's way). Panels she works
// with open (layers, sound) don't count: a tap draws as usual.
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
    name: 'the frame menu',
    open: (page) => page.locator('.pp-frame-strip__tile.is-current').click(),
    shown: (page) => page.locator('.pp-frame-menu'),
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

test('panels she works with open don\'t count: a tap draws with layers and sound open', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.locator('.pp-layers')).toBeVisible();
  await page.locator('.pp-sound-btn').click();
  await expect(page.locator('.pp-sound-panel')).toBeVisible();
  await tapCanvas(page);
  await expect.poll(() => ink(page)).toBeGreaterThan(0);
  await expect(page.locator('.pp-layers')).toBeVisible();
  await expect(page.locator('.pp-sound-panel')).toBeVisible();
});
