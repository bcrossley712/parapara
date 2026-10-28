// End-to-end tests for the Share sheet and video export (step 6a): Make
// video → progress → Ready → Share (a download here: the test browser
// has no share sheet), and the file really is the animation — read back
// box by box and decoded frame by frame with the browser's own H.264
// decoder. Plus Cancel, the app going to the background mid-export,
// Share stopping playback, and a browser that can't make videos.
// The muxer and the encode loop's rules are unit-tested
// (tests/unit/mp4.test.js, export.test.js).
//
// Run: npx playwright test export
//
// Not covered here (device-only): Safari's encoder taking these
// settings, the iOS share sheet (Save Video, Messages), the file
// playing in Photos/Messages, how long a long animation takes.

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, setVisibility } from './helpers.js';

const tiles = (page) => page.locator('.pp-frame-strip__tile');
const tile = (page, n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const shareBtn = (page) => page.locator('.pp-share-btn');
const sheet = (page) => page.locator('.pp-export');

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

async function canvasPoint(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

// A short vertical mouse stroke in canvas pixels, gone over a few times
// so it's solid enough to find after video compression.
async function mark(page, x) {
  for (const dx of [-4, 0, 4]) {
    const a = await canvasPoint(page, x + dx, 400);
    const b = await canvasPoint(page, x + dx, 680);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) await page.mouse.move(a.x, a.y + ((b.y - a.y) * i) / 15);
    await page.mouse.up();
  }
}

const MARKS = [300, 960, 1600];

// Three frames, each with one mark at its own x.
async function drawThreeFrames(page) {
  await mark(page, MARKS[0]);
  await addFrame(page);
  await mark(page, MARKS[1]);
  await addFrame(page);
  await mark(page, MARKS[2]);
  await settled(page);
}

// --- reading the MP4 back (independent of js/export/mp4.js) ---

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function boxes(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = start; at < end;) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const entry = { type, start: at, size, body: at + 8 };
    if (CONTAINERS.has(type)) entry.children = boxes(bytes, at + 8, at + size);
    out.push(entry);
    at += size;
  }
  return out;
}

function child(list, path) {
  let node = { children: list };
  for (const type of path.split('/')) node = node.children.find((b) => b.type === type);
  return node;
}

function readVideo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(bytes);
  const stbl = child(top, 'moov/trak/mdia/minf/stbl');
  const mdhd = child(top, 'moov/trak/mdia/mdhd');
  const stsz = stbl.children.find((b) => b.type === 'stsz');
  const stco = stbl.children.find((b) => b.type === 'stco');
  const stts = stbl.children.find((b) => b.type === 'stts');
  const stsd = stbl.children.find((b) => b.type === 'stsd');
  const count = view.getUint32(stsz.body + 8);
  let offset = view.getUint32(stco.body + 8);
  const samples = [];
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(stsz.body + 12 + i * 4);
    samples.push(Array.from(bytes.subarray(offset, offset + size)));
    offset += size;
  }
  const entry = stsd.body + 8; // after version/flags and entry count
  const avcC = entry + 8 + 78;
  const avcCSize = view.getUint32(avcC);
  return {
    order: top.map((b) => b.type),
    timescale: view.getUint32(mdhd.body + 12),
    duration: view.getUint32(mdhd.body + 16),
    sttsRuns: view.getUint32(stts.body + 4),
    sampleDuration: view.getUint32(stts.body + 12),
    codec: String.fromCharCode(...bytes.subarray(entry + 4, entry + 8)),
    width: view.getUint16(entry + 8 + 24),
    height: view.getUint16(entry + 8 + 26),
    description: Array.from(bytes.subarray(avcC + 8, avcC + avcCSize)),
    samples,
  };
}

// Decodes every frame in the page and returns, per frame, the darkest
// red value around each mark's x (paper is ~255, a mark ~0).
function decodeAndSample(page, video) {
  return page.evaluate(async ({ video: v, marks }) => {
    const description = new Uint8Array(v.description);
    const profile = description[1].toString(16).padStart(2, '0');
    const compat = description[2].toString(16).padStart(2, '0');
    const level = description[3].toString(16).padStart(2, '0');
    const frames = [];
    const decoder = new VideoDecoder({
      output: (frame) => frames.push(frame),
      error: (e) => { throw e; },
    });
    decoder.configure({ codec: `avc1.${profile}${compat}${level}`, codedWidth: v.width, codedHeight: v.height, description });
    v.samples.forEach((data, i) => {
      decoder.decode(new EncodedVideoChunk({ type: i === 0 ? 'key' : 'delta', timestamp: i * 1000, data: new Uint8Array(data) }));
    });
    await decoder.flush();
    const canvas = new OffscreenCanvas(v.width, v.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const result = frames.map((frame) => {
      ctx.drawImage(frame, 0, 0);
      frame.close();
      return marks.map((x) => {
        const data = ctx.getImageData(x - 10, 500, 20, 80).data;
        let min = 255;
        for (let i = 0; i < data.length; i += 4) min = Math.min(min, data[i]);
        return min;
      });
    });
    decoder.close();
    return result;
  }, { video, marks: MARKS });
}

test('Make video → Ready → Share gives an MP4 of every frame, as played', async ({ page }) => {
  await openApp(page);
  await drawThreeFrames(page);

  await shareBtn(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toContainText('3 frames');
  await page.getByRole('button', { name: 'Make video' }).click();
  // A failure here shows the sheet's error message in the report.
  await expect(sheet(page)).toHaveAttribute('data-phase', 'ready', { timeout: 30000 });
  await expect(sheet(page)).toContainText('Your video is ready');

  const downloading = page.waitForEvent('download');
  await sheet(page).getByRole('button', { name: 'Share' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Animation 1.mp4');
  const bytes = new Uint8Array(await readFile(await download.path()));

  const video = readVideo(bytes);
  expect(video.order).toEqual(['ftyp', 'moov', 'mdat']); // index first: plays at once
  expect(video.codec).toBe('avc1');
  expect([video.width, video.height]).toEqual([1920, 1080]);
  expect(video.samples).toHaveLength(3);
  expect(video.timescale).toBe(12000); // 12 fps
  expect(video.sttsRuns).toBe(1);
  expect(video.sampleDuration).toBe(1000);
  expect(video.duration).toBe(3000);

  // Frame n shows only mark n.
  const darkest = await decodeAndSample(page, video);
  expect(darkest).toHaveLength(3);
  darkest.forEach((row, frame) => {
    row.forEach((red, m) => {
      if (m === frame) expect(red, `frame ${frame + 1} mark ${m + 1}`).toBeLessThan(100);
      else expect(red, `frame ${frame + 1} mark ${m + 1}`).toBeGreaterThan(200);
    });
  });

  // Done closes it; the editor works again.
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await tile(page, 1).click();
  await expect(tile(page, 1)).toHaveClass(/is-current/);
});

// Holds the encoder's flush until the test lets go, so the sheet stays
// on "Making video".
async function holdEncoder(page) {
  await page.addInitScript(() => {
    let release;
    window.__releaseEncoder = new Promise((resolve) => { release = resolve; });
    window.__letEncoderGo = () => release();
    const flush = VideoEncoder.prototype.flush;
    VideoEncoder.prototype.flush = async function heldFlush() {
      await window.__releaseEncoder;
      return flush.call(this);
    };
  });
}

test('Cancel stops the video and closes the sheet; hiding the app stops it too', async ({ page }) => {
  await holdEncoder(page);
  await openApp(page);
  await drawThreeFrames(page);

  await shareBtn(page).click();
  await page.getByRole('button', { name: 'Make video' }).click();
  await expect(sheet(page)).toContainText('Frame 3 of 3');
  // A tap on the dim area doesn't stop it.
  await page.mouse.click(5, 400);
  await expect(sheet(page)).toHaveAttribute('data-phase', 'making');
  await sheet(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await page.evaluate(() => window.__letEncoderGo());

  // Again, and the app goes to the background.
  await page.evaluate(() => {
    window.__releaseEncoder = new Promise((resolve) => { window.__letEncoderGo = resolve; });
  });
  await shareBtn(page).click();
  await page.getByRole('button', { name: 'Make video' }).click();
  await expect(sheet(page)).toContainText('Frame 3 of 3');
  await setVisibility(page, 'hidden');
  await page.evaluate(() => window.__letEncoderGo());
  await setVisibility(page, 'visible');
  await expect(sheet(page)).toHaveAttribute('data-phase', 'error');
  await expect(sheet(page)).toContainText('went into the background');
  // Try again makes it.
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page)).toHaveAttribute('data-phase', 'ready', { timeout: 30000 });
});

test('Share stops playback first', async ({ page }) => {
  await openApp(page);
  await drawThreeFrames(page);
  await page.locator('.pp-transport__play').click();
  await expect(page.locator('.pp-playback')).toBeVisible();
  await shareBtn(page).click();
  await expect(page.locator('.pp-playback')).toHaveCount(0);
  await expect(sheet(page)).toHaveAttribute('data-phase', 'start');
});

test('a browser that can’t make videos says so instead of offering it', async ({ page }) => {
  await page.addInitScript(() => { delete window.VideoEncoder; });
  await openApp(page);
  await shareBtn(page).click();
  await expect(sheet(page)).toContainText('can’t make videos');
  await expect(page.getByRole('button', { name: 'Make video' })).toHaveCount(0);
  await page.mouse.click(5, 400); // the dim area closes it
  await expect(sheet(page)).toHaveCount(0);
});
