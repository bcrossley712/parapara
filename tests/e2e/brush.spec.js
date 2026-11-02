// End-to-end tests for brush tips and the brush panel (8b-ii): the
// real app in headless Chromium.
//
// Not covered here (device-only): how each tip looks and feels with
// her stylus, and whether big Soft/Paintbrush strokes keep up on her
// iPad.

import { test, expect } from '@playwright/test';
import {
  openApp, reloadApp, waitForToolSettings, setBrushSize, expectBrushSize,
  brushPanel, openBrushPanel, closeBrushPanel, setPanelSlider, pickTip,
} from './helpers.js';

const toolButton = (page, name) => page.getByRole('button', { name, exact: true });
const undoBtn = (page) => page.getByRole('button', { name: 'Undo', exact: true });

// Page point for a canvas pixel (the view is at fit, unrotated).
async function canvasToPage(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

async function tapAt(page, x, y) {
  const p = await canvasToPage(page, x, y);
  await page.mouse.click(p.x, p.y);
}

async function lineAt(page, x1, y, x2) {
  const a = await canvasToPage(page, x1, y);
  const b = await canvasToPage(page, x2, y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
}

// Active layer's pixels in a canvas box.
function pixels(page, x, y, w, h) {
  return page.evaluate(([px, py, pw, ph]) => {
    const c = document.querySelector('.pp-layer--active');
    return Array.from(c.getContext('2d').getImageData(px, py, pw, ph).data);
  }, [x, y, w, h]);
}

const inkCount = (page) => page.evaluate(() => {
  const c = document.querySelector('.pp-layer--active');
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n += 1;
  return n;
});

async function setSymmetry(page, label) {
  await page.locator('.pp-symmetry-btn').click();
  await page.getByRole('menuitemradio', { name: label }).click();
}

// ---------------- the panel ----------------

test('tapping the current Draw or Erase opens its brush panel; Fill and Smudge have none', async ({ page }) => {
  await openApp(page);
  await expect(brushPanel(page)).toHaveCount(0);

  await toolButton(page, 'Draw').click(); // already Draw
  await expect(brushPanel(page)).toBeVisible();
  await expect(brushPanel(page)).toContainText('Draw brush');
  await expect(brushPanel(page).getByRole('button', { name: 'Pen', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await toolButton(page, 'Draw').click(); // toggles closed
  await expect(brushPanel(page)).toHaveCount(0);

  // Picking another tool closes it and doesn't open that tool's.
  await toolButton(page, 'Draw').click();
  await toolButton(page, 'Erase').click();
  await expect(brushPanel(page)).toHaveCount(0);
  await expect(toolButton(page, 'Erase')).toHaveClass(/is-active/);
  await toolButton(page, 'Erase').click();
  await expect(brushPanel(page)).toContainText('Erase brush');
  await toolButton(page, 'Erase').click();

  for (const name of ['Fill', 'Smudge']) {
    await toolButton(page, name).click();
    await toolButton(page, name).click();
    await expect(brushPanel(page)).toHaveCount(0);
  }
});

test('a canvas tap with the panel open only closes it', async ({ page }) => {
  await openApp(page);
  await openBrushPanel(page, 'Draw');
  await tapAt(page, 1400, 540);
  await expect(brushPanel(page)).toHaveCount(0);
  expect(await inkCount(page)).toBe(0);
});

test('the rail shows each tool\'s tip; the panel and rail size stay in step', async ({ page }) => {
  await openApp(page);
  await expect(toolButton(page, 'Draw')).toContainText('Pen');
  await expect(toolButton(page, 'Erase')).toContainText('Pen');

  await pickTip(page, 'Draw', 'Pencil');
  await expect(toolButton(page, 'Draw')).toContainText('Pencil');
  await expect(toolButton(page, 'Erase')).toContainText('Pen');
  await expectBrushSize(page, 4); // Pencil's own default size

  await setBrushSize(page, 30); // rail
  await openBrushPanel(page, 'Draw');
  await expect(brushPanel(page)).toContainText('Size 30');
  await closeBrushPanel(page, 'Draw');
});

// ---------------- remembering ----------------

test('tip per tool, and size and strength per tool and tip, survive a reload', async ({ page }) => {
  await openApp(page);

  await pickTip(page, 'Draw', 'Pencil', { strength: 40 });
  await setBrushSize(page, 12);
  await pickTip(page, 'Draw', 'Chalk');
  await setBrushSize(page, 50);
  await toolButton(page, 'Erase').click();
  await pickTip(page, 'Erase', 'Pencil', { strength: 30 });
  await setBrushSize(page, 90);

  await waitForToolSettings(page, {
    tool: 'erase',
    tips: { draw: 'chalk', erase: 'pencil' },
  });
  await reloadApp(page);

  await expect(toolButton(page, 'Erase')).toHaveClass(/is-active/);
  await expect(toolButton(page, 'Erase')).toContainText('Pencil');
  await expectBrushSize(page, 90);
  await openBrushPanel(page, 'Erase');
  await expect(brushPanel(page)).toContainText('Strength 30%');
  await closeBrushPanel(page, 'Erase');

  await toolButton(page, 'Draw').click();
  await expect(toolButton(page, 'Draw')).toContainText('Chalk');
  await expectBrushSize(page, 50);
  await pickTip(page, 'Draw', 'Pencil');
  await expectBrushSize(page, 12); // Draw-Pencil kept its own, not Erase-Pencil's 90
  await openBrushPanel(page, 'Draw');
  await expect(brushPanel(page)).toContainText('Strength 40%');
  await closeBrushPanel(page, 'Draw');
});

// ---------------- what tips paint ----------------

test('Pen at full strength paints the exact color, solid in the middle', async ({ page }) => {
  await openApp(page);
  await setBrushSize(page, 30);
  await tapAt(page, 960, 540);
  const center = await pixels(page, 958, 538, 4, 4);
  for (let i = 0; i < center.length; i += 4) {
    expect(center.slice(i, i + 4)).toEqual([0x2b, 0x2b, 0x2b, 255]);
  }
});

test('strength: Draw at 50% paints half-strength; Erase at 50% leaves about half', async ({ page }) => {
  await openApp(page);
  await pickTip(page, 'Draw', 'Pen', { strength: 50 });
  await setBrushSize(page, 30);
  await tapAt(page, 600, 540);
  const [, , , drawn] = await pixels(page, 600, 540, 1, 1);
  expect(Math.abs(drawn - 128)).toBeLessThanOrEqual(2);

  // A full layer, then a half-strength eraser through it.
  await toolButton(page, 'Fill').click();
  await tapAt(page, 1500, 200);
  await toolButton(page, 'Erase').click();
  await pickTip(page, 'Erase', 'Pen', { strength: 50 });
  await setBrushSize(page, 30);
  await lineAt(page, 1100, 700, 1500);
  const [, , , left] = await pixels(page, 1300, 700, 1, 1);
  expect(Math.abs(left - 128)).toBeLessThanOrEqual(2);
  // A stroke doesn't build on itself, so crossing back keeps it at half.
  await lineAt(page, 1100, 760, 1500);
  await lineAt(page, 1500, 760, 1100);
  const [, , , twice] = await pixels(page, 1300, 760, 1, 1);
  expect(Math.abs(twice - 64)).toBeLessThanOrEqual(3); // two strokes: 1/2 × 1/2
});

test('every tip stays inside what undo restores, mirrored too', async ({ page }) => {
  await openApp(page);
  await setSymmetry(page, 'Both');
  for (const tip of ['Pen', 'Pencil', 'Chalk', 'Chisel', 'Paintbrush', 'Soft']) {
    await pickTip(page, 'Draw', tip);
    await setBrushSize(page, 120);
    await lineAt(page, 500, 300, 700);
    await expect.poll(() => inkCount(page), { message: tip }).toBeGreaterThan(0);
    await undoBtn(page).click();
    await expect.poll(() => inkCount(page), { message: `${tip} left ink after undo` }).toBe(0);
  }
});

test('chisel: the mirrored copy leans the other way', async ({ page }) => {
  await openApp(page);
  await setSymmetry(page, 'Vertical');
  await pickTip(page, 'Draw', 'Chisel');
  await setBrushSize(page, 80);
  await tapAt(page, 600, 540);

  // Sign of the x/y correlation of the ink around each copy: the nib
  // rises to the right ("/", y down → negative); its mirror is "\".
  const lean = (cx) => page.evaluate(([x0]) => {
    const c = document.querySelector('.pp-layer--active');
    const { data } = c.getContext('2d').getImageData(x0 - 60, 480, 120, 120);
    let n = 0; let sx = 0; let sy = 0; let sxy = 0;
    for (let y = 0; y < 120; y++) {
      for (let x = 0; x < 120; x++) {
        if (data[(y * 120 + x) * 4 + 3] > 128) { n += 1; sx += x; sy += y; sxy += x * y; }
      }
    }
    return n ? sxy / n - (sx / n) * (sy / n) : 0;
  }, [cx]);
  expect(await lean(600)).toBeLessThan(-20);
  expect(await lean(1920 - 600)).toBeGreaterThan(20);
});

test('pencil grain is fixed to the canvas, not to the stroke', async ({ page }) => {
  await openApp(page);
  await pickTip(page, 'Draw', 'Pencil', { strength: 100 });
  await setBrushSize(page, 40);
  await lineAt(page, 400, 540, 1000);
  const first = await pixels(page, 600, 530, 200, 20);
  expect(new Set(first.filter((_, i) => i % 4 === 3)).size).toBeGreaterThan(10); // grainy, not flat
  await undoBtn(page).click();
  await expect.poll(() => inkCount(page)).toBe(0);
  await lineAt(page, 437, 540, 1100); // starts elsewhere, covers the same middle
  // Same grain pixel for pixel (alpha; faint pixels' color can round
  // differently).
  const second = await pixels(page, 600, 530, 200, 20);
  let worst = 0;
  for (let i = 3; i < first.length; i += 4) worst = Math.max(worst, Math.abs(first[i] - second[i]));
  expect(worst).toBeLessThanOrEqual(2);
});
