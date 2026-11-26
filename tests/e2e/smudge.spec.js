// End-to-end tests for smudge (8e): its panel (Size and Strength,
// remembered), a soft drag that carries color and blends, a tap that
// does nothing, and one undo step per smudge. The blending math itself
// is in tests/unit/smudge.test.js. Mirroring is in symmetry.spec.js.
//
// Not covered here (device-only): whether it feels like blending to
// her, and whether a big smudge keeps up on her iPad (each dab reads
// and writes the layer).

import { test, expect } from '@playwright/test';
import {
  openApp, reloadApp, waitForToolSettings, setBrushSize, expectBrushSize,
  brushPanel, openBrushPanel, closeBrushPanel, setPanelSlider,
} from './helpers.js';

const toolButton = (page, name) => page.getByRole('button', { name, exact: true });
const undoBtn = (page) => page.getByRole('button', { name: 'Undo', exact: true });

async function canvasToPage(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

async function drag(page, x1, y1, x2, y2, steps = 24) {
  const a = await canvasToPage(page, x1, y1);
  const b = await canvasToPage(page, x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }
  await page.mouse.up();
}

async function setColor(page, hex) {
  const picker = page.locator('.pp-color-picker');
  if (!(await picker.isVisible())) await page.locator('.pp-color-swatch').click();
  const input = page.locator('.pp-color-picker__hex-input');
  await input.fill(hex);
  await input.press('Enter');
  await input.dispatchEvent('change');
  await page.locator('.pp-tool-rail').click({ position: { x: 5, y: 400 } });
  await expect(picker).toBeHidden();
}

// A fingerprint of the active layer's whole picture (every pixel
// counts; a plain array of 8 million numbers is too big to pass back).
const layerData = (page) => page.evaluate(() => {
  const c = document.querySelector('.pp-layer--active');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < d.length; i++) {
    h1 = Math.imul(h1 ^ d[i], 16777619);
    h2 = (h2 + d[i] * ((i % 251) + 1)) % 2147483647;
  }
  return `${h1 >>> 0}:${h2}`;
});

// RGBA of one canvas pixel.
const pixelAt = (page, x, y) => page.evaluate(([px, py]) => {
  const c = document.querySelector('.pp-layer--active');
  return Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data);
}, [x, y]);

// Pixels along a row from x1 to x2: their alphas.
const rowAlphas = (page, y, x1, x2) => page.evaluate(([py, a, b]) => {
  const c = document.querySelector('.pp-layer--active');
  const d = c.getContext('2d').getImageData(a, py, b - a, 1).data;
  const out = [];
  for (let i = 3; i < d.length; i += 4) out.push(d[i]);
  return out;
}, [y, x1, x2]);

// A thick vertical bar of the current color.
async function bar(page, x) {
  await setBrushSize(page, 60);
  await drag(page, x, 300, x, 780);
  await expect(undoBtn(page)).toBeEnabled();
}

test('tapping the current Smudge opens its panel: Size and Strength only, remembered', async ({ page }) => {
  await openApp(page);
  await toolButton(page, 'Smudge').click();
  await expect(brushPanel(page)).toHaveCount(0); // the first tap only picks it
  await openBrushPanel(page, 'Smudge');
  await expect(brushPanel(page)).toContainText('Smudge');
  await expect(brushPanel(page).locator('.pp-brush-panel__tips')).toBeHidden();
  await expect(brushPanel(page).locator('.pp-brush-panel__stabilizer')).toBeHidden();
  await expect(brushPanel(page)).toContainText('Strength 50%');

  await setPanelSlider(page, 'strength', 80);
  await expect(brushPanel(page)).toContainText('Strength 80%');
  await closeBrushPanel(page, 'Smudge');
  await setBrushSize(page, 70);
  await waitForToolSettings(page, { tool: 'smudge', smudgeStrength: 80, brushSizes: { smudge: 70 } });

  // Draw's panel still has its tips and stabilizer.
  await toolButton(page, 'Draw').click();
  await openBrushPanel(page, 'Draw');
  await expect(brushPanel(page).locator('.pp-brush-panel__tips')).toBeVisible();
  await expect(brushPanel(page).locator('.pp-brush-panel__stabilizer')).toBeVisible();
  await closeBrushPanel(page, 'Draw');
  await toolButton(page, 'Smudge').click();
  await waitForToolSettings(page, { tool: 'smudge' });

  await reloadApp(page);
  await expect(toolButton(page, 'Smudge')).toHaveClass(/is-active/);
  await expectBrushSize(page, 70);
  await openBrushPanel(page, 'Smudge');
  await expect(brushPanel(page)).toContainText('Strength 80%');
  // Smudge's button names no tip.
  await expect(toolButton(page, 'Smudge')).toHaveText('Smudge');
});

test('a smudge tap changes nothing', async ({ page }) => {
  await openApp(page);
  await bar(page, 500);
  const before = await layerData(page);
  await toolButton(page, 'Smudge').click();
  const p = await canvasToPage(page, 500, 540);
  await page.mouse.click(p.x, p.y);
  expect(await layerData(page)).toEqual(before);
});

test('a drag carries paint out softly, and one Undo puts it back exactly', async ({ page }) => {
  await openApp(page);
  await bar(page, 400);
  const before = await layerData(page);

  await toolButton(page, 'Smudge').click();
  await setBrushSize(page, 80);
  await drag(page, 400, 540, 700, 540);

  // Paint was carried right of the bar (which ends near x 430)...
  const alphas = await rowAlphas(page, 540, 440, 760);
  expect(alphas.slice(0, 40).some((a) => a > 0)).toBe(true);
  // ...fading out, with soft (partial) pixels rather than a hard edge.
  expect(alphas.filter((a) => a > 0 && a < 255).length).toBeGreaterThan(20);
  expect(alphas[alphas.length - 1]).toBeLessThanOrEqual(alphas[0]);
  // Above and below the drag nothing changed.
  expect(await pixelAt(page, 600, 300)).toEqual([0, 0, 0, 0]);

  await undoBtn(page).click();
  await expect.poll(() => layerData(page)).toEqual(before);
});

test('smudging across two colors mixes them', async ({ page }) => {
  await openApp(page);
  await setColor(page, 'dd0000');
  await bar(page, 470);
  await setColor(page, '0000dd');
  await bar(page, 530);

  await toolButton(page, 'Smudge').click();
  await openBrushPanel(page, 'Smudge');
  await setPanelSlider(page, 'strength', 100);
  await closeBrushPanel(page, 'Smudge');
  await setBrushSize(page, 60);
  // Back and forth across the join, starting inside the red.
  await drag(page, 460, 540, 545, 540);
  await drag(page, 545, 540, 460, 540);

  // Somewhere across the join, a pixel is clearly both red and blue.
  const mixed = await page.evaluate(() => {
    const c = document.querySelector('.pp-layer--active');
    const d = c.getContext('2d').getImageData(440, 530, 120, 20).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200 && d[i] > 50 && d[i + 2] > 50) return true;
    }
    return false;
  });
  expect(mixed).toBe(true);
});

test('a smudge drag is one undo step, even over empty canvas (as erasing is)', async ({ page }) => {
  await openApp(page);
  await toolButton(page, 'Smudge').click();
  await expect(undoBtn(page)).toBeDisabled();
  await drag(page, 300, 300, 600, 300);
  await expect(undoBtn(page)).toBeEnabled();
});
