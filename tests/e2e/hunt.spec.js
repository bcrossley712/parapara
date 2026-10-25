// The robot test: a seeded, randomized hunt for lost drawing.
//
// A robot user draws, erases, smudges, undoes, redoes, adds, switches,
// deletes and drags frames (4d), copies a layer's drawing and pastes
// it into whichever layer is active, on any frame (4d),
// switches layers, plays and stops, hides the app, has saves fail
// (out of space), and has a layer canvas lose its pixels (what iOS did
// on her iPad, after 4c). A model follows along. Every mark is a short
// line at its own spot, so at the end each one can be checked — on
// screen, then again after a reload (from storage): every mark the
// model says is there must be there, and every undone one must not.
//
// Run: npm run test:e2e. More seeds or steps locally:
//   HUNT_SEEDS=16 HUNT_STEPS=80 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
//     npx playwright test tests/e2e/hunt.spec.js --project=app
// A failure names its seed; HUNT_SEED=<n> reruns just that one.
//
// Not covered: fill (a fill on a blank layer covers every mark),
// photos, touch gestures (undo.spec.js), and the real iOS failure.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, savedDrawingBytes, waitForDrawingSave, setVisibility, layerMenu } from './helpers.js';

const SEEDS = process.env.HUNT_SEED
  ? [Number(process.env.HUNT_SEED)]
  : Array.from({ length: Number(process.env.HUNT_SEEDS ?? 3) }, (_, i) => 101 + i);
const STEPS = Number(process.env.HUNT_STEPS ?? 40);
const HISTORY_CAP = 30; // history.js

// Marks: a grid of spots left of the layers panel, above the scribble
// band where erase and smudge go (never on a mark).
const SPOTS = [];
for (let y = 80; y <= 960; y += 55) for (let x = 80; x <= 1200; x += 70) SPOTS.push({ x, y });
const SCRIBBLE_Y = 1045;

// mulberry32: small, seeded, good enough.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const undoBtn = (page) => page.getByRole('button', { name: 'Undo', exact: true });
const redoBtn = (page) => page.getByRole('button', { name: 'Redo', exact: true });
const tile = (page, n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });
const tiles = (page) => page.locator('.pp-frame-strip__tile');
const currentTileId = (page) => page.locator('.pp-frame-strip__tile.is-current').getAttribute('data-frame-id');
const tileIds = (page) => tiles(page).evaluateAll((els) => els.map((e) => e.dataset.frameId));

async function frameMenu(page, item) {
  await idle(page);
  // A "switch frame" onto the frame she's on opens the menu already.
  if (!(await page.locator('.pp-frame-menu').isVisible())) {
    await page.locator('.pp-frame-strip__tile.is-current').click();
  }
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

async function idle(page) {
  await expect(addFrameBtn(page)).toBeEnabled();
}

async function dismissNotices(page) {
  const btns = page.locator('.pp-toast--notice .pp-toast__btn');
  while (await btns.count()) await btns.first().click();
}

async function line(page, x0, y, x1) {
  const box = await page.locator('.pp-canvas').boundingBox();
  const sx = (x) => box.x + (x / 1920) * box.width;
  const sy = (v) => box.y + (v / 1080) * box.height;
  await page.mouse.move(sx(x0), sy(y));
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(sx(x0 + ((x1 - x0) * i) / 6), sy(y));
  await page.mouse.up();
}

async function pickTool(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
}

async function currentIndex(page) {
  await idle(page);
  return Number(await page.locator('.pp-frame-strip__tile.is-current').textContent()) - 1;
}

const activeLayer = (page) => page.locator('.pp-layer--active').getAttribute('data-layer-id');

async function setPanel(page, open) {
  const visible = await page.locator('.pp-layers').isVisible();
  if (visible !== open) await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await expect(page.locator('.pp-layers')).toBeVisible({ visible: open });
}

function paintedOn(page, layerId, x, y) {
  return page.evaluate(([id, px, py]) => {
    const el = document.querySelector(`.pp-layer[data-layer-id="${id}"]`);
    return el ? el.getContext('2d').getImageData(px, py, 1, 1).data[3] > 0 : null;
  }, [layerId, x, y]);
}

// Saves have stopped landing: the saved drawing is unchanged across
// two gaps longer than the autosave delay (500 ms). A fixed wait, but
// it proves something *doesn't* happen (see helpers.js). Used only
// before a simulated canvas loss, which by design drops strokes that
// weren't saved yet — so a save still on its way would look like a
// lost mark.
async function settled(page) {
  let last = await savedDrawingBytes(page);
  for (let same = 0; same < 2;) {
    await page.waitForTimeout(800);
    const now = await savedDrawingBytes(page);
    same = now === last ? same + 1 : 0;
    last = now;
  }
}

async function failNextBlobSaves(page, on) {
  await page.evaluate((enable) => {
    const proto = IDBObjectStore.prototype;
    if (enable && !proto.__ppRealPut) {
      proto.__ppRealPut = proto.put;
      proto.put = function put(...args) {
        if (this.name === 'blobs') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return proto.__ppRealPut.apply(this, args);
      };
    } else if (!enable && proto.__ppRealPut) {
      proto.put = proto.__ppRealPut;
      delete proto.__ppRealPut;
    }
  }, on);
}

// On a failure, keep the activity log with the report.
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const log = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    return (JSON.parse(localStorage.getItem('parapara-dev-log') ?? '[]')).join('\n');
  }).catch(() => '(page gone)');
  const file = info.outputPath('activity-log.txt');
  await import('node:fs/promises').then((fs) => fs.writeFile(file, log));
  await info.attach('activity-log', { path: file, contentType: 'text/plain' });
});

for (const seed of SEEDS) {
  test(`hunt seed ${seed}: no mark is ever lost`, async ({ page }) => {
    test.setTimeout(60_000 + STEPS * 4_000);
    const random = rng(seed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const steps = [];

    await openApp(page);
    // Two layers from the start (adding one is an undo step too).
    await setPanel(page, true);
    const base = await activeLayer(page);
    await page.getByRole('button', { name: 'Add layer' }).click();
    await expect(page.locator('.pp-layers__row')).toHaveCount(2);
    await idle(page);
    const second = await activeLayer(page);
    await setPanel(page, false);

    // The model.
    const frameA = { key: 'A', id: await currentTileId(page) };
    const model = {
      timeline: [frameA],
      layers: [base, second],
      marks: [], // { frame, layer, spot, present }
      history: [{ type: 'layer-add', layer: second }],
      redo: [],
      spots: [...SPOTS].sort(() => random() - 0.5),
      frames: 1,
      clipboard: null, // spots copied (4d)
    };
    const push = (entry) => {
      model.history.push(entry);
      if (model.history.length > HISTORY_CAP) model.history.shift();
      model.redo = [];
    };
    const apply = (entry, forward) => {
      if (entry.type === 'mark') entry.mark.present = forward;
      else if (entry.type === 'frame-add') {
        if (forward) model.timeline.splice(entry.index, 0, entry.frame);
        else model.timeline.splice(model.timeline.indexOf(entry.frame), 1);
      } else if (entry.type === 'frame-delete') {
        if (forward) model.timeline.splice(model.timeline.indexOf(entry.frame), 1);
        else model.timeline.splice(entry.index, 0, entry.frame);
      } else if (entry.type === 'frame-move') {
        model.timeline.splice(model.timeline.indexOf(entry.frame), 1);
        model.timeline.splice(forward ? entry.to : entry.from, 0, entry.frame);
      } else if (entry.type === 'paste') {
        for (const mark of entry.marks) mark.present = forward;
      } else if (entry.type === 'layer-add') {
        if (forward) model.layers.push(entry.layer);
        else model.layers = model.layers.filter((l) => l !== entry.layer);
      }
    };

    // A "switch frame" onto the frame she's on leaves the frame menu
    // open, and a canvas tap with a menu open only closes it (after 5b).
    // So the first stroke then is a closing tap: it must close the menu
    // and paint nothing — modeled as a mark that's never there (and
    // outside the undo history) — before the real mark is made.
    async function closeMenuByTap() {
      if (!(await page.locator('.pp-frame-menu').isVisible())) return true;
      const spot = model.spots.pop();
      if (!spot) return false;
      const frame = model.timeline[await currentIndex(page)];
      const layer = await activeLayer(page);
      await line(page, spot.x, spot.y, spot.x + 24);
      await expect(page.locator('.pp-frame-menu')).toHaveCount(0);
      model.marks.push({ frame, layer, spot, present: false });
      steps.push('(tap closes frame menu)');
      return true;
    }

    async function markStroke() {
      if (!(await closeMenuByTap())) return false;
      const spot = model.spots.pop();
      if (!spot) return false;
      const frame = model.timeline[await currentIndex(page)];
      const layer = await activeLayer(page);
      await line(page, spot.x, spot.y, spot.x + 24);
      const mark = { frame, layer, spot, present: true };
      model.marks.push(mark);
      push({ type: 'mark', mark });
      return true;
    }

    const actions = [
      [30, 'mark', markStroke],
      [6, 'scribble', async () => {
        const tool = pick(['Erase', 'Smudge']);
        await pickTool(page, tool);
        const x = 100 + Math.floor(random() * 1000);
        await line(page, x, SCRIBBLE_Y, x + 200);
        await pickTool(page, 'Draw');
        push({ type: 'noop' });
      }],
      [12, 'undo', async () => {
        if (model.history.length === 0) return false;
        await idle(page);
        await expect(undoBtn(page)).toBeEnabled();
        await undoBtn(page).click();
        const entry = model.history.pop();
        apply(entry, false);
        model.redo.push(entry);
      }],
      [6, 'redo', async () => {
        if (model.redo.length === 0) return false;
        await idle(page);
        await expect(redoBtn(page)).toBeEnabled();
        await redoBtn(page).click();
        const entry = model.redo.pop();
        apply(entry, true);
        model.history.push(entry);
      }],
      [6, 'add frame', async () => {
        const index = (await currentIndex(page)) + 1;
        const frame = { key: String.fromCharCode(65 + model.frames++) };
        await addFrameBtn(page).click();
        await expect(tiles(page)).toHaveCount(model.timeline.length + 1);
        await idle(page);
        frame.id = await currentTileId(page);
        model.timeline.splice(index, 0, frame);
        push({ type: 'frame-add', frame, index });
      }],
      [3, 'delete frame', async () => {
        if (model.timeline.length < 2) return false;
        const index = await currentIndex(page);
        const frame = model.timeline[index];
        await frameMenu(page, 'Delete');
        await expect(tiles(page)).toHaveCount(model.timeline.length - 1);
        model.timeline.splice(index, 1);
        push({ type: 'frame-delete', frame, index });
      }],
      [3, 'drag frame', async () => {
        if (model.timeline.length < 2) return false;
        await idle(page);
        const from = Math.floor(random() * model.timeline.length);
        const to = Math.max(0, Math.min(model.timeline.length - 1, from + pick([-2, -1, 1, 2])));
        if (to === from) return false;
        await tile(page, from + 1).scrollIntoViewIfNeeded();
        const a = await tile(page, from + 1).boundingBox();
        const b = await tile(page, to + 1).boundingBox();
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await page.mouse.down();
        await expect(tile(page, from + 1)).toHaveClass(/is-lifted/);
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
        await page.mouse.up();
        await expect(page.locator('.is-lifted')).toHaveCount(0);
        await idle(page);
        // Where it landed (the strip may have scrolled under it): read it
        // back, and check nothing else changed order.
        const frame = model.timeline[from];
        const ids = await tileIds(page);
        const landed = ids.indexOf(frame.id);
        const rest = model.timeline.filter((f) => f !== frame).map((f) => f.id);
        expect(ids.filter((id) => id !== frame.id), `seed ${seed}: only the dragged frame moves`).toEqual(rest);
        if (landed === from) return false;
        model.timeline.splice(from, 1);
        model.timeline.splice(landed, 0, frame);
        push({ type: 'frame-move', frame, from, to: landed });
      }],
      [2, 'copy drawing', async () => {
        const frame = model.timeline[await currentIndex(page)];
        const layer = await activeLayer(page);
        const spots = model.marks.filter((m) => m.present && m.frame === frame && m.layer === layer).map((m) => m.spot);
        await idle(page);
        await layerMenu(page, 'Copy');
        await setPanel(page, false);
        // A blank layer copies nothing and leaves the clipboard alone.
        if (spots.length > 0) model.clipboard = spots;
      }],
      [3, 'paste drawing', async () => {
        if (!model.clipboard) return false;
        const frame = model.timeline[await currentIndex(page)];
        const layer = await activeLayer(page);
        await idle(page);
        await layerMenu(page, 'Paste');
        await setPanel(page, false);
        const marks = model.clipboard.map((spot) => ({ frame, layer, spot, present: true }));
        model.marks.push(...marks);
        push({ type: 'paste', marks });
      }],
      [12, 'switch frame', async () => {
        if (model.timeline.length < 2) return false;
        const n = 1 + Math.floor(random() * model.timeline.length);
        await idle(page);
        await tile(page, n).click();
        await expect(tile(page, n)).toHaveClass(/is-current/);
      }],
      [6, 'switch layer', async () => {
        if (model.layers.length < 2) return false;
        const id = pick(model.layers);
        if (id === (await activeLayer(page))) return false;
        await setPanel(page, true);
        await page.locator(`.pp-layers__row[data-layer-id="${id}"] .pp-layers__name`).click();
        await expect(page.locator('.pp-layer--active')).toHaveAttribute('data-layer-id', id);
        await setPanel(page, false);
      }],
      [4, 'play and stop', async () => {
        if (model.timeline.length < 2) return false;
        await idle(page);
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
      }],
      [4, 'hide and show', async () => {
        await setVisibility(page, 'hidden');
        await setVisibility(page, 'visible');
      }],
      [3, 'stroke whose save fails', async () => {
        await idle(page);
        await failNextBlobSaves(page, true);
        const ok = await markStroke();
        if (ok) await expect(page.locator('.pp-toast__text')).toContainText("couldn't be saved");
        await failNextBlobSaves(page, false);
        await dismissNotices(page);
      }],
      [3, 'canvas loses its pixels', async () => {
        // The guard ignores tiny drawings on purpose (ink-map.js); a
        // real one covers far more than a few marks.
        const frame = model.timeline[await currentIndex(page)];
        const layer = await activeLayer(page);
        const marks = model.marks.filter((m) => m.present && m.frame === frame && m.layer === layer).length;
        if (marks < 3) return false;
        const before = await savedDrawingBytes(page);
        if (!(await markStroke())) return false;
        await waitForDrawingSave(page, before);
        await settled(page);
        const stuck = random() < 0.5;
        await page.evaluate((keepStuck) => {
          const el = document.querySelector('.pp-layer--active');
          const c = el.getContext('2d');
          c.clearRect(0, 0, el.width, el.height);
          if (keepStuck) {
            c.drawImage = () => {};
            c.putImageData = () => {};
          }
        }, stuck);
        await setVisibility(page, 'hidden');
        await setVisibility(page, 'visible');
        await expect(page.locator('.pp-toast__text')).toContainText('loaded again');
        await dismissNotices(page);
      }],
    ];
    const total = actions.reduce((sum, [w]) => sum + w, 0);

    for (let i = 0; i < STEPS; i++) {
      let r = random() * total;
      const [, name, run] = actions.find(([w]) => (r -= w) < 0);
      const result = await run();
      steps.push(result === false ? `(${name} skipped)` : name);
      await dismissNotices(page);
    }
    test.info().annotations.push({ type: 'steps', description: steps.join(', ') });

    // Every mark, as the model says, on every frame and layer.
    async function verify(where) {
      for (let n = 1; n <= model.timeline.length; n++) {
        const frame = model.timeline[n - 1];
        await idle(page);
        await tile(page, n).click();
        await expect(tile(page, n)).toHaveClass(/is-current/);
        await idle(page);
        // A spot may hold several marks (a paste over the same drawing):
        // painted if any of them is there.
        const spots = new Map();
        for (const mark of model.marks.filter((m) => m.frame === frame && model.layers.includes(m.layer))) {
          const key = `${mark.layer} ${mark.spot.x} ${mark.spot.y}`;
          const known = spots.get(key);
          spots.set(key, { mark, present: Boolean(known?.present) || mark.present });
        }
        for (const { mark, present } of spots.values()) {
          const painted = await paintedOn(page, mark.layer, mark.spot.x + 12, mark.spot.y);
          expect(painted, `${where}: seed ${seed}, frame ${n} (${frame.key}), mark at ${mark.spot.x},${mark.spot.y} should be ${present ? 'there' : 'gone'}. Steps: ${steps.join(', ')}`)
            .toBe(present);
        }
      }
    }

    await expect(tiles(page)).toHaveCount(model.timeline.length);
    await verify('on screen');
    await setVisibility(page, 'hidden');
    await settled(page);
    await reloadApp(page);
    await expect(tiles(page)).toHaveCount(model.timeline.length);
    await verify('after reload');
  });
}
