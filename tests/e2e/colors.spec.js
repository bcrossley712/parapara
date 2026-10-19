// End-to-end tests for step 2e pass 2: the eyedropper, recent colors
// (app-wide) and the per-project palette in the color picker.
//
// Run: npm run test:e2e
//
// Not covered (device-only): how the long press feels with her stylus
// (and that iPadOS shows no callout/magnifier over it), and the
// eyedropper's live preview under a finger.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, readDb, waitForToolSettings } from './helpers.js';

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => {
    throw new Error(`Native dialog shown: ${d.type()} "${d.message()}"`);
  });
});

const swatch = (page) => page.locator('.pp-color-swatch');
const picker = (page) => page.locator('.pp-color-picker');
const recents = (page) => page.locator('.pp-color-picker__recent[data-color]');
const paletteSwatches = (page) => page.locator('.pp-color-picker__swatch[data-color]');
const addToPalette = (page) => page.getByRole('button', { name: 'Add color to palette' });
const eyedropperBtn = (page) => page.getByRole('button', { name: 'Eyedropper' });
const banner = (page) => page.locator('.pp-banner');
const colors = (loc) => loc.evaluateAll((els) => els.map((e) => e.dataset.color));

async function openPicker(page) {
  if (!(await picker(page).isVisible())) await swatch(page).click();
  await expect(picker(page)).toBeVisible();
}

async function closePicker(page) {
  await page.locator('.pp-tool-rail').click({ position: { x: 5, y: 400 } });
  await expect(picker(page)).toBeHidden();
}

async function setColor(page, hex) {
  await openPicker(page);
  const input = page.locator('.pp-color-picker__hex-input');
  await input.fill(hex);
  await input.press('Enter');
  await input.dispatchEvent('change');
}

const currentColor = (page) => page.locator('.pp-color-picker__hex-input').inputValue()
  .then((v) => `#${v.toLowerCase()}`);

// Canvas-pixel point -> screen point.
async function screenPoint(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

async function stroke(page, y) {
  const a = await screenPoint(page, 400, y);
  const b = await screenPoint(page, 1400, y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await page.mouse.up();
}

async function tapCanvas(page, x, y) {
  const p = await screenPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}

// The color in use right now (not the saved one, which lags by the
// settings debounce): the picker's hex field, which a pick updates.
async function pickedColor(page) {
  await expect(swatch(page)).not.toHaveClass(/is-picking/);
  await openPicker(page);
  return currentColor(page);
}

async function pickTool(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
}

// --- eyedropper ---

// Paint with Fill where the test needs an exact color: brush stamps
// overlap softly, so a stroke's pixels can be a step off its color
// (the eyedropper picks what's really there, as Procreate's does).
async function fillCanvas(page, hex) {
  await pickTool(page, 'Fill');
  await setColor(page, hex);
  await closePicker(page);
  await tapCanvas(page, 900, 500);
  await pickTool(page, 'Draw');
}

test('the eyedropper picks the color on the canvas, then the tool she had is back', async ({ page }) => {
  await openApp(page);
  await fillCanvas(page, 'e05a47');
  await setColor(page, '2255aa');

  await eyedropperBtn(page).click();
  await expect(picker(page)).toBeHidden();
  await expect(swatch(page)).toHaveClass(/is-picking/);
  await expect(banner(page)).toContainText('pick a color');

  await tapCanvas(page, 900, 500);
  await expect(swatch(page)).not.toHaveClass(/is-picking/);
  expect(await pickedColor(page)).toBe('#e05a47');
  await expect(page.getByRole('button', { name: 'Draw', exact: true })).toHaveClass(/is-active/);
  await waitForToolSettings(page, { color: '#e05a47', tool: 'draw' });
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled(); // the fill
  // The pick itself painted nothing: one undo empties the history.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();

  // Blank paper (the fill is undone) picks white.
  await openPicker(page);
  await eyedropperBtn(page).click();
  await tapCanvas(page, 900, 500);
  expect(await pickedColor(page)).toBe('#ffffff');
});

test('the eyedropper sees every visible layer, even from a locked one', async ({ page }) => {
  await openApp(page);
  await fillCanvas(page, '4fb3c9'); // Layer 1
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Add layer' }).click();
  await expect(page.locator('.pp-layers__row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Lock Layer 2' }).click();
  await setColor(page, '000000');

  await eyedropperBtn(page).click();
  await tapCanvas(page, 900, 500);
  expect(await pickedColor(page)).toBe('#4fb3c9');
});

test('picking a tool cancels the eyedropper; a tap after that draws', async ({ page }) => {
  await openApp(page);
  await openPicker(page);
  await eyedropperBtn(page).click();
  await expect(swatch(page)).toHaveClass(/is-picking/);
  await pickTool(page, 'Draw');
  await expect(swatch(page)).not.toHaveClass(/is-picking/);
  await stroke(page, 300);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
});

// --- recent colors ---

test('recents list what she drew or filled with, newest first, across projects and launches', async ({ page }) => {
  await openApp(page);
  await setColor(page, 'aa0000');
  await closePicker(page);
  await stroke(page, 300);
  await setColor(page, '00aa00');
  await closePicker(page);
  await stroke(page, 500);
  await setColor(page, '0000aa'); // picked but never drawn with
  await closePicker(page);
  await pickTool(page, 'Erase');
  await stroke(page, 500); // erasing doesn't count
  await pickTool(page, 'Fill');
  await setColor(page, 'aaaa00');
  await closePicker(page);
  await tapCanvas(page, 900, 900); // fill counts

  await openPicker(page);
  expect(await colors(recents(page))).toEqual(['#aaaa00', '#00aa00', '#aa0000']);

  // Tapping a recent uses it.
  await recents(page).nth(2).click();
  expect(await currentColor(page)).toBe('#aa0000');

  await expect.poll(async () => (await readDb(page, 'meta', 'recentColors'))?.value)
    .toEqual(['#aaaa00', '#00aa00', '#aa0000']);
  await reloadApp(page);
  await openPicker(page);
  expect(await colors(recents(page))).toEqual(['#aaaa00', '#00aa00', '#aa0000']);

  // App-wide: a different project shows the same recents.
  await closePicker(page);
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.getByRole('button', { name: 'New animation' }).click();
  await page.locator('.pp-canvas').waitFor();
  await openPicker(page);
  expect(await colors(recents(page))).toEqual(['#aaaa00', '#00aa00', '#aa0000']);
});

// --- palette ---

test('"+" adds the current color; duplicates and an 11th are refused with a banner', async ({ page }) => {
  await openApp(page);
  await setColor(page, '112233');
  await addToPalette(page).click();
  expect(await colors(paletteSwatches(page))).toEqual(['#112233']);

  await addToPalette(page).click();
  await expect(banner(page)).toContainText('already in your palette');
  await expect(paletteSwatches(page)).toHaveCount(1);

  for (let i = 1; i < 10; i++) {
    await setColor(page, `0000${String(i).padStart(2, '0')}`);
    await addToPalette(page).click();
    await expect(paletteSwatches(page)).toHaveCount(i + 1);
  }
  // Full: the "+" slot is gone.
  await expect(addToPalette(page)).toHaveCount(0);

  // Tapping a swatch uses its color.
  await paletteSwatches(page).first().click();
  expect(await currentColor(page)).toBe('#112233');
});

test('press and hold a swatch: Replace keeps its place, Remove takes it out', async ({ page }) => {
  await openApp(page);
  for (const hex of ['aa0000', '00aa00', '0000aa']) {
    await setColor(page, hex);
    await addToPalette(page).click();
  }
  await setColor(page, 'ffcc00');

  async function hold(n) {
    const box = await paletteSwatches(page).nth(n).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(page.getByRole('menuitem', { name: 'Replace' })).toBeVisible();
    await page.mouse.up();
  }

  await hold(1);
  // Lifting after the hold doesn't also count as a tap.
  expect(await currentColor(page)).toBe('#ffcc00');
  await page.getByRole('menuitem', { name: 'Replace' }).click();
  expect(await colors(paletteSwatches(page))).toEqual(['#aa0000', '#ffcc00', '#0000aa']);

  await hold(0);
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  expect(await colors(paletteSwatches(page))).toEqual(['#ffcc00', '#0000aa']);

  // A quick tap is still just a tap.
  await paletteSwatches(page).nth(1).click();
  expect(await currentColor(page)).toBe('#0000aa');
  await expect(page.getByRole('menuitem', { name: 'Replace' })).toHaveCount(0);
});

test('the palette belongs to the project: kept on reload, empty in a new one, copied by Duplicate', async ({ page }) => {
  await openApp(page);
  await setColor(page, 'abcdef');
  await addToPalette(page).click();
  await expect.poll(async () => (await readDb(page, 'projects'))[0]?.palette).toEqual(['#abcdef']);
  await reloadApp(page);
  await openPicker(page);
  expect(await colors(paletteSwatches(page))).toEqual(['#abcdef']);
  await closePicker(page);

  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.getByRole('button', { name: 'More for Animation 1' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await page.getByRole('button', { name: 'Open Animation 1 copy' }).click();
  await page.locator('.pp-canvas').waitFor();
  await openPicker(page);
  expect(await colors(paletteSwatches(page))).toEqual(['#abcdef']);
  await closePicker(page);

  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.getByRole('button', { name: 'New animation' }).click();
  await page.locator('.pp-canvas').waitFor();
  await openPicker(page);
  await expect(paletteSwatches(page)).toHaveCount(0);
});
