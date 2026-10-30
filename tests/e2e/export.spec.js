// End-to-end tests for the Share sheet and video export (steps 6a–6b): Make
// video → progress → Ready → Share (a download here: the test browser
// has no share sheet), and the file really is the animation — read back
// box by box (with a stand-in encoder, in every browser) and, where the
// browser has H.264, decoded frame by frame with its own decoder. Plus Cancel, the app going to the background mid-export,
// Share stopping playback, and a browser that can't make videos. 6b:
// the sound track — mixed, placed and trimmed by its edit list so the
// sound starts with frame 1 (stand-in AAC codec: no browser here has an
// AAC encoder), and a silent video with a note when sound can't be made.
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
import { openApp, reloadApp, readDb, setVisibility } from './helpers.js';

const tiles = (page) => page.locator('.pp-frame-strip__tile');
const tile = (page, n) => page.getByRole('button', { name: `Frame ${n}`, exact: true });
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const shareBtn = (page) => page.locator('.pp-share-btn');
const sheet = (page) => page.locator('.pp-export');
const includeImages = (page) => page.getByRole('switch', { name: 'Include images' });

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

const CONTAINERS = new Set(['moov', 'trak', 'edts', 'mdia', 'minf', 'stbl']);

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

// The sound track (6b), read back: its sample entry, our
// AudioSpecificConfig, the edit, and each sample's bytes. null if
// there's no second track.
function readSound(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const traks = boxes(bytes).find((b) => b.type === 'moov').children.filter((b) => b.type === 'trak');
  if (traks.length < 2) return null;
  const trak = { children: traks[1].children };
  const stbl = child(trak.children, 'mdia/minf/stbl');
  const mdhd = child(trak.children, 'mdia/mdhd');
  const elst = child(trak.children, 'edts/elst');
  const stsz = stbl.children.find((b) => b.type === 'stsz');
  const stco = stbl.children.find((b) => b.type === 'stco');
  const stsd = stbl.children.find((b) => b.type === 'stsd');
  const entry = stsd.body + 8;
  const entryEnd = entry + view.getUint32(entry);
  const count = view.getUint32(stsz.body + 8);
  let offset = view.getUint32(stco.body + 8);
  const samples = [];
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(stsz.body + 12 + i * 4);
    samples.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  // DecoderSpecificInfo: tag 5, then a one-byte length, then the config.
  let config = null;
  for (let at = entry; at < entryEnd - 2; at++) {
    if (bytes[at] === 5 && bytes[at + 1] === 2 && bytes[at - 1] !== 5) config = Array.from(bytes.subarray(at + 2, at + 4));
  }
  return {
    codec: String.fromCharCode(...bytes.subarray(entry + 4, entry + 8)),
    timescale: view.getUint32(mdhd.body + 12),
    config,
    editMs: view.getUint32(elst.body + 8),
    editStart: view.getUint32(elst.body + 12),
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

// A stand-in VideoEncoder, so the sheet and the file's layout are
// tested in every browser — CI's pinned Chromium has the WebCodecs API
// but no H.264 encoder. Each "encoded" frame is 4 bytes, the frame's
// number, so the file can be read box by box (not played). `held`:
// flush waits for window.__letEncoderGo(), holding the sheet on
// "Making video". `sample` ({ x, y }, canvas pixels): each frame's
// color there goes in window.__sampled as [r, g, b], so what's in the
// picture is checked without H.264 (6d's Include images). The real
// encoder is tested below where it exists.
async function useStandInEncoder(page, { held = false, sample = null } = {}) {
  await page.addInitScript(({ hold, point }) => {
    window.__releaseEncoder = hold
      ? new Promise((resolve) => { window.__letEncoderGo = resolve; })
      : Promise.resolve();
    window.__sampled = [];
    class StandInEncoder {
      static async isConfigSupported(config) {
        return { supported: config.codec.startsWith('avc1.'), config };
      }

      constructor({ output }) {
        this.output = output;
        this.state = 'unconfigured';
        this.encodeQueueSize = 0;
        this.count = 0;
      }

      configure() { this.state = 'configured'; }

      encode(frame, { keyFrame }) {
        const index = this.count++;
        if (point) {
          const probe = new OffscreenCanvas(1, 1).getContext('2d');
          probe.drawImage(frame, point.x, point.y, 1, 1, 0, 0, 1, 1);
          window.__sampled.push(Array.from(probe.getImageData(0, 0, 1, 1).data.slice(0, 3)));
        }
        const timestamp = frame.timestamp;
        const meta = index === 0 ? { decoderConfig: { description: new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0]) } } : {};
        queueMicrotask(() => this.output({
          timestamp,
          type: keyFrame ? 'key' : 'delta',
          byteLength: 4,
          copyTo: (target) => new DataView(target.buffer, target.byteOffset).setUint32(0, index),
        }, meta));
      }

      async flush() { await window.__releaseEncoder; }

      close() { this.state = 'closed'; }
    }
    window.VideoEncoder = StandInEncoder;
  }, { hold: held, point: sample });
}

// A stand-in AAC codec (6b): no browser here has an AAC encoder (CI's
// and the sandbox's Chromium). The encoder passes channel 0 through —
// `priming` zeros first, then 1024-sample "frames" of raw floats — and
// reports a junk config, like WebKit's; the decoder gives the floats
// back, so the app's priming probe measures `priming`.
async function useStandInAudio(page, { priming = 1024 } = {}) {
  await page.addInitScript((primingSamples) => {
    class StandInAudioEncoder {
      static async isConfigSupported(config) {
        return { supported: config.codec === 'mp4a.40.2' && config.sampleRate === 48000, config };
      }

      constructor({ output }) {
        this.output = output;
        this.state = 'unconfigured';
        this.encodeQueueSize = 0;
        this.pending = [];
        this.sentConfig = false;
      }

      configure() {
        this.state = 'configured';
        this.pending = new Array(primingSamples).fill(0);
      }

      encode(data) {
        const block = new Float32Array(data.numberOfFrames);
        data.copyTo(block, { planeIndex: 0 });
        for (const v of block) this.pending.push(v);
        this.emit(false);
      }

      emit(final) {
        while (this.pending.length >= 1024 || (final && this.pending.length > 0)) {
          const frame = new Float32Array(1024);
          frame.set(this.pending.splice(0, 1024));
          const bytes = new Uint8Array(frame.buffer);
          const meta = this.sentConfig ? {} : { decoderConfig: { description: new Uint8Array([0xde, 0xad]) } };
          this.sentConfig = true;
          this.output({ byteLength: bytes.length, copyTo: (t) => t.set(bytes) }, meta);
        }
      }

      async flush() { this.emit(true); }

      close() { this.state = 'closed'; }
    }

    class StandInAudioDecoder {
      constructor({ output }) { this.output = output; this.state = 'unconfigured'; }

      configure(config) { window.__decoderConfig = Array.from(new Uint8Array(config.description)); this.state = 'configured'; }

      decode(chunk) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        const floats = new Float32Array(bytes.buffer);
        this.output({
          numberOfFrames: floats.length,
          numberOfChannels: 2,
          format: 'f32-planar',
          copyTo: (target) => target.set(floats),
          close() {},
        });
      }

      async flush() {}

      close() { this.state = 'closed'; }
    }
    window.AudioEncoder = StandInAudioEncoder;
    window.AudioDecoder = StandInAudioDecoder;
  }, priming);
}

// A mono 16-bit WAV at 8 kHz: `silence` seconds of nothing, then a
// 440 Hz tone at about -6 dB to `seconds`.
function wav(seconds, silence = 0, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  const start = Math.round(silence * rate);
  for (let i = start; i < samples; i++) {
    buf.writeInt16LE(Math.round(16000 * Math.sin((2 * Math.PI * 440 * (i - start)) / rate)), 44 + i * 2);
  }
  return buf;
}

async function importSound(page, buffer) {
  const soundBtn = page.locator('.pp-sound-btn');
  await expect(soundBtn).toBeEnabled();
  await soundBtn.click();
  const importBtn = page.locator('.pp-sound-panel').getByRole('button', { name: /^(Import|Replace) sound$/ });
  await expect(importBtn).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await importBtn.click();
  await (await chooser).setFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer });
  await expect(soundBtn).toHaveClass(/has-sound/);
  await soundBtn.click(); // close the panel
}

async function makeVideo(page) {
  await shareBtn(page).click();
  await expect(sheet(page)).toBeVisible();
  await page.getByRole('button', { name: 'Make video' }).click();
  // A failure here shows the sheet's error message in the report.
  await expect(sheet(page)).toHaveAttribute('data-phase', 'ready', { timeout: 30000 });
  await expect(sheet(page)).toContainText('Your video is ready');
}

async function shareAndDownload(page) {
  const downloading = page.waitForEvent('download');
  await sheet(page).getByRole('button', { name: 'Share' }).click();
  const download = await downloading;
  return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(await download.path())) };
}

test('Make video → Ready → Share gives an MP4 with every frame in order, at the project fps', async ({ page }) => {
  await useStandInEncoder(page);
  await openApp(page);
  await drawThreeFrames(page);

  await shareBtn(page).click();
  await expect(sheet(page)).toContainText('3 frames');
  await expect(includeImages(page)).toBeHidden(); // no photo, no switch (6d)
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await makeVideo(page);
  const { name, bytes } = await shareAndDownload(page);
  expect(name).toBe('Animation 1.mp4');

  const video = readVideo(bytes);
  expect(video.order).toEqual(['ftyp', 'moov', 'mdat']); // index first: plays at once
  expect(video.codec).toBe('avc1');
  expect([video.width, video.height]).toEqual([1920, 1080]);
  expect(video.description).toEqual([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0]);
  // The stand-in's bytes are each frame's number: all there, in order.
  expect(video.samples).toEqual([[0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 0, 2]]);
  expect(video.timescale).toBe(12000); // 12 fps
  expect(video.sttsRuns).toBe(1);
  expect(video.sampleDuration).toBe(1000);
  expect(video.duration).toBe(3000);

  // Done closes it; the editor works again.
  await sheet(page).getByRole('button', { name: 'Done' }).click();
  await expect(sheet(page)).toHaveCount(0);
  await tile(page, 1).click();
  await expect(tile(page, 1)).toHaveClass(/is-current/);
});

test('Cancel stops the video and closes the sheet; hiding the app stops it too', async ({ page }) => {
  await useStandInEncoder(page, { held: true });
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
  await page.evaluate(() => { window.__releaseEncoder = Promise.resolve(); });
  await sheet(page).getByRole('button', { name: 'Try again' }).click();
  await expect(sheet(page)).toHaveAttribute('data-phase', 'ready', { timeout: 30000 });
});

// The real encoder, where the browser has one: decode the file frame by
// frame and check each frame shows its own mark. Skipped, saying why,
// where there's no H.264 encoder (CI's pinned Chromium); the sandbox's
// browser has one, so it runs before every hand-off.
test('with a real H.264 encoder, each video frame shows that frame’s drawing', async ({ page }) => {
  await openApp(page);
  const canEncode = await page.evaluate(async () => {
    if (typeof VideoEncoder !== 'function' || typeof VideoDecoder !== 'function') return false;
    const encode = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 6e6, framerate: 12, avc: { format: 'avc' } })
      .catch(() => ({ supported: false }));
    const decode = await VideoDecoder.isConfigSupported({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080 })
      .catch(() => ({ supported: false }));
    return encode.supported && decode.supported;
  });
  test.skip(!canEncode, 'No H.264 encoder/decoder in this browser (expected in CI) — run in the sandbox');

  await drawThreeFrames(page);
  await makeVideo(page);
  const { bytes } = await shareAndDownload(page);
  const video = readVideo(bytes);
  expect(video.samples).toHaveLength(3);

  const darkest = await decodeAndSample(page, video);
  expect(darkest).toHaveLength(3);
  darkest.forEach((row, frame) => {
    row.forEach((red, m) => {
      if (m === frame) expect(red, `frame ${frame + 1} mark ${m + 1}`).toBeLessThan(100);
      else expect(red, `frame ${frame + 1} mark ${m + 1}`).toBeGreaterThan(200);
    });
  });
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

test('with sound: an AAC track, our config, the priming skipped — the sound starts with frame 1', async ({ page }) => {
  await useStandInEncoder(page);
  await useStandInAudio(page, { priming: 1024 });
  await openApp(page);
  await drawThreeFrames(page); // 3 frames at 12 fps = 250 ms
  await importSound(page, wav(1, 0.1)); // tone from 100 ms

  await shareBtn(page).click();
  await expect(sheet(page)).toContainText('with its sound');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await makeVideo(page);
  await expect(sheet(page)).not.toContainText('silent');
  const { bytes } = await shareAndDownload(page);

  expect(readVideo(bytes).samples).toHaveLength(3);
  const sound = readSound(bytes);
  expect(sound).not.toBeNull();
  expect(sound.codec).toBe('mp4a');
  expect(sound.timescale).toBe(48000);
  expect(sound.config).toEqual([0x11, 0x90]); // ours, not the encoder's 'dead'
  expect(await page.evaluate(() => window.__decoderConfig)).toEqual([0x11, 0x90]); // the probe decoded with ours
  // The edit: from the measured priming, as long as the video.
  expect(sound.editStart).toBe(1024);
  expect(sound.editMs).toBe(250);

  // The stand-in's samples are channel 0's floats: find the tone.
  const floats = [];
  for (const s of sound.samples) floats.push(...new Float32Array(s.buffer, s.byteOffset, s.byteLength / 4));
  const onset = floats.findIndex((v) => Math.abs(v) > 0.05);
  expect(onset).toBeGreaterThan(0);
  // Presented time = (index − edit start) / rate: the tone at 100 ms,
  // plus the limiter's lookahead (a DynamicsCompressorNode delays ~6 ms
  // — Play goes through the same limiter, so it's what she hears).
  const presentedMs = ((onset - sound.editStart) / 48000) * 1000;
  expect(presentedMs).toBeGreaterThan(99);
  expect(presentedMs).toBeLessThan(110);
  // The skipped part is the encoder's silence, not her sound.
  expect(floats.slice(0, sound.editStart).every((v) => v === 0)).toBe(true);
});

test('with sound but no AAC encoder: a silent video, and the sheet says so', async ({ page }) => {
  await useStandInEncoder(page);
  await page.addInitScript(() => { delete window.AudioEncoder; });
  await openApp(page);
  await drawThreeFrames(page);
  await importSound(page, wav(1));

  await makeVideo(page);
  await expect(sheet(page)).toContainText('the sound couldn’t be added');
  const { bytes } = await shareAndDownload(page);
  expect(readVideo(bytes).samples).toHaveLength(3);
  expect(readSound(bytes)).toBeNull();
});

// --- 6d: Include images ---

// A 200×100 all-red PNG. Fit to the canvas it covers y 60–1020; a new
// photo shows at 50%, so its pixels read about (255, 128, 128).
async function redPhoto(page) {
  const base64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 200, 100);
    return c.toDataURL('image/png').split(',')[1];
  });
  return { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

async function addPhoto(page) {
  await settled(page);
  await page.locator('.pp-image-btn').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Add image' }).click();
  await (await chooser).setFiles(await redPhoto(page));
  const bar = page.locator('.pp-reference-bar');
  await expect(bar).toBeVisible();
  await expect(page.locator('.pp-reference__image')).toHaveCount(1);
  await settled(page);
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toHaveCount(0);
  await settled(page);
}

// The video's one frame at the sample point: true if the photo's red
// is there, false if it's white paper.
async function photoInVideo(page) {
  await page.evaluate(() => { window.__sampled = []; });
  await sheet(page).getByRole('button', { name: 'Make video' }).click();
  await expect(sheet(page)).toHaveAttribute('data-phase', 'ready', { timeout: 30000 });
  const sampled = await page.evaluate(() => window.__sampled);
  expect(sampled).toHaveLength(1);
  const [r, g, b] = sampled[0];
  expect(r).toBeGreaterThan(240);
  if (g > 240 && b > 240) return false;
  expect(g).toBeLessThan(200);
  return true;
}

test('Include images: off to start, separate from Hide images, remembered by the project', async ({ page }) => {
  await useStandInEncoder(page, { sample: { x: 100, y: 540 } });
  await openApp(page);
  await addPhoto(page);

  // Off to start: the photo she sees stays out of the video.
  await shareBtn(page).click();
  await expect(includeImages(page)).toBeVisible();
  await expect(includeImages(page)).toHaveAttribute('aria-checked', 'false');
  expect(await photoInVideo(page)).toBe(false);
  await sheet(page).getByRole('button', { name: 'Done' }).click();

  // On: the photo goes in, and the project remembers it.
  await shareBtn(page).click();
  await includeImages(page).click();
  await expect(includeImages(page)).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await readDb(page, 'projects'))[0]?.exportImages).toBe(true);
  expect(await photoInVideo(page)).toBe(true);
  await sheet(page).getByRole('button', { name: 'Done' }).click();

  // Hide images (what she sees) doesn't change it.
  await settled(page);
  await page.locator('.pp-image-btn').click();
  await page.getByRole('menuitem', { name: 'Hide images' }).click();
  await expect(page.locator('.pp-image-menu')).toHaveCount(0);
  await expect.poll(async () => (await readDb(page, 'projects'))[0]?.referenceHidden).toBe(true);
  await shareBtn(page).click();
  await expect(includeImages(page)).toHaveAttribute('aria-checked', 'true');
  expect(await photoInVideo(page)).toBe(true);
  await sheet(page).getByRole('button', { name: 'Done' }).click();

  // Still on after a relaunch.
  await reloadApp(page);
  await settled(page);
  await shareBtn(page).click();
  await expect(includeImages(page)).toHaveAttribute('aria-checked', 'true');
});
