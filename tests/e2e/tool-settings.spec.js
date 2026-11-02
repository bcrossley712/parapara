// End-to-end tests for remembered tool settings: the real app in
// headless Chromium. Each test starts with an empty database.
//
// Run: npm run test:e2e

import { test, expect } from '@playwright/test';
import {
  openApp, reloadApp, setVisibility, waitForToolSettings, sizeSlider, setBrushSize, expectBrushSize,
} from './helpers.js';

const toolButton = (page, name) => page.getByRole('button', { name, exact: true });
const swatchColor = (page) => page.locator('.pp-color-swatch').evaluate((el) => el.style.background);

// Sets the size slider the way a finger drag would (helpers.js).
const setSize = setBrushSize;

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
  await expectBrushSize(page, 6);
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
  await expectBrushSize(page, 9);
  expect(await swatchColor(page)).toBe('rgb(255, 136, 0)');

  // Each tool kept its own size.
  await toolButton(page, 'Draw').click();
  await expectBrushSize(page, 20);
  await toolButton(page, 'Erase').click();
  await expectBrushSize(page, 45);
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
    const c = document.querySelector('.pp-layer--active');
    return Array.from(c.getContext('2d').getImageData(960, 540, 1, 1).data);
  });
  // ±2 per channel: overlapping anti-aliased stamp edges at sub-pixel
  // positions (the stabilizer's, since 8a) can round a channel by one,
  // and since 8b-i the stroke reaches the layer through the stroke
  // buffer, which now and then rounds once more (seen: 168 for 170).
  const expected = [0, 170, 85, 255];
  pixel.forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(2));
  expect(pixel[3]).toBe(255);
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
  await expectBrushSize(page, 6);   // 999 rejected
  await toolButton(page, 'Erase').click();
  await expectBrushSize(page, 12);  // valid one kept
});

// ---------------- stabilizer (8a) ----------------

const stabilizerSlider = (page) => page.locator('.pp-stabilizer input[type="range"]');

async function setStabilizer(page, value) {
  await stabilizerSlider(page).evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

// Page point for a canvas pixel (the view is at fit, unrotated).
async function canvasToPage(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

// Rows of the active layer with any ink, as [top, bottom] canvas px.
function inkRows(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.pp-layer--active');
    const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 0) {
          if (top < 0) top = y;
          bottom = y;
          break;
        }
      }
    }
    return [top, bottom];
  });
}

function alphaAt(page, x, y) {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector('.pp-layer--active');
    return c.getContext('2d').getImageData(px, py, 1, 1).data[3];
  }, [x, y]);
}

// A left-to-right zigzag, ±40 canvas px around y = 540, ending at
// (1500, 540), sent through CDP with stylus-like timestamps 8 ms apart.
// The stabilizer is time-based, so with Playwright's own moves a busy
// machine spaces the samples out and the line catches up between them
// (a flaky test, not a bug). The timestamps start 30 s in the future:
// the page's animation-frame ticks run on real time, always earlier
// than these, so they move nothing — the result depends only on the
// samples' spacing.
async function drawZigzag(page) {
  const cdp = await page.context().newCDPSession(page);
  const t0 = Date.now() / 1000 + 30;
  const send = (type, p, i) => cdp.send('Input.dispatchMouseEvent', {
    type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1, timestamp: t0 + i * 0.008,
  });
  const points = [];
  for (let i = 0; i <= 22; i++) {
    const y = i === 0 || i === 22 ? 540 : 540 + (i % 2 ? 40 : -40);
    points.push(await canvasToPage(page, 400 + i * 50, y));
  }
  await send('mousePressed', points[0], 0);
  for (let i = 1; i < points.length; i++) await send('mouseMoved', points[i], i);
  await send('mouseReleased', points[points.length - 1], points.length);
  await cdp.detach();
  // The stroke commits on lift, synchronously.
}

test('stabilizer: midway by default, per tool, off for fill and smudge, remembered', async ({ page }) => {
  await openApp(page);
  await expect(stabilizerSlider(page)).toHaveValue('5');

  await setStabilizer(page, 8);                // draw
  await toolButton(page, 'Erase').click();
  await expect(stabilizerSlider(page)).toHaveValue('5');
  await setStabilizer(page, 2);                // erase
  await toolButton(page, 'Fill').click();
  await expect(stabilizerSlider(page)).toBeDisabled();
  await toolButton(page, 'Smudge').click();
  await expect(stabilizerSlider(page)).toBeDisabled();

  await waitForToolSettings(page, { tool: 'smudge', stabilizer: { draw: 8, erase: 2 } });
  await reloadApp(page);

  await expect(stabilizerSlider(page)).toBeDisabled();
  await toolButton(page, 'Draw').click();
  await expect(stabilizerSlider(page)).toBeEnabled();
  await expect(stabilizerSlider(page)).toHaveValue('8');
  await toolButton(page, 'Erase').click();
  await expect(stabilizerSlider(page)).toHaveValue('2');
});

test('stabilizer: a wobbly line comes out flatter, and still ends where the stylus lifted', async ({ page }) => {
  await openApp(page);
  const size = 4;
  await setSize(page, size);

  await setStabilizer(page, 0);
  await drawZigzag(page);
  const [top0, bottom0] = await inkRows(page);
  const wobbleOff = bottom0 - top0;
  // Off: the zigzag's peaks are there (±40 less midpoint rounding).
  expect(wobbleOff).toBeGreaterThan(50);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => inkRows(page)).toEqual([-1, -1]);

  await setStabilizer(page, 10);
  await drawZigzag(page);
  const [top10, bottom10] = await inkRows(page);
  expect(bottom10 - top10).toBeLessThan(wobbleOff / 2);
  // The line reaches the lift point despite trailing behind.
  expect(await alphaAt(page, 1500, 540)).toBeGreaterThan(0);
});
