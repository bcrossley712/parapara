// The 6b real-file check: an MP4 with sound, made by the app with real
// AAC frames, read back by ffprobe/ffmpeg — the only test where a real
// player reads our audio track (sample entry, esds, edit list).
//
// No test browser has an AAC encoder, so a stand-in AudioEncoder hands
// the app real AAC frames made here with ffmpeg: the first encoder the
// app opens (the priming probe, aac.js measurePriming) gets a stream of
// the probe's signal, the second (the mix) a stream with a tone at
// TONE_MS. ffmpeg's own AAC encoder puts 1024 samples of priming first,
// as a real one does. The real H.264 encoder makes the pictures, and
// Chromium's real AAC decoder runs the probe with our config.
//
// What it proves: the file layout and timing — both tracks the video's
// length, the priming measured, the sound starting where it was placed
// once a player honors the edit list. Not the mix itself (ffmpeg's tone
// stands in for it): that's tests/unit/offline-mix.test.js and her ears.
//
// Skips, saying why, without ffmpeg/ffprobe, an H.264 encoder or an AAC
// decoder — so it skips in CI (expected) and runs in the sandbox. **Run
// it before any hand-off that touches js/export/mp4.js, aac.js or
// js/audio/offline-mix.js.**
//
// Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test export-real-aac

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { openApp } from './helpers.js';

const RATE = 48000;
const FPS = 12;
const FRAMES = 3;
const VIDEO_SECONDS = FRAMES / FPS; // 0.25
const TONE_MS = 100;
const FFMPEG_PRIMING = 1024;
// The app's probe (aac.js): PROBE_AT samples of silence, then a 1 kHz
// burst at 0.5, PROBE_AT more samples long.
const PROBE_AT = 8192;
const PROBE_LENGTH = PROBE_AT * 2;

function hasTool(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// Real AAC-LC (stereo, 48 kHz, 128 kbps) as ADTS, from a sample
// expression `expr` lasting `samples` samples.
function makeAAC(path, expr, samples) {
  ffmpeg([
    '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=${RATE}:d=${samples / RATE}`,
    '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', path,
  ]);
}

// ADTS stream → each frame's bytes (header included; the app strips it).
function adtsFrames(bytes) {
  const frames = [];
  for (let at = 0; at < bytes.length;) {
    const length = ((bytes[at + 3] & 3) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5);
    if (!(length > 7)) throw new Error(`bad ADTS frame at ${at}`);
    frames.push(Array.from(bytes.subarray(at, at + length)));
    at += length;
  }
  return frames;
}

// The stand-in AudioEncoder: encode() just counts; flush() hands back
// the next stream's real frames (probe first, then the mix), with a
// junk decoder config like WebKit's (the app must ignore it).
async function useRealAACFrames(page, streams) {
  await page.addInitScript((list) => {
    window.__aacOpened = 0;
    class RealFramesEncoder {
      static async isConfigSupported(config) {
        return { supported: config.codec === 'mp4a.40.2' && config.sampleRate === 48000, config };
      }

      constructor({ output }) {
        this.output = output;
        this.state = 'unconfigured';
        this.encodeQueueSize = 0;
        this.frames = list[Math.min(window.__aacOpened++, list.length - 1)];
      }

      configure() { this.state = 'configured'; }

      encode() {}

      async flush() {
        this.frames.forEach((frame, i) => {
          const bytes = new Uint8Array(frame);
          this.output(
            { byteLength: bytes.length, copyTo: (target) => target.set(bytes) },
            i === 0 ? { decoderConfig: { description: new Uint8Array([0xde, 0xad]) } } : {},
          );
        });
      }

      close() { this.state = 'closed'; }
    }
    window.AudioEncoder = RealFramesEncoder;
  }, streams);
}

// A mono 16-bit WAV, so the project has sound (its content is replaced
// by the mix stream; only that a track gets made matters).
function wav(seconds = 1, rate = 8000) {
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
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(i / 3)), 44 + i * 2);
  return buf;
}

async function canvasPoint(page, x, y) {
  const box = await page.locator('.pp-canvas').boundingBox();
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

async function drawFrames(page) {
  const addFrame = page.getByRole('button', { name: 'Add frame' });
  for (let f = 0; f < FRAMES; f++) {
    if (f > 0) {
      await expect(addFrame).toBeEnabled();
      await addFrame.click();
      await expect(page.locator('.pp-frame-strip__tile')).toHaveCount(f + 1);
    }
    await expect(addFrame).toBeEnabled();
    const a = await canvasPoint(page, 300 + f * 600, 400);
    const b = await canvasPoint(page, 300 + f * 600, 700);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
  }
  await expect(addFrame).toBeEnabled();
}

async function importSound(page) {
  const soundBtn = page.locator('.pp-sound-btn');
  await expect(soundBtn).toBeEnabled();
  await soundBtn.click();
  const importBtn = page.locator('.pp-sound-panel').getByRole('button', { name: /^(Import|Replace) sound$/ });
  await expect(importBtn).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await importBtn.click();
  await (await chooser).setFiles({ name: 'tone.wav', mimeType: 'audio/wav', buffer: wav() });
  await expect(soundBtn).toHaveClass(/has-sound/);
  await soundBtn.click(); // close the panel
}

test('a real AAC track: ffprobe reads both tracks, and the sound starts where it was placed', async ({ page }, testInfo) => {
  test.skip(!hasTool('ffmpeg') || !hasTool('ffprobe'), 'No ffmpeg/ffprobe here (expected in CI) — run in the sandbox');

  // The two real streams: the probe's signal, and a tone at TONE_MS
  // lasting the video's length.
  const probePath = testInfo.outputPath('probe.aac');
  const mixPath = testInfo.outputPath('mix.aac');
  makeAAC(probePath, `if(gte(n\\,${PROBE_AT})\\,0.5*sin(2*PI*1000*(n-${PROBE_AT})/${RATE})\\,0)`, PROBE_LENGTH);
  const toneAt = Math.round((TONE_MS / 1000) * RATE);
  makeAAC(mixPath, `if(gte(n\\,${toneAt})\\,0.49*sin(2*PI*440*(n-${toneAt})/${RATE})\\,0)`, Math.round(VIDEO_SECONDS * RATE));
  const streams = [adtsFrames(await readFile(probePath)), adtsFrames(await readFile(mixPath))];

  // The stand-in goes in before the app loads.
  await useRealAACFrames(page, streams);
  await openApp(page);
  const can = await page.evaluate(async () => {
    const no = { supported: false };
    const h264 = typeof VideoEncoder === 'function'
      ? await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 6e6, framerate: 12, avc: { format: 'avc' } }).catch(() => no)
      : no;
    const aac = typeof AudioDecoder === 'function'
      ? await AudioDecoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) }).catch(() => no)
      : no;
    return { h264: h264.supported, aac: aac.supported };
  });
  test.skip(!can.h264, 'No H.264 encoder in this browser (expected in CI) — run in the sandbox');
  test.skip(!can.aac, 'No AAC decoder in this browser — the priming probe can’t be measured');

  await drawFrames(page);
  await importSound(page);

  const sheet = page.locator('.pp-export');
  await page.locator('.pp-share-btn').click();
  await page.getByRole('button', { name: 'Make video' }).click();
  await expect(sheet).toHaveAttribute('data-phase', 'ready', { timeout: 30000 });
  await expect(sheet).not.toContainText('silent');
  const downloading = page.waitForEvent('download');
  await sheet.getByRole('button', { name: 'Share' }).click();
  const filePath = testInfo.outputPath('out.mp4');
  await (await downloading).saveAs(filePath);

  // The probe was measured: ffmpeg's priming, within a sample.
  expect(await page.evaluate(() => window.__aacOpened)).toBe(2);
  let logLine = '';
  await expect.poll(async () => {
    const log = await page.evaluate(() => localStorage.getItem('parapara-dev-log') ?? '');
    logLine = log.match(/export-audio [^"]*/)?.[0] ?? '';
    return logLine;
  }).toContain('priming=');
  const priming = Number(logLine.match(/priming=(\d+)/)?.[1]);
  expect(Math.abs(priming - FFMPEG_PRIMING), logLine).toBeLessThanOrEqual(1);
  expect(logLine).toContain('config=1190');
  expect(logLine).toContain('encoderConfig=dead'); // logged, not used

  // ffprobe: both tracks, each the video's length.
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,duration',
    '-show_entries', 'format=duration', '-of', 'json', filePath,
  ]).toString());
  const byCodec = Object.fromEntries(probe.streams.map((s) => [s.codec_name, s]));
  expect(Object.keys(byCodec).sort()).toEqual(['aac', 'h264']);
  expect(Number(byCodec.h264.duration)).toBeCloseTo(VIDEO_SECONDS, 3);
  expect(Number(byCodec.aac.duration)).toBeCloseTo(VIDEO_SECONDS, 3);
  expect(Number(byCodec.aac.sample_rate)).toBe(RATE);
  expect(byCodec.aac.channels).toBe(2);
  expect(Number(probe.format.duration)).toBeCloseTo(VIDEO_SECONDS, 3);

  // ffmpeg decodes it all without errors, honoring the edit list: the
  // tone starts at TONE_MS, not TONE_MS + the priming (~121 ms).
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', filePath, '-f', 'null', '-']);
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', filePath, '-map', '0:a', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  const onset = samples.findIndex((v) => Math.abs(v) > 0.05);
  expect(onset).toBeGreaterThan(0);
  const onsetMs = (onset / RATE) * 1000;
  expect(Math.abs(onsetMs - TONE_MS), `tone heard at ${onsetMs.toFixed(2)} ms`).toBeLessThanOrEqual(1);
});
