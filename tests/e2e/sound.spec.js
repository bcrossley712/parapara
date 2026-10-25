// End-to-end tests for step 5a: importing a sound, saving it, delete
// with undo/redo, and playback running on the sound. The sound file is
// a WAV made here and fed through the real file chooser, so the actual
// picker path runs. AudioBufferSourceNode.start is wrapped to see what
// the audio clock schedules.
//
// Not covered here (device-only): sync by ear, Safari's output delay,
// which files the iPad's picker offers, Silent mode.

import { test, expect } from '@playwright/test';
import { openApp, reloadApp, readDb } from './helpers.js';

const soundBtn = (page) => page.locator('.pp-sound-btn');
const banner = (page) => page.locator('#pp-banner');
const toast = (page) => page.locator('.pp-toast');
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const tiles = (page) => page.locator('.pp-frame-strip__tile');
const playBtn = (page) => page.locator('.pp-transport__play');
const undoBtn = (page) => page.getByRole('button', { name: 'Undo', exact: true });
const redoBtn = (page) => page.getByRole('button', { name: 'Redo', exact: true });

// A mono 16-bit PCM WAV: `seconds` of a quiet 440 Hz tone.
function wav(seconds = 1, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);       // PCM
  buf.writeUInt16LE(1, 22);       // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  }
  return buf;
}

// Records every scheduled sound: [when, offset, duration] relative to
// the context's clock at the time, rounded.
async function watchSound(page) {
  await page.addInitScript(() => {
    window.__soundStarts = [];
    const real = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration) {
      window.__soundStarts.push({ offset: Math.round(offset * 1000) / 1000, duration: Math.round((duration ?? 0) * 1000) / 1000 });
      return real.call(this, when, offset, duration);
    };
  });
}

async function pickSound(page, { name = 'tone.wav', mimeType = 'audio/wav', buffer = wav() } = {}) {
  await expect(soundBtn(page)).toBeEnabled();
  await soundBtn(page).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /^(Import|Replace) sound$/ }).click();
  await (await chooser).setFiles({ name, mimeType, buffer });
}

async function importSound(page, options) {
  await pickSound(page, options);
  await expect(banner(page)).toContainText('Sound added');
  await expect(soundBtn(page)).toHaveClass(/has-sound/);
}

const savedProject = async (page) => (await readDb(page, 'projects'))[0];

// The saved project's clip once its (debounced) save has landed —
// or, with `not`, once it's a different one than that.
async function savedClip(page, { not = undefined } = {}) {
  await expect.poll(async () => {
    const clip = (await savedProject(page))?.audioClips?.[0];
    return clip && clip.blobRef !== not?.blobRef ? clip.blobRef : null;
  }).not.toBe(null);
  return (await savedProject(page)).audioClips[0];
}

// A stored blob's type and bytes (ArrayBuffers don't survive
// page.evaluate, so they come back as a plain array).
function storedBlob(page, id) {
  return page.evaluate((key) => new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const r = db.transaction('blobs').objectStore('blobs').get(key);
      r.onsuccess = () => {
        db.close();
        const rec = r.result;
        resolve(rec ? { type: rec.type, bytes: Array.from(new Uint8Array(rec.buffer)) } : null);
      };
      r.onerror = () => { db.close(); reject(r.error); };
    };
  }), id);
}

async function addFrame(page) {
  await expect(addFrameBtn(page)).toBeEnabled();
  const before = await tiles(page).count();
  await addFrameBtn(page).click();
  await expect(tiles(page)).toHaveCount(before + 1);
  await expect(addFrameBtn(page)).toBeEnabled();
}

test('an imported sound is stored byte for byte, with its type, and kept on reload', async ({ page }) => {
  await openApp(page);
  await expect(soundBtn(page)).not.toHaveClass(/has-sound/);
  const bytes = wav(1);
  await importSound(page, { buffer: bytes });

  const clip = await savedClip(page);
  expect(clip.trimStart).toBe(0);
  expect(clip.trimEnd).toBeCloseTo(1, 2);
  expect(clip.offset).toBe(0);
  const blob = await storedBlob(page, clip.blobRef);
  expect(blob.type).toBe('audio/wav');
  expect(Buffer.from(blob.bytes).equals(bytes)).toBe(true);

  // Reopening runs the sweep: a sound a clip points at survives it.
  await reloadApp(page);
  await expect(soundBtn(page)).toHaveClass(/has-sound/);
  expect(await storedBlob(page, clip.blobRef)).not.toBe(null);
});

test('delete sound is undoable; the file stays for undo', async ({ page }) => {
  await openApp(page);
  await importSound(page);
  const clip = await savedClip(page);

  await soundBtn(page).click();
  await page.getByRole('menuitem', { name: 'Delete sound' }).click();
  await expect(soundBtn(page)).not.toHaveClass(/has-sound/);
  await expect.poll(async () => (await savedProject(page)).audioClips.length).toBe(0);
  expect(await storedBlob(page, clip.blobRef)).not.toBe(null);

  await undoBtn(page).click();
  await expect(soundBtn(page)).toHaveClass(/has-sound/);
  await expect.poll(async () => (await savedProject(page)).audioClips[0]?.blobRef).toBe(clip.blobRef);

  await redoBtn(page).click();
  await expect(soundBtn(page)).not.toHaveClass(/has-sound/);
  // Undoing the import itself takes the sound away too.
  await undoBtn(page).click();
  await undoBtn(page).click();
  await expect(soundBtn(page)).not.toHaveClass(/has-sound/);
});

test('Replace sound swaps the clip as one undo step', async ({ page }) => {
  await openApp(page);
  await importSound(page, { buffer: wav(1) });
  const first = await savedClip(page);
  await importSound(page, { name: 'longer.wav', buffer: wav(2) });
  const second = await savedClip(page, { not: first });
  expect(second.trimEnd).toBeCloseTo(2, 2);

  await undoBtn(page).click();
  await expect.poll(async () => (await savedProject(page)).audioClips[0]?.blobRef).toBe(first.blobRef);
});

test('a file that isn\'t sound is refused, and nothing is stored', async ({ page }) => {
  await openApp(page);
  await pickSound(page, { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not really a song at all') });
  await expect(toast(page)).toContainText("couldn't be opened");
  await expect(soundBtn(page)).not.toHaveClass(/has-sound/);
  const blobs = await readDb(page, 'blobs');
  expect(blobs.filter((b) => b.type.startsWith('audio/') || b.type === 'application/octet-stream')).toEqual([]);
});

test('a file over 20 MB is refused before it is read', async ({ page }) => {
  await openApp(page);
  await pickSound(page, { buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
  await expect(banner(page)).toContainText('too big');
  await expect(soundBtn(page)).not.toHaveClass(/has-sound/);
});

test('duplicate project copies the sound to its own file', async ({ page }) => {
  await openApp(page);
  await importSound(page);
  const original = await savedClip(page);

  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.getByRole('button', { name: 'More for Animation 1' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await page.getByRole('button', { name: 'Open Animation 1 copy' }).click();
  await page.locator('.pp-canvas').waitFor();
  await expect(soundBtn(page)).toHaveClass(/has-sound/);

  const projects = await readDb(page, 'projects');
  const copy = projects.find((p) => p.name === 'Animation 1 copy');
  expect(copy.audioClips[0].blobRef).not.toBe(original.blobRef);
  const a = await storedBlob(page, original.blobRef);
  const b = await storedBlob(page, copy.audioClips[0].blobRef);
  expect(b.bytes).toEqual(a.bytes);
  expect(b.type).toBe('audio/wav');
});

test('playback runs on the sound, starting it at the frame she plays from', async ({ page }) => {
  await watchSound(page);
  await openApp(page);
  await addFrame(page);
  await addFrame(page); // on frame 3 of 3
  await importSound(page, { buffer: wav(1) });

  await playBtn(page).click();
  await expect(page.locator('.pp-playback')).toBeVisible();
  // 3 frames at 12 fps = 0.25 s; starting on frame 3 (index 2) is
  // 2/12 s in, so the rest of this pass is the clip's 0.167–0.25 s.
  await expect.poll(() => page.evaluate(() => window.__soundStarts.length)).toBeGreaterThan(0);
  const [first] = await page.evaluate(() => window.__soundStarts);
  expect(first.offset).toBeCloseTo(2 / 12, 2);
  expect(first.duration).toBeCloseTo(0.25 - 2 / 12, 2);
  // With loop on, whole passes follow, each the clip's first 0.25 s.
  await expect.poll(() => page.evaluate(() => window.__soundStarts.length)).toBeGreaterThan(2);
  const later = (await page.evaluate(() => window.__soundStarts)).slice(1, 3);
  for (const pass of later) {
    expect(pass.offset).toBeLessThan(0.05);
    expect(pass.offset + pass.duration).toBeCloseTo(0.25, 2);
  }
  await playBtn(page).click();
});

test('without sound, playback schedules no sound at all', async ({ page }) => {
  await watchSound(page);
  await openApp(page);
  await addFrame(page);
  await playBtn(page).click();
  await expect(page.locator('.pp-playback')).toBeVisible();
  await playBtn(page).click();
  expect(await page.evaluate(() => window.__soundStarts.length)).toBe(0);
});

// iOS treats `audio/*` (or any image/video type) as media and shows
// Photo Library / Take Video / Choose File; plain sound extensions
// should open Files directly. Only the iPad shows which menu appears —
// this keeps the accept list from drifting back.
test('the sound picker asks for sound file extensions, not media types', async ({ page }) => {
  await openApp(page);
  const accept = await page.locator('.pp-file-input--audio').getAttribute('accept');
  const types = accept.split(',');
  for (const ext of ['.mp3', '.m4a', '.wav']) expect(types).toContain(ext);
  for (const type of types) expect(type).toMatch(/^\.[a-z0-9]+$/);
});
