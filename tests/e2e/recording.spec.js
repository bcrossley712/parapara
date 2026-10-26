// End-to-end tests for 5c: holding the mic to record a Voice. Chromium's
// fake mic (a steady beep) stands in for hers and is allowed without a
// prompt; its MediaRecorder makes WebM/Opus rather than the iPad's
// AAC/MP4, which is fine here — the file is stored as made either way.
// AudioBufferSourceNode.start is wrapped to see what plays while she
// records.
//
// Not covered here (device-only): the mic permission prompt and its
// interrupted hold, the real mic delay, echo with and without
// headphones, the countdown's feel.

import { test, expect } from '@playwright/test';
import { openApp, readDb, setVisibility } from './helpers.js';

test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['microphone'],
});

const soundBtn = (page) => page.locator('.pp-sound-btn');
const banner = (page) => page.locator('#pp-banner');
const panel = (page) => page.locator('.pp-sound-panel');
const mic = (page) => panel(page).getByRole('button', { name: 'Hold to record' });
const countdown = (page) => page.locator('.pp-countdown');
const playback = (page) => page.locator('.pp-playback');
const voiceRow = (page) => page.locator('.pp-sound-panel__row--voice');
const tiles = (page) => page.locator('.pp-frame-strip__tile');
const addFrameBtn = (page) => page.getByRole('button', { name: 'Add frame' });
const undoBtn = (page) => page.getByRole('button', { name: 'Undo', exact: true });
const dialog = (page) => page.getByRole('dialog');

// A mono 16-bit PCM WAV of a quiet tone.
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
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  }
  return buf;
}

async function watchSound(page) {
  await page.addInitScript(() => {
    window.__soundStarts = [];
    const real = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration) {
      window.__soundStarts.push({
        length: Math.round((this.buffer?.duration ?? 0) * 1000) / 1000,
        offset: Math.round(offset * 1000) / 1000,
      });
      return real.call(this, when, offset, duration);
    };
  });
}

async function openPanel(page) {
  await expect(soundBtn(page)).toBeEnabled();
  if (await soundBtn(page).getAttribute('aria-pressed') !== 'true') await soundBtn(page).click();
  await expect(panel(page)).toBeVisible();
}

async function frames(page, count) {
  while (await tiles(page).count() < count) {
    await expect(addFrameBtn(page)).toBeEnabled();
    const before = await tiles(page).count();
    await addFrameBtn(page).click();
    await expect(tiles(page)).toHaveCount(before + 1);
  }
  await expect(addFrameBtn(page)).toBeEnabled();
}

async function goToFrame(page, index) {
  await tiles(page).nth(index).click();
  await expect(tiles(page).nth(index)).toHaveClass(/is-current/);
}

async function importMusic(page, seconds = 2) {
  await openPanel(page);
  const chooser = page.waitForEvent('filechooser');
  await panel(page).getByRole('button', { name: /^(Import|Replace) sound$/ }).click();
  await (await chooser).setFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: wav(seconds) });
  await expect(banner(page)).toContainText('Sound added');
}

// Presses the mic and keeps it down.
async function press(page) {
  await expect(mic(page)).toBeEnabled();
  const box = await mic(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

// Holds through the countdown until the picture is playing.
async function holdUntilRecording(page) {
  await press(page);
  await expect(countdown(page)).toBeVisible();
  await expect(countdown(page)).toContainText('3');
  await expect(playback(page)).toBeVisible({ timeout: 8000 });
  await expect(panel(page).locator('.pp-sound-panel__mic')).toHaveClass(/is-recording/);
}

const savedProject = async (page) => (await readDb(page, 'projects'))[0];
async function savedVoice(page, check = () => true) {
  await expect.poll(async () => {
    const voice = (await savedProject(page))?.audioClips?.find((c) => c.kind === 'voice');
    return Boolean(voice && check(voice));
  }, { timeout: 10000 }).toBe(true);
  return (await savedProject(page)).audioClips.find((c) => c.kind === 'voice');
}

test('letting go during the countdown records nothing', async ({ page }) => {
  await openApp(page);
  await frames(page, 4);
  await openPanel(page);
  await press(page);
  await expect(countdown(page)).toBeVisible();
  await page.mouse.up();
  await expect(countdown(page)).toBeHidden();
  await expect(banner(page)).toContainText('Keep holding until the countdown ends');
  await expect(playback(page)).toBeHidden();
  // Nothing recorded, and nothing to undo from it.
  expect((await savedProject(page)).audioClips ?? []).toEqual([]);
  await expect(soundBtn(page)).not.toHaveClass(/has-sound/);
});

test('a take records from her frame, without the lead-in, and is one undo step', async ({ page }) => {
  await openApp(page);
  await frames(page, 24); // 2 s at 12 fps
  await goToFrame(page, 2);
  await openPanel(page);
  await holdUntilRecording(page);
  // The take grows on the Voice row.
  await expect(voiceRow(page).locator('.pp-sound-panel__recording')).toBeVisible();
  await page.waitForTimeout(800); // record a little (proving time passes, not waiting on an event)
  await page.mouse.up();
  await expect(playback(page)).toBeHidden();
  await expect(banner(page)).toContainText('Voice recorded');

  const voice = await savedVoice(page);
  expect(voice.offset).toBeCloseTo(2 / 12, 3);
  expect(voice.trimStart).toBeGreaterThan(0); // the recorder ran before the first frame
  expect(voice.trimEnd - voice.trimStart).toBeGreaterThan(0.3);
  // Leveled: a gain above 1 (capped at 8), or none if it's loud already.
  if ('gain' in voice) {
    expect(voice.gain).toBeGreaterThan(1);
    expect(voice.gain).toBeLessThanOrEqual(8);
  }
  const blobs = await readDb(page, 'blobs');
  const file = blobs.find((b) => b.id === voice.blobRef);
  expect(file.type).toMatch(/^audio\//);
  await expect(voiceRow(page).locator('.pp-sound-panel__clip')).toBeVisible();
  await expect(soundBtn(page)).toHaveClass(/has-sound/);

  await undoBtn(page).click();
  await expect.poll(async () => (await savedProject(page)).audioClips.length).toBe(0);
});

test('recording stops at the last frame even with loop on, and keeps the take', async ({ page }) => {
  await openApp(page);
  await frames(page, 6); // 0.5 s
  await goToFrame(page, 0);
  await openPanel(page);
  await press(page);
  await expect(countdown(page)).toBeVisible();
  // Still holding: the picture plays and ends on its own at the last
  // frame (half a second — too brief to catch it playing reliably).
  await expect(banner(page)).toContainText('Voice recorded', { timeout: 10000 });
  await expect(playback(page)).toBeHidden();
  await page.mouse.up();
  const voice = await savedVoice(page);
  expect(voice.offset).toBe(0);
  await expect(tiles(page).nth(5)).toHaveClass(/is-current/); // landed on the last frame
});

test('a canvas tap while recording ends it and keeps the take', async ({ page }) => {
  await openApp(page);
  await frames(page, 24);
  await goToFrame(page, 0);
  await openPanel(page);
  await holdUntilRecording(page);
  await page.waitForTimeout(500);
  // A second pointer on the canvas (touch-style) — the mouse is busy
  // holding the mic, so dispatch a touch through CDP.
  const area = await page.locator('.pp-canvas-area').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const point = { x: area.x + area.width / 2, y: area.y + 80 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(playback(page)).toBeHidden();
  await expect(banner(page)).toContainText('Voice recorded');
  await page.mouse.up();
  await savedVoice(page);
});

test('hiding the app while recording ends it and keeps the take', async ({ page }) => {
  await openApp(page);
  await frames(page, 24);
  await goToFrame(page, 0);
  await openPanel(page);
  await holdUntilRecording(page);
  await page.waitForTimeout(500);
  await setVisibility(page, 'hidden');
  await expect(playback(page)).toBeHidden();
  await setVisibility(page, 'visible');
  await page.mouse.up();
  await savedVoice(page);
});

test('with music: the headphones tip first, then the music plays and the old voice is silent', async ({ page }) => {
  await watchSound(page);
  await openApp(page);
  await frames(page, 24);
  await goToFrame(page, 0);
  await importMusic(page, 2);

  // First press: the headphones tip, which stands in for the hold.
  await press(page);
  await expect(dialog(page)).toContainText('Use headphones');
  await page.mouse.up();
  await dialog(page).getByRole('button', { name: "Don't show again" }).click();
  await expect(banner(page)).toContainText('Hold the mic to record');
  await expect.poll(async () => (await readDb(page, 'meta', 'uiState'))?.value?.hideHeadphonesTip).toBe(true);

  // A first take.
  await holdUntilRecording(page);
  await page.waitForTimeout(500);
  await page.mouse.up();
  const first = await savedVoice(page);

  // A retake right away doesn't ask; while it records, only the music
  // (the 2 s file) is scheduled — never the old voice.
  // (From frame 1 again: the first take landed where it stopped.)
  await goToFrame(page, 0);
  await page.evaluate(() => { window.__soundStarts = []; });
  await holdUntilRecording(page);
  await expect.poll(() => page.evaluate(() => window.__soundStarts.length)).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  await page.mouse.up();
  const starts = await page.evaluate(() => window.__soundStarts);
  expect(starts.every((s) => Math.abs(s.length - 2) < 0.01)).toBe(true);
  const second = await savedVoice(page, (v) => v.blobRef !== first.blobRef);
  // The music is untouched.
  const music = (await savedProject(page)).audioClips.find((c) => c.kind === 'music');
  expect(music.trimEnd).toBeCloseTo(2, 2);
  expect(second.kind).toBe('voice');
});

test('replacing a voice recorded before the panel opened asks first', async ({ page }) => {
  await openApp(page);
  await frames(page, 24);
  await goToFrame(page, 0);
  await openPanel(page);
  await holdUntilRecording(page);
  await page.waitForTimeout(400);
  await page.mouse.up();
  await savedVoice(page);
  await expect(page.locator('.pp-playback')).toBeHidden();

  // Close and reopen the panel: now the voice is an older one.
  await soundBtn(page).click();
  await expect(panel(page)).toBeHidden();
  await openPanel(page);
  await press(page);
  await expect(dialog(page)).toContainText('Replace the voice?');
  await page.mouse.up();
  await expect(countdown(page)).toBeHidden();
  await dialog(page).getByRole('button', { name: 'Replace' }).click();
  await expect(banner(page)).toContainText('Hold the mic to record');
  // Now a hold goes straight to the countdown.
  await press(page);
  await expect(countdown(page)).toBeVisible();
  await page.mouse.up();
});

test('with one frame, the mic asks for another frame', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  await press(page);
  await page.mouse.up();
  await expect(banner(page)).toContainText('Add another frame to record');
  await expect(countdown(page)).toBeHidden();
});
