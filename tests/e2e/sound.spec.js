// End-to-end tests for step 5: importing a sound, saving it, delete
// with undo/redo, and playback running on the sound (5a); the sound
// panel's trim, move and overview (5b). The sound file is
// a WAV made here and fed through the real file chooser, so the actual
// picker path runs. AudioBufferSourceNode.start is wrapped to see what
// the audio clock schedules.
//
// Not covered here (device-only): sync by ear, Safari's output delay,
// which files the iPad's picker offers, Silent mode; (5b) how dragging
// the clip feels with her stylus, the waveform scrolling smoothly with
// the tiles.

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

const panel = (page) => page.locator('.pp-sound-panel');
const importBtn = (page) => panel(page).getByRole('button', { name: /^(Import|Replace) sound$/ });

// Opens the sound panel (the Sound button toggles it).
async function openPanel(page) {
  await expect(soundBtn(page)).toBeEnabled();
  if (await soundBtn(page).getAttribute('aria-pressed') !== 'true') await soundBtn(page).click();
  await expect(panel(page)).toBeVisible();
}

async function pickSound(page, { name = 'tone.wav', mimeType = 'audio/wav', buffer = wav() } = {}) {
  await openPanel(page);
  await expect(importBtn(page)).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await importBtn(page).click();
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

  await openPanel(page);
  await panel(page).getByRole('button', { name: 'Delete sound' }).click();
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

// --- 5b: the sound panel ---

// 5c: two rows; these are the Music row's.
const musicRow = (page) => page.locator('.pp-sound-panel__row--music');
const clipBox = (page) => musicRow(page).locator('.pp-sound-panel__clip');
const startHandle = (page) => musicRow(page).locator('.pp-sound-panel__handle--start');
const endHandle = (page) => musicRow(page).locator('.pp-sound-panel__handle--end');
const overview = (page) => page.locator('.pp-sound-panel__overview');
const track = (page) => musicRow(page).locator('.pp-sound-panel__track');

// One frame's width on the track: a tile and its gap.
async function pitch(page) {
  const [a, b] = [await tiles(page).nth(0).boundingBox(), await tiles(page).nth(1).boundingBox()];
  return b.x - a.x;
}

// Drags from the middle of the visible part of `locator` (the track
// clips the clip when the tiles are scrolled) by `dx` px, in steps.
async function drag(page, locator, dx) {
  const box = await locator.boundingBox();
  const area = await track(page).boundingBox();
  const left = Math.max(box.x, area.x);
  const right = Math.min(box.x + box.width, area.x + area.width);
  const x = (left + right) / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y);
  await page.mouse.up();
}

// The saved clip once it matches `check`.
async function savedClipWhere(page, check) {
  await expect.poll(async () => {
    const clip = (await savedProject(page))?.audioClips?.[0];
    return Boolean(clip && check(clip));
  }).toBe(true);
  return (await savedProject(page)).audioClips[0];
}

async function frames(page, count) {
  while (await tiles(page).count() < count) await addFrame(page);
}

test('the sound panel covers the canvas, never shrinks it, and lines up with the tiles', async ({ page }) => {
  await openApp(page);
  await addFrame(page);
  const area = page.locator('.pp-canvas-area');
  const before = await area.boundingBox();
  await openPanel(page);
  expect(await area.boundingBox()).toEqual(before);
  await expect(panel(page)).toContainText('No music yet');
  await expect(panel(page)).toContainText('No voice yet');
  // The track starts where the tiles do, and the panel sits right above them.
  const trackBox = await track(page).boundingBox();
  const tileBox = await tiles(page).nth(0).boundingBox();
  expect(Math.abs(trackBox.x - tileBox.x)).toBeLessThan(2);
  const panelBox = await panel(page).boundingBox();
  expect(Math.abs(panelBox.y + panelBox.height - (before.y + before.height))).toBeLessThan(2);
  // The onion badge moves above it.
  const badge = await page.locator('.pp-onion-badge').boundingBox();
  expect(badge.y + badge.height).toBeLessThanOrEqual(panelBox.y);
  // And it closes again.
  await soundBtn(page).click();
  await expect(panel(page)).toBeHidden();
});

test('dragging the right handle trims the end, as one undo step', async ({ page }) => {
  await openApp(page);
  await frames(page, 4); // 4 frames at 12 fps = 1/3 s
  await importSound(page, { buffer: wav(2) });
  await expect(clipBox(page)).toBeVisible();
  // 2 s of sound in a 1/3 s animation: it runs past the last frame.
  await expect(clipBox(page)).toHaveClass(/runs-on/);

  await drag(page, endHandle(page), -2 * await pitch(page));
  const trimmed = await savedClipWhere(page, (c) => c.trimEnd < 1);
  expect(trimmed.trimEnd).toBeCloseTo(2 / 12, 2);
  expect(trimmed.trimStart).toBe(0);
  await expect(clipBox(page)).not.toHaveClass(/runs-on/);

  await undoBtn(page).click();
  await savedClipWhere(page, (c) => c.trimEnd > 1.9);
});

test('moving the clip, then past frame 1, and playback uses the edit', async ({ page }) => {
  await watchSound(page);
  await openApp(page);
  await frames(page, 12); // 1 s
  // From frame 1, so the strip isn't scrolled: a drag ending near the
  // track's left end would scroll it (and move the clip further).
  await tiles(page).nth(0).click();
  await expect(tiles(page).nth(0)).toHaveClass(/is-current/);
  await importSound(page, { buffer: wav(0.5) });
  await expect(clipBox(page)).toBeVisible();
  const step = await pitch(page);

  await drag(page, clipBox(page), 3 * step);
  const moved = await savedClipWhere(page, (c) => c.offset > 0);
  expect(moved.offset).toBeCloseTo(3 / 12, 2);
  expect(moved.trimStart).toBe(0);

  // 6 frames back: 3 to frame 1, 3 more slide the sound's start under it.
  await drag(page, clipBox(page), -6 * step);
  const slid = await savedClipWhere(page, (c) => c.trimStart > 0);
  expect(slid.offset).toBe(0);
  expect(slid.trimStart).toBeCloseTo(3 / 12, 2);
  expect(slid.trimEnd).toBeCloseTo(0.5, 2);

  // Play from frame 1: the sound starts from the trimmed point. If the
  // start time has already passed when it's scheduled (a busy CI
  // machine), the engine cuts that much off the front rather than
  // playing late — so it may begin a few ms in, but always ends at the
  // clip's end.
  await playBtn(page).click();
  await expect.poll(() => page.evaluate(() => window.__soundStarts.length)).toBeGreaterThan(0);
  const [first] = await page.evaluate(() => window.__soundStarts);
  const late = first.offset - slid.trimStart;
  expect(late).toBeGreaterThanOrEqual(-0.001);
  expect(late).toBeLessThan(0.05);
  expect(first.offset + first.duration).toBeCloseTo(slid.trimEnd, 2);
  await playBtn(page).click();
});

test('a tap on the overview picks a later part of the song, in the same place', async ({ page }) => {
  await openApp(page);
  await frames(page, 4);
  await importSound(page, { buffer: wav(2) });
  await expect(overview(page)).toBeVisible();
  await expect(page.locator('.pp-sound-panel__window')).toBeVisible();
  const box = await overview(page).boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  const slipped = await savedClipWhere(page, (c) => c.trimStart > 0);
  expect(slipped.trimStart).toBeGreaterThan(1.4);
  expect(slipped.trimStart).toBeLessThan(1.6);
  expect(slipped.trimEnd).toBeCloseTo(2, 2); // still plays to the song's end
  expect(slipped.offset).toBe(0);
});

test('touching the track while playing only stops playback', async ({ page }) => {
  await openApp(page);
  await frames(page, 12);
  await importSound(page, { buffer: wav(0.5) });
  await expect(clipBox(page)).toBeVisible();
  const clip = await savedClip(page);

  await playBtn(page).click();
  await expect(page.locator('.pp-playback')).toBeVisible();
  await expect(musicRow(page).locator('.pp-sound-panel__playhead')).toBeVisible();
  await drag(page, clipBox(page), 3 * await pitch(page));
  await expect(page.locator('.pp-playback')).toBeHidden();
  await expect(musicRow(page).locator('.pp-sound-panel__playhead')).toBeHidden();
  const after = (await savedProject(page)).audioClips[0];
  expect(after.offset).toBe(clip.offset);
});

// --- after 5c: the mixer, Listen and Set start ---

const musicVolumeBtn = (page) => musicRow(page).locator('.pp-sound-panel__label');
const volumePop = (page) => page.locator('.pp-volume-pop');
const volumeSlider = (page) => volumePop(page).locator('input[type="range"]');
const listenBtn = (page) => panel(page).getByRole('button', { name: /^(Listen|Stop)$/ }).first();
const setStartBtn = (page) => page.locator('.pp-sound-panel__listen').nth(1);

// Sets the open volume slider as a finger would: moving, then let go.
async function setVolume(page, percent) {
  await volumeSlider(page).evaluate((el, value) => {
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, percent);
}

// Painted pixels on the layer canvases (a tap that drew).
const ink = (page) => page.evaluate(() => {
  let n = 0;
  for (const c of document.querySelectorAll('.pp-layer')) {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
  }
  return n;
});

async function tapCanvas(page) {
  const box = await page.locator('.pp-canvas-area').boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.3);
}

test('the Music volume goes up to 100%, is saved, and is one undo step', async ({ page }) => {
  await openApp(page);
  await frames(page, 4);
  await importSound(page, { buffer: wav(2) });
  await savedClip(page);
  await expect(musicVolumeBtn(page)).toHaveText(/100%/);
  await musicVolumeBtn(page).click();
  await expect(volumePop(page)).toBeVisible();
  await expect(volumeSlider(page)).toHaveAttribute('max', '100');
  await setVolume(page, 40);
  await expect(musicVolumeBtn(page)).toHaveText(/40%/);
  await expect.poll(async () => (await savedProject(page)).audioClips[0].volume).toBe(0.4);

  // A canvas tap only closes the slider.
  await tapCanvas(page);
  await expect(volumePop(page)).toBeHidden();
  expect(await ink(page)).toBe(0);

  await undoBtn(page).click();
  await expect(musicVolumeBtn(page)).toHaveText(/100%/);
  await expect.poll(async () => (await savedProject(page)).audioClips[0].volume).toBe(undefined);
});

test('the volume can change while the animation plays, without stopping it', async ({ page }) => {
  await openApp(page);
  await frames(page, 24);
  await importSound(page, { buffer: wav(2) });
  await savedClip(page);
  await playBtn(page).click(); // loop is on: it keeps playing
  await expect(page.locator('.pp-playback')).toBeVisible();
  await musicVolumeBtn(page).click();
  await setVolume(page, 60);
  await expect(page.locator('.pp-playback')).toBeVisible(); // still playing
  await expect.poll(async () => (await savedProject(page)).audioClips[0].volume).toBe(0.6);
});

test('Listen plays the song alone from its start and leaves the start alone', async ({ page }) => {
  await watchSound(page);
  await openApp(page);
  await frames(page, 4);
  await importSound(page, { buffer: wav(3) });
  await savedClip(page);
  const before = await page.evaluate(() => window.__soundStarts.length);
  await listenBtn(page).click();
  await expect(listenBtn(page)).toHaveText('Stop');
  await expect(page.locator('.pp-sound-panel__listen-line')).toBeVisible();
  const starts = await page.evaluate(() => window.__soundStarts);
  expect(starts.length).toBe(before + 1);
  expect(starts.at(-1).offset).toBe(0); // from the part's start
  await expect(page.locator('.pp-playback')).toBeHidden(); // no animation

  await listenBtn(page).click();
  await expect(listenBtn(page)).toHaveText('Listen');
  await expect(page.locator('.pp-sound-panel__listen-line')).toBeHidden();
  expect((await savedProject(page)).audioClips[0].trimStart).toBe(0);
  await expect(undoBtn(page)).toBeEnabled(); // the import, nothing new
});

test('Set start: where it stops is the new start, as one undo step', async ({ page }) => {
  await openApp(page);
  await frames(page, 4);
  await importSound(page, { buffer: wav(3) });
  await setStartBtn(page).click();
  await expect(setStartBtn(page)).toHaveText('Stop');
  // The part moves along with the song.
  const window0 = await page.locator('.pp-sound-panel__window').boundingBox();
  await expect.poll(async () => (await page.locator('.pp-sound-panel__window').boundingBox()).x, { timeout: 5000 })
    .toBeGreaterThan(window0.x + 5);
  await setStartBtn(page).click();
  await expect(setStartBtn(page)).toHaveText('Set start');
  const moved = await savedClipWhere(page, (c) => c.trimStart > 0.1);
  expect(moved.offset).toBe(0); // still from frame 1

  await undoBtn(page).click();
  await expect.poll(async () => (await savedProject(page)).audioClips[0].trimStart).toBe(0);
});

test('a canvas tap while listening only stops it', async ({ page }) => {
  await openApp(page);
  await frames(page, 4);
  await importSound(page, { buffer: wav(3) });
  await listenBtn(page).click();
  await expect(listenBtn(page)).toHaveText('Stop');
  await tapCanvas(page);
  await expect(listenBtn(page)).toHaveText('Listen');
  expect(await ink(page)).toBe(0);
});

// After 6b, on her iPad: Bluetooth headphones connected, and the audio
// context kept saying 'running' while its clock stood still — Play froze
// with no sound until the app was relaunched. Here the clock is frozen
// by hand (Chromium's never stops on its own).
async function freezableAudio(page) {
  await page.addInitScript(() => {
    const real = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime');
    window.__frozen = new Map();
    Object.defineProperty(BaseAudioContext.prototype, 'currentTime', {
      configurable: true,
      get() { return window.__frozen.has(this) ? window.__frozen.get(this) : real.get.call(this); },
    });
    window.__contexts = [];
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      constructor(...args) { super(...args); window.__contexts.push(this); }
    };
    window.__freezeAudio = () => {
      for (const c of window.__contexts) window.__frozen.set(c, real.get.call(c));
    };
  });
}

const devLogText = (page) => page.evaluate(() => localStorage.getItem('parapara-dev-log') ?? '');

test('a sound clock that stops while running: the drawings keep playing, and the next Play brings the sound back', async ({ page }) => {
  await freezableAudio(page);
  await watchSound(page);
  await openApp(page);
  await frames(page, 3);
  await tiles(page).nth(0).click();
  await expect(tiles(page).nth(0)).toHaveClass(/is-current/);
  await importSound(page, { buffer: wav(2) });
  await soundBtn(page).click(); // close the panel

  // One good run makes the context.
  await playBtn(page).click();
  await expect(page.locator('.pp-playback')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__soundStarts.length)).toBeGreaterThan(0);
  await playBtn(page).click();
  await expect(page.locator('.pp-playback')).toBeHidden();
  await tiles(page).nth(0).click();
  await expect(tiles(page).nth(0)).toHaveClass(/is-current/);

  // The headphones connect: the clock stops, the state stays 'running'.
  await page.evaluate(() => window.__freezeAudio());
  expect(await page.evaluate(() => window.__contexts[0].state)).toBe('running');
  // Every frame the playhead visits, seen from inside the page (one
  // frame lasts 83 ms — too brief to poll for).
  await page.evaluate(() => {
    window.__visited = new Set();
    const strip = document.querySelector('.pp-frame-strip__tile').parentElement;
    new MutationObserver(() => {
      const current = document.querySelector('.pp-frame-strip__tile.is-current');
      if (current) window.__visited.add(current.getAttribute('aria-label'));
    }).observe(strip, { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await playBtn(page).click();
  await expect(page.locator('.pp-playback')).toBeVisible();
  await expect(toast(page)).toContainText('Tap Play again');
  // Not frozen: the playhead moves on (silently).
  await expect.poll(() => page.evaluate(() => [...window.__visited].sort()), { timeout: 5000 })
    .toEqual(expect.arrayContaining(['Frame 2', 'Frame 3']));
  await playBtn(page).click();
  await expect(page.locator('.pp-playback')).toBeHidden();
  await expect.poll(() => devLogText(page)).toContain('sound-stalled');

  // The next Play: a new context, the old one closed, sound scheduled on it.
  const before = await page.evaluate(() => window.__soundStarts.length);
  await playBtn(page).click();
  await expect(page.locator('.pp-playback')).toBeVisible();
  expect(await page.evaluate(() => window.__contexts.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__contexts[0].state)).toBe('closed');
  await expect.poll(() => page.evaluate(() => window.__soundStarts.length)).toBeGreaterThan(before);
  await expect.poll(() => devLogText(page)).toContain('sound-renew why=stalled');
  // And it runs on that clock without stalling.
  await page.waitForTimeout(800); // proving a stall doesn't happen
  expect((await devLogText(page)).match(/sound-stalled/g)).toHaveLength(1);
  await playBtn(page).click();
});
