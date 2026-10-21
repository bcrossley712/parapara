// End-to-end tests for playback and the transport (step 4b): play
// from the frame she's on, loop or end on the last frame, a tap on the
// canvas stops it without drawing, things that change the project stop
// it first and then act, fps and loop are saved with the project, and
// previous/next step through frames. The loop's timing rules (skipping
// late frames, the decode ring, fps changes mid-play) are unit-tested
// in tests/unit/playback.test.js.
//
// Run: npm run test:e2e
//
// Not covered here (device-only): how smooth 24–30 fps looks on the
// iPad with real line art, how the stop tap feels with her stylus, and
// the moment of frame loading after a stop.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp } from './helpers.js';

const tiles = (page) => page.locator('.pp-frame-strip__tile');
const tile = (page, n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const playBtn = (page) => page.locator('.pp-transport__play');
const overlay = (page) => page.locator('.pp-playback');

async function settled(page) {
  await expect(addFrameBtn(page)).toBeEnabled();
}

async function addFrame(page) {
  await settled(page);
  const before = await tiles(page).count();
  await addFrameBtn(page).click();
  await expect(tiles(page)).toHaveCount(before + 1);
  await settled(page);
}

async function goToFrame(page, n) {
  await settled(page);
  await tile(page, n).click();
  await expect(tile(page, n)).toHaveClass(/is-current/);
  await settled(page);
}

async function canvasPoint(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

// A mouse stroke in canvas-pixel coordinates.
async function stroke(page, x1, y1, x2, y2) {
  const a = await canvasPoint(page, x1, y1);
  const b = await canvasPoint(page, x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / 20, a.y + ((b.y - a.y) * i) / 20);
  }
  await page.mouse.up();
}

// Alpha of the active layer at a canvas pixel (0 = nothing drawn).
function layerAlpha(page, x, y) {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector('.pp-layer--active');
    return c.getContext('2d').getImageData(px, py, 1, 1).data[3];
  }, [x, y]);
}

// Red channel of the playing picture at a canvas pixel (paper = 255).
function overlayRed(page, x, y) {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector('.pp-playback');
    return c ? c.getContext('2d').getImageData(px, py, 1, 1).data[0] : null;
  }, [x, y]);
}

async function setFps(page, fps) {
  await page.getByRole('button', { name: 'Frames per second' }).click();
  await page.getByRole('button', { name: `${fps} frames per second` }).click();
  await page.locator('.pp-top-bar').click({ position: { x: 300, y: 10 } }); // closes the panel
  await expect(page.locator('.pp-fps-panel')).toHaveCount(0);
  await expect(page.locator('.pp-transport__fps')).toHaveText(`${fps} fps`);
}

// The slowest speed, 1 fps, so a frame stays up for a whole second.
async function setSlowest(page) {
  await setFps(page, 6);
  await page.getByRole('button', { name: 'Frames per second' }).click();
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Slower' }).click();
  await expect(page.locator('.pp-fps-panel__value')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Slower' })).toBeDisabled();
  await page.locator('.pp-top-bar').click({ position: { x: 300, y: 10 } });
  await expect(page.locator('.pp-fps-panel')).toHaveCount(0);
}

// Three frames, each with a stroke in its own place, back on frame 1.
async function threeFrames(page) {
  await stroke(page, 200, 200, 400, 200);
  await addFrame(page);
  await stroke(page, 800, 500, 1000, 500);
  await addFrame(page);
  await stroke(page, 1400, 800, 1600, 800);
  await goToFrame(page, 1);
}

test('play runs through the frames from the one she is on, looping', async ({ page }) => {
  await openApp(page);
  await threeFrames(page);
  await goToFrame(page, 2);
  await setFps(page, 6);
  await playBtn(page).click();
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Pause');
  await expect(overlay(page)).toHaveCount(1);
  // The highlight follows the frame showing: 2, 3, then round to 1.
  const seen = new Set();
  await expect.poll(async () => {
    const current = await page.locator('.pp-frame-strip__tile.is-current').textContent();
    seen.add(current.trim());
    return seen.has('3') && seen.has('1');
  }, { timeout: 5000, intervals: [30] }).toBe(true);
  expect(await page.locator('.pp-frame-strip__tile.is-current').count()).toBe(1);
});

test('a tap on the canvas stops playback and draws nothing, even when dragged', async ({ page }) => {
  await openApp(page);
  await threeFrames(page);
  // Stopped while the first frame is still up, she lands where she
  // started — no frame load blocks input, so only the swallowing
  // keeps this drag from drawing.
  await setSlowest(page);
  await playBtn(page).click();
  await expect(overlay(page)).toHaveCount(1);
  await expect(tile(page, 1)).toHaveClass(/is-current/);
  // A drag across empty canvas while playing.
  await stroke(page, 300, 900, 600, 950);
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Play');
  await expect(overlay(page)).toHaveCount(0);
  await settled(page);
  expect(await layerAlpha(page, 450, 925)).toBe(0);
  // After lifting, drawing works again.
  await stroke(page, 300, 900, 600, 950);
  await expect.poll(() => layerAlpha(page, 450, 925)).toBeGreaterThan(0);
});

test('stopping lands on the frame that was showing', async ({ page }) => {
  await openApp(page);
  await threeFrames(page);
  await setFps(page, 6);
  await playBtn(page).click();
  await expect(tile(page, 2)).toHaveClass(/is-current/);
  await playBtn(page).click();
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Play');
  await settled(page);
  const current = (await page.locator('.pp-frame-strip__tile.is-current').textContent()).trim();
  // Its own drawing is on the live canvas now (frame 2 or 3 at 6 fps).
  if (current === '2') expect(await layerAlpha(page, 900, 500)).toBeGreaterThan(0);
  else if (current === '3') expect(await layerAlpha(page, 1500, 800)).toBeGreaterThan(0);
  else throw new Error(`landed on frame ${current}`);
  await expect(overlay(page)).toHaveCount(0);
});

test('without loop it plays to the last frame and stops there', async ({ page }) => {
  await openApp(page);
  await threeFrames(page);
  await page.getByRole('button', { name: 'Loop' }).click();
  await expect(page.getByRole('button', { name: 'Loop' })).toHaveAttribute('aria-pressed', 'false');
  await setFps(page, 24);
  await playBtn(page).click();
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Play', { timeout: 5000 });
  await expect(tile(page, 3)).toHaveClass(/is-current/);
  await settled(page);
  expect(await layerAlpha(page, 1500, 800)).toBeGreaterThan(0);
});

test('a stroke made just before play is in the animation (never starts early)', async ({ page }) => {
  await openApp(page);
  await addFrame(page);
  await goToFrame(page, 1);
  await setSlowest(page);

  await stroke(page, 900, 300, 1100, 300);
  await playBtn(page).click();
  await expect.poll(() => overlayRed(page, 1000, 300), { timeout: 5000 }).toBeLessThan(128);
});

test('undo while playing stops, then undoes', async ({ page }) => {
  await openApp(page);
  await threeFrames(page);
  await setFps(page, 6);
  await playBtn(page).click();
  await expect(overlay(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Play');
  // The last stroke was frame 3's: undo goes there and takes it away.
  await expect(tile(page, 3)).toHaveClass(/is-current/);
  await settled(page);
  await expect.poll(() => layerAlpha(page, 1500, 800)).toBe(0);
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
});

test('a tile tap while playing stops and goes to that frame', async ({ page }) => {
  await openApp(page);
  await threeFrames(page);
  await setFps(page, 6);
  await playBtn(page).click();
  await expect(overlay(page)).toHaveCount(1);
  await tile(page, 1).click();
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Play');
  await expect(tile(page, 1)).toHaveClass(/is-current/);
  await settled(page);
  await expect(page.locator('.pp-frame-menu')).toHaveCount(0);
  expect(await layerAlpha(page, 300, 200)).toBeGreaterThan(0);
});

test('fps and loop are saved with the project', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.pp-transport__fps')).toHaveText('12 fps');
  await expect(page.getByRole('button', { name: 'Loop' })).toHaveAttribute('aria-pressed', 'true');
  await setFps(page, 24);
  await page.getByRole('button', { name: 'Loop' }).click();
  await expect.poll(async () => {
    const project = await page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('parapara');
      req.onsuccess = () => {
        const db = req.result;
        const get = db.transaction('projects').objectStore('projects').getAll();
        get.onsuccess = () => resolve(get.result[0]);
      };
    }));
    return `${project.fps}|${project.loop}`;
  }).toBe('24|false');
  await reloadApp(page);
  await expect(page.locator('.pp-transport__fps')).toHaveText('24 fps');
  await expect(page.getByRole('button', { name: 'Loop' })).toHaveAttribute('aria-pressed', 'false');
});

test('one frame: play explains instead of playing', async ({ page }) => {
  await openApp(page);
  await playBtn(page).click();
  await expect(page.locator('#pp-banner')).toHaveText('Add another frame to play.');
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Play');
  await expect(overlay(page)).toHaveCount(0);
});

test('previous and next step one frame, without wrapping', async ({ page }) => {
  await openApp(page);
  await threeFrames(page);
  const prev = page.getByRole('button', { name: 'Previous frame' });
  const next = page.getByRole('button', { name: 'Next frame' });
  await expect(prev).toBeDisabled();
  await next.click();
  await expect(tile(page, 2)).toHaveClass(/is-current/);
  await settled(page);
  await next.click();
  await expect(tile(page, 3)).toHaveClass(/is-current/);
  await settled(page);
  await expect(next).toBeDisabled();
  await prev.click();
  await expect(tile(page, 2)).toHaveClass(/is-current/);
});

test('a finger that joins the stopping touch does not draw either', async ({ page }) => {
  await openApp(page);
  await threeFrames(page);
  await setSlowest(page);
  await playBtn(page).click();
  await expect(overlay(page)).toHaveCount(1);
  await expect(tile(page, 1)).toHaveClass(/is-current/);

  const cdp = await page.context().newCDPSession(page);
  const down = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: [...down.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y })),
  });
  down.set(1, await canvasPoint(page, 300, 950));
  await send('touchStart');
  // Playback has stopped while the first finger is still down.
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Play');
  await expect(overlay(page)).toHaveCount(0);
  // A second finger lands and drags well away from the first.
  const from = await canvasPoint(page, 900, 950);
  const to = await canvasPoint(page, 1300, 950);
  down.set(2, from);
  await send('touchStart');
  for (let i = 1; i <= 10; i++) {
    down.set(2, { x: from.x + ((to.x - from.x) * i) / 10, y: from.y });
    await send('touchMove');
  }
  down.delete(2);
  await send('touchEnd');
  down.delete(1);
  await send('touchEnd');
  await settled(page);
  expect(await layerAlpha(page, 1100, 950)).toBe(0);
  expect(await layerAlpha(page, 300, 950)).toBe(0);
});
