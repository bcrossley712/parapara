// End-to-end tests for remembered tool settings: the real app in
// headless Chromium. Each test starts with an empty database.
//
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, setVisibility, waitForToolSettings } from './helpers.js';

const toolButton = (page, name) => page.getByRole('button', { name, exact: true });
const sizeSlider = (page) => page.locator('.pp-brush-size input[type="range"]');
const swatchColor = (page) => page.locator('.pp-color-swatch').evaluate((el) => el.style.background);

// Sets the range input the way a finger drag would: value + input event.
async function setSize(page, value) {
  await sizeSlider(page).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function setColorViaHex(page, hex) {
  await page.locator('.pp-color-swatch').click();
  const input = page.locator('.pp-color-picker__hex-input');
  await input.fill(hex);
  await input.press('Enter');
  await input.dispatchEvent('change');
  // Close the picker by tapping elsewhere (like she would).
  await page.locator('.pp-tool-rail').click({ position: { x: 5, y: 400 } });
}

test('first launch uses the defaults', async ({ page }) => {
  await openApp(page);
  await expect(toolButton(page, 'Draw')).toHaveClass(/is-active/);
  await expect(sizeSlider(page)).toHaveValue('6');
});

test('tool, color and per-tool sizes survive a reload', async ({ page }) => {
  await openApp(page);

  await setSize(page, 20);                 // draw size
  await toolButton(page, 'Erase').click();
  await setSize(page, 45);                 // erase size
  await setColorViaHex(page, 'ff8800');
  await toolButton(page, 'Smudge').click(); // last tool picked
  await setSize(page, 9);                  // smudge size

  await waitForToolSettings(page, {
    tool: 'smudge',
    color: '#ff8800',
    brushSizes: { draw: 20, erase: 45, smudge: 9 },
  });
  await reloadApp(page);

  await expect(toolButton(page, 'Smudge')).toHaveClass(/is-active/);
  await expect(sizeSlider(page)).toHaveValue('9');
  expect(await swatchColor(page)).toBe('rgb(255, 136, 0)');

  // Each tool kept its own size.
  await toolButton(page, 'Draw').click();
  await expect(sizeSlider(page)).toHaveValue('20');
  await toolButton(page, 'Erase').click();
  await expect(sizeSlider(page)).toHaveValue('45');
});

test('Fill as the last tool reopens with the size slider disabled', async ({ page }) => {
  await openApp(page);
  await toolButton(page, 'Fill').click();
  await waitForToolSettings(page, { tool: 'fill' });
  await reloadApp(page);

  await expect(toolButton(page, 'Fill')).toHaveClass(/is-active/);
  await expect(sizeSlider(page)).toBeDisabled();
});

test('the remembered color is what actually gets drawn', async ({ page }) => {
  await openApp(page);
  await setColorViaHex(page, '00aa55');
  await waitForToolSettings(page, { color: '#00aa55' });
  await reloadApp(page);

  const box = await page.locator('.pp-canvas').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 40, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 10 });
  await page.mouse.up();

  const pixel = await page.evaluate(() => {
    const c = document.querySelector('.pp-canvas');
    return Array.from(c.getContext('2d').getImageData(960, 540, 1, 1).data);
  });
  expect(pixel).toEqual([0, 170, 85, 255]);
});

test('hiding the app saves settings immediately', async ({ page }) => {
  await openApp(page);
  await toolButton(page, 'Erase').click();
  await setVisibility(page, 'hidden');
  // Must land well inside the 300 ms debounce, or it was the debounce
  // that saved it, not the hide.
  await waitForToolSettings(page, { tool: 'erase' }, { timeout: 200 });
  await reloadApp(page);
  await expect(toolButton(page, 'Erase')).toHaveClass(/is-active/);
});

test('corrupted saved settings fall back to defaults instead of breaking startup', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({
        key: 'toolSettings',
        value: { tool: 'lasso', color: 'blue', brushSizes: { draw: 999, erase: 12 } },
      });
      tx.oncomplete = () => { req.result.close(); resolve(); };
    };
  }));
  await reloadApp(page);

  await expect(toolButton(page, 'Draw')).toHaveClass(/is-active/);
  await expect(sizeSlider(page)).toHaveValue('6');   // 999 rejected
  await toolButton(page, 'Erase').click();
  await expect(sizeSlider(page)).toHaveValue('12');  // valid one kept
});
