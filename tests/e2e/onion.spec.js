// End-to-end tests for onion skin (step 4c): off by default; the badge
// turns on ghosts of the frames around hers — previous red, next
// green — under her layers; fill ignores them; they hide while playing
// and come back after; the settings are saved with the project. Which
// frames show, the fading and the settings' clean-up are unit-tested
// in tests/unit/onion.test.js.
//
// Run: npm run test:e2e
//
// Not covered here (device-only): how the ghosts read with her real
// line art and stylus, and how quickly they appear after a frame
// switch on the iPad.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp } from './helpers.js';

const tiles = (page) => page.locator('.pp-frame-strip__tile');
const tile = (page, n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const onionBtn = (page) => page.getByRole('button', { name: 'Onion skin', exact: true });
const settingsBtn = (page) => page.getByRole('button', { name: 'Onion skin settings' });
const playBtn = (page) => page.locator('.pp-transport__play');
const ghosts = (page) => page.locator('.pp-onion');

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

// [r, g, b, a] of the ghost canvas at a canvas pixel, or null if no
// ghosts are showing.
function ghostPixel(page, x, y) {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector('.pp-onion');
    return c ? Array.from(c.getContext('2d').getImageData(px, py, 1, 1).data) : null;
  }, [x, y]);
}

function layerAlpha(page, x, y) {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector('.pp-layer--active');
    return c.getContext('2d').getImageData(px, py, 1, 1).data[3];
  }, [x, y]);
}

// Polls until the ghost at (x, y) is showing and red (or green) wins.
async function expectGhost(page, x, y, color) {
  await expect.poll(async () => {
    const px = await ghostPixel(page, x, y);
    if (!px || px[3] === 0) return 'none';
    if (px[0] > px[1] + 50) return 'red';
    if (px[1] > px[0] + 50) return 'green';
    return 'other';
  }, { timeout: 5000 }).toBe(color);
}

// Frame 1: a stroke at the top left. Frame 2: one in the middle.
// Frame 3: one at the bottom right. Ends on frame 2.
async function threeFrames(page) {
  await stroke(page, 200, 200, 400, 200);
  await addFrame(page);
  await stroke(page, 800, 500, 1000, 500);
  await addFrame(page);
  await stroke(page, 1400, 800, 1600, 800);
  await goToFrame(page, 2);
}

test('off by default; on, the frames around hers show as red and green ghosts', async ({ page }) => {
  await openApp(page);
  await expect(onionBtn(page)).toHaveAttribute('aria-pressed', 'false');
  await threeFrames(page);
  await expect(ghosts(page)).toHaveCount(0);

  await onionBtn(page).click();
  await expect(onionBtn(page)).toHaveAttribute('aria-pressed', 'true');
  await expectGhost(page, 300, 200, 'red');   // frame 1, before
  await expectGhost(page, 1500, 800, 'green'); // frame 3, after
  // Her own frame isn't a ghost.
  expect((await ghostPixel(page, 900, 500))[3]).toBe(0);

  // Over the photo's holder, under every layer.
  const order = await page.evaluate(() => Array.from(document.querySelector('.pp-canvas').children)
    .map((el) => el.className.split(' ')[0]));
  expect(order[0]).toBe('pp-reference');
  expect(order[1]).toBe('pp-onion');
  expect(order.slice(2).every((name) => name === 'pp-layer')).toBe(true);

  // Moving to frame 1: frame 2 is now the "after" ghost; nothing before.
  await goToFrame(page, 1);
  await expectGhost(page, 900, 500, 'green');
  await expectGhost(page, 1500, 800, 'none');

  // Off takes the ghosts away.
  await onionBtn(page).click();
  await expect(ghosts(page)).toHaveCount(0);
});

test('fill ignores the ghosts: it spreads straight across a ghost line', async ({ page }) => {
  await openApp(page);
  // Frame 1: a line from top to bottom, starting and ending off the
  // page (above and below it is still the canvas area) so it has no
  // gap at either end.
  await stroke(page, 960, -60, 960, 1140);
  await addFrame(page);
  await onionBtn(page).click();
  await expectGhost(page, 960, 540, 'red');
  await page.getByRole('button', { name: 'Fill', exact: true }).click();
  const left = await canvasPoint(page, 400, 540);
  await page.mouse.click(left.x, left.y);
  // The right of the ghost line got filled too.
  await expect.poll(() => layerAlpha(page, 1500, 540)).toBeGreaterThan(0);
});

test('ghosts hide while playing, and a tap on the badge does not stop it', async ({ page }) => {
  await openApp(page);
  await threeFrames(page);
  await onionBtn(page).click();
  await expectGhost(page, 300, 200, 'red');

  await playBtn(page).click();
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Pause');
  await expect(ghosts(page)).toHaveCount(0);
  // The badge is a setting, like fps: playing carries on.
  await onionBtn(page).click();
  await onionBtn(page).click();
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Pause');
  await expect(ghosts(page)).toHaveCount(0);

  await playBtn(page).click();
  await expect(playBtn(page)).toHaveAttribute('aria-label', 'Play');
  await settled(page);
  // Back on whichever frame was showing, with that frame's ghosts.
  await expect(ghosts(page)).toHaveCount(1);
});

test('a tap on the badge never draws', async ({ page }) => {
  await openApp(page);
  // The badge stops its own pointer events, so taps on it and its
  // panel leave the layer empty.
  await onionBtn(page).click();
  await settingsBtn(page).click();
  await page.getByRole('button', { name: 'More frames before' }).click();
  await page.locator('.pp-top-bar').click({ position: { x: 300, y: 10 } });
  await expect(page.locator('.pp-onion-panel')).toHaveCount(0);
  const empty = await page.evaluate(() => {
    const c = document.querySelector('.pp-layer--active');
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
    return true;
  });
  expect(empty).toBe(true);
});

test('the settings are saved with the project', async ({ page }) => {
  await openApp(page);
  await onionBtn(page).click();
  await settingsBtn(page).click();
  const panel = page.locator('.pp-onion-panel');
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'More frames before' }).click();
  await page.getByRole('button', { name: 'More frames before' }).click();
  await page.getByRole('button', { name: 'Fewer frames after' }).click();
  await expect(page.getByRole('button', { name: 'Fewer frames after' })).toBeDisabled();
  await page.getByRole('radio', { name: 'Before color: Blue' }).click();
  await page.getByRole('slider', { name: 'Onion skin opacity' }).fill('60');
  await expect(panel).toContainText('Opacity 60%');

  await expect.poll(async () => {
    const project = await page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('parapara');
      req.onsuccess = () => {
        const get = req.result.transaction('projects').objectStore('projects').getAll();
        get.onsuccess = () => resolve(get.result[0]);
      };
    }));
    return JSON.stringify(project?.onionSkin);
  }).toBe(JSON.stringify({
    on: true, before: 3, after: 0, opacity: 0.6, tintBefore: '#3e63dd', tintAfter: '#30a46c',
  }));

  await reloadApp(page);
  await expect(onionBtn(page)).toHaveAttribute('aria-pressed', 'true');
  await settingsBtn(page).click();
  await expect(panel.locator('.pp-onion-panel__value').first()).toHaveText('3');
  await expect(panel.locator('.pp-onion-panel__value').nth(1)).toHaveText('0');
  await expect(page.getByRole('radio', { name: 'Before color: Blue' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel).toContainText('Opacity 60%');
});
