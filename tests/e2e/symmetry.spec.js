// End-to-end tests for symmetry (8b-i): the rail's menu, mirrored draw
// / erase / smudge, one undo step per mirrored stroke, the guide, and
// the mode saved per project. Mouse strokes (draw immediately).
//
// Not covered here (device-only): how the guide looks on her iPad,
// and stylus feel with the copies trailing the stabilizer.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, readDb, closeLayersPanel } from './helpers.js';

const symmetryBtn = (page) => page.locator('.pp-symmetry-btn');
const undoBtn = (page) => page.getByRole('button', { name: 'Undo' });
const redoBtn = (page) => page.getByRole('button', { name: 'Redo' });
const guide = (page) => page.locator('.pp-symmetry-guide');

async function pickSymmetry(page, label) {
  await symmetryBtn(page).click();
  await page.locator('.pp-symmetry-menu').getByRole('menuitemradio', { name: label, exact: true }).click();
  await expect(symmetryBtn(page)).toHaveAttribute('aria-label', `Symmetry: ${label}`);
}

async function canvasPoint(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

// A mouse stroke in canvas-pixel coordinates.
async function stroke(page, x1, y1, x2, y2) {
  const reopen = await closeLayersPanel(page);
  const a = await canvasPoint(page, x1, y1);
  const b = await canvasPoint(page, x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / 20, a.y + ((b.y - a.y) * i) / 20);
  }
  await page.mouse.up();
  await reopen();
}

// Painted pixels of the active layer in each quadrant (tl, tr, bl, br)
// and the paint's box in each half — enough to tell where copies went.
function quadrants(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.pp-layer--active');
    const { width: w, height: h } = c;
    const d = c.getContext('2d').getImageData(0, 0, w, h).data;
    const q = { tl: 0, tr: 0, bl: 0, br: 0 };
    const box = { left: [w, -1], right: [w, -1] };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] === 0) continue;
        const key = (y < h / 2 ? 't' : 'b') + (x < w / 2 ? 'l' : 'r');
        q[key]++;
        const side = x < w / 2 ? box.left : box.right;
        side[0] = Math.min(side[0], x);
        side[1] = Math.max(side[1], x);
      }
    }
    return { ...q, total: q.tl + q.tr + q.bl + q.br, box };
  });
}

// Waits for the stroke to have committed (the Undo button lights up).
async function committed(page) {
  await expect(undoBtn(page)).toBeEnabled();
}

test('symmetry starts off with no guide', async ({ page }) => {
  await openApp(page);
  await expect(symmetryBtn(page)).toHaveAttribute('aria-label', 'Symmetry: Off');
  await expect(symmetryBtn(page)).not.toHaveClass(/is-active/);
  await expect(guide(page)).toBeHidden();
});

test('vertical mirrors a stroke left to right; one undo takes both away, redo brings both back', async ({ page }) => {
  await openApp(page);
  await pickSymmetry(page, 'Vertical');
  await expect(symmetryBtn(page)).toHaveClass(/is-active/);
  await expect(guide(page)).toBeVisible();
  await expect(page.locator('.pp-symmetry-guide__line--vertical')).toBeVisible();
  await expect(page.locator('.pp-symmetry-guide__line--horizontal')).toBeHidden();

  await stroke(page, 200, 300, 600, 300);
  await committed(page);
  const q = await quadrants(page);
  expect(q.tl).toBeGreaterThan(500);
  // The copy is the same size, in the mirrored place.
  expect(Math.abs(q.tr - q.tl)).toBeLessThan(q.tl * 0.02);
  expect(Math.abs((1919 - q.box.right[1]) - q.box.left[0])).toBeLessThanOrEqual(2);
  expect(Math.abs((1919 - q.box.right[0]) - q.box.left[1])).toBeLessThanOrEqual(2);
  expect(q.bl + q.br).toBe(0);

  await undoBtn(page).click();
  await expect.poll(async () => (await quadrants(page)).total).toBe(0);
  await expect(undoBtn(page)).toBeDisabled(); // one step, not two

  await redoBtn(page).click();
  await expect.poll(async () => (await quadrants(page)).total).toBe(q.total);
});

test('both puts a copy in every quarter, and the mode is saved with the project', async ({ page }) => {
  await openApp(page);
  await pickSymmetry(page, 'Both');
  await expect(page.locator('.pp-symmetry-guide__line--vertical')).toBeVisible();
  await expect(page.locator('.pp-symmetry-guide__line--horizontal')).toBeVisible();

  await stroke(page, 150, 150, 500, 250);
  await committed(page);
  const q = await quadrants(page);
  for (const key of ['tl', 'tr', 'bl', 'br']) expect(q[key], key).toBeGreaterThan(300);
  // Undo kept four small boxes, not one box round all four corners.
  // (The log is written to storage a moment later, so poll.)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('parapara-dev-log') ?? '[]').join('\n')))
    .toMatch(/stroke tool=draw .*parts=4/);
  // One undo still takes all four away.
  await undoBtn(page).click();
  await expect.poll(async () => (await quadrants(page)).total).toBe(0);
  await redoBtn(page).click();
  await expect.poll(async () => (await quadrants(page)).total).toBe(q.total);

  await expect.poll(async () => (await readDb(page, 'projects'))[0]?.symmetry).toBe('both');
  await reloadApp(page);
  await expect(symmetryBtn(page)).toHaveAttribute('aria-label', 'Symmetry: Both');
  await expect(guide(page)).toBeVisible();
});

test('a stroke started with symmetry on stays mirrored; turning it off stops the copies', async ({ page }) => {
  await openApp(page);
  await pickSymmetry(page, 'Horizontal');
  await stroke(page, 300, 100, 700, 100);
  await committed(page);
  let q = await quadrants(page);
  expect(q.bl).toBeGreaterThan(300);           // mirrored to the bottom
  expect(q.tr + q.br).toBe(0);

  await pickSymmetry(page, 'Off');
  await expect(guide(page)).toBeHidden();
  const before = q;
  await stroke(page, 1200, 200, 1600, 200);     // top right only
  await expect.poll(async () => (await quadrants(page)).tr).toBeGreaterThan(300);
  q = await quadrants(page);
  expect(q.br).toBe(0);
  expect(q.bl).toBe(before.bl);
});

test('erase mirrors too', async ({ page }) => {
  await openApp(page);
  // A line across the whole page, with symmetry off.
  await stroke(page, 50, 540, 1870, 540);
  await committed(page);
  const full = await quadrants(page);

  await pickSymmetry(page, 'Vertical');
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await stroke(page, 100, 500, 100, 580); // erase a gap near the left end
  await expect.poll(async () => (await quadrants(page)).total).toBeLessThan(full.total);
  const after = await quadrants(page);
  const lostLeft = (full.tl + full.bl) - (after.tl + after.bl);
  const lostRight = (full.tr + full.br) - (after.tr + after.br);
  // A 6 px eraser across a 6 px line takes about 6 × 6.
  expect(lostLeft).toBeGreaterThan(20);
  expect(Math.abs(lostRight - lostLeft)).toBeLessThanOrEqual(Math.max(4, lostLeft * 0.1));
});

test('smudge mirrors too', async ({ page }) => {
  await openApp(page);
  await pickSymmetry(page, 'Vertical');
  await stroke(page, 300, 300, 300, 700);   // and its copy at x 1620
  await committed(page);
  const drawn = await quadrants(page);

  await page.getByRole('button', { name: 'Smudge', exact: true }).click();
  await stroke(page, 250, 500, 500, 500);   // drag paint off the line
  await expect.poll(async () => (await quadrants(page)).total).toBeGreaterThan(drawn.total);
  const after = await quadrants(page);
  const grewLeft = (after.tl + after.bl) - (drawn.tl + drawn.bl);
  const grewRight = (after.tr + after.br) - (drawn.tr + drawn.br);
  expect(grewLeft).toBeGreaterThan(20);
  expect(grewRight).toBeGreaterThan(grewLeft * 0.5);
});

test('fill does not mirror', async ({ page }) => {
  await openApp(page);
  // A wall down the middle-left, so the left part fills on its own.
  await stroke(page, 400, 0, 400, 1079);
  await committed(page);
  await pickSymmetry(page, 'Vertical');
  await page.getByRole('button', { name: 'Fill', exact: true }).click();
  const p = await canvasPoint(page, 100, 540);
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await quadrants(page)).tl).toBeGreaterThan(100000);
  const q = await quadrants(page);
  // Right of the wall (and the whole right half) untouched.
  expect(q.tr + q.br).toBe(0);
});

test('a new project starts with symmetry off', async ({ page }) => {
  await openApp(page);
  await pickSymmetry(page, 'Both');
  await expect.poll(async () => (await readDb(page, 'projects'))[0]?.symmetry).toBe('both');
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.locator('.pp-gallery').waitFor();
  await page.getByRole('button', { name: 'New animation' }).click();
  await page.locator('.pp-canvas').waitFor();
  await expect(symmetryBtn(page)).toHaveAttribute('aria-label', 'Symmetry: Off');
  await expect(guide(page)).toBeHidden();
});

test('the guide hides while playing', async ({ page }) => {
  await openApp(page);
  await pickSymmetry(page, 'Vertical');
  await expect(guide(page)).toBeVisible();
  const play = page.locator('.pp-transport__play');
  const addFrame = page.getByRole('button', { name: 'Add frame' });
  await expect(addFrame).toBeEnabled();
  await addFrame.click(); // playing needs two frames (loop is on)
  await expect(page.locator('.pp-frame-strip__tile')).toHaveCount(2);
  await expect(addFrame).toBeEnabled();
  await play.click();
  await expect(page.locator('.pp-playback')).toHaveCount(1);
  await expect(guide(page)).toBeHidden();
  await play.click();
  await expect(play).toHaveAttribute('aria-label', 'Play');
  await expect(page.locator('.pp-playback')).toHaveCount(0);
  await expect(guide(page)).toBeVisible();
});
