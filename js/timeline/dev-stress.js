// js/timeline/dev-stress.js
//
// DEVELOPER ONLY — remove before calling the app done (with the rest of
// the gear menu's Developer section).
//
// Step 4a-i: measures, on the iPad, how flattened frames can be held
// for playback before the real cache is built (PROJECT_NOTES.md, step
// 4). Desktop numbers say nothing about the 9th-gen iPad, so nothing
// here is meant to be judged off-device.
//
// Two tests, both on synthetic frames made in memory — nothing is
// saved, her project is untouched:
//
// 1. Playback speed test (safe): how long it takes to flatten a frame
//    from layer PNGs (what building the cache costs), how big a
//    flattened frame is encoded and how long it takes to decode, and a
//    real playback run at several fps that decodes a few frames ahead
//    of the playhead (the planned design) and counts dropped frames.
// 2. Frame memory test (may reload the page): holds more and more
//    full-size decoded frames until Safari refuses a canvas, or iOS
//    kills the page. Progress is written to localStorage before each
//    step, so after a reload the last count that survived is reported
//    (reportInterruptedMemoryTest, called at launch).
//
// The results show in a dialog; a screenshot is the report.

import { beatAtTime } from './clock.js';

const SPEED_FPS = [12, 24, 30, 60];
const SPEED_SECONDS = 4;
const PLAYBACK_FRAMES = 24;   // distinct frames, so no decode is reused
const LAYERS_PER_FRAME = 4;   // for the playback frames
const DECODE_AHEAD = 6;       // the ring of decoded frames ahead of the playhead
const MEMORY_STEP = 8;        // frames added per memory step
const MEMORY_MAX = 160;       // stop here even if nothing failed (~1.3 GB at 1080p)
const MEMORY_KEY = 'parapara-dev-memory-test';

// --- synthetic drawings ---

// Small seeded RNG so every run draws the same pictures.
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

const INKS = ['#2b2118', '#3a5a8c', '#b33a3a', '#2f7d4f', '#8a4fb3'];

// Roughly line-art density: a few dozen curved strokes, plus (for
// every fourth seed) some filled shapes like a color layer.
function drawLayer(ctx, width, height, seed) {
  const r = rng(seed);
  const unit = width / 1920;
  if (seed % 4 === 3) {
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = INKS[Math.floor(r() * INKS.length)];
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.ellipse(r() * width, r() * height, (60 + r() * 220) * unit, (60 + r() * 160) * unit, r() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = INKS[Math.floor(r() * INKS.length)];
    ctx.lineWidth = (2 + r() * 10) * unit;
    ctx.beginPath();
    let x = r() * width;
    let y = r() * height;
    ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      const cx = x + (r() - 0.5) * 300 * unit;
      const cy = y + (r() - 0.5) * 300 * unit;
      x += (r() - 0.5) * 400 * unit;
      y += (r() - 0.5) * 400 * unit;
      ctx.quadraticCurveTo(cx, cy, x, y);
    }
    ctx.stroke();
  }
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function freeCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

function encode(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`Could not encode ${type}`))), type, 0.9);
  });
}

// --- small helpers ---

const now = () => performance.now();
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const ms = (value) => `${Math.round(value)} ms`;
const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
const mb = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

// --- the dialog ---

// One dialog for progress and results. Looks like the app's own
// dialogs (pp-dialog); touches behind it are swallowed.
function openReport(title) {
  const backdrop = document.createElement('div');
  backdrop.className = 'pp-dialog-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'pp-dialog pp-dev-report';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', title);

  const heading = document.createElement('div');
  heading.className = 'pp-dialog__title';
  heading.textContent = title;

  const status = document.createElement('div');
  status.className = 'pp-dialog__message';

  const stage = document.createElement('canvas');
  stage.className = 'pp-dev-report__stage';
  stage.hidden = true;

  const table = document.createElement('table');
  table.className = 'pp-dev-report__table';

  const buttons = document.createElement('div');
  buttons.className = 'pp-dialog__buttons';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pp-dialog__btn pp-dialog__btn--primary';
  close.textContent = 'Close';
  close.hidden = true;
  buttons.appendChild(close);

  dialog.append(heading, status, stage, table, buttons);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  return {
    stage,
    setStatus(text) { status.textContent = text; },
    section(label) {
      const row = table.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 2;
      cell.className = 'pp-dev-report__section';
      cell.textContent = label;
    },
    row(label, value) {
      const row = table.insertRow();
      row.insertCell().textContent = label;
      row.insertCell().textContent = value;
    },
    // Resolves when Close is tapped; the dialog is removed then.
    done() {
      close.hidden = false;
      return new Promise((resolve) => {
        close.addEventListener('click', () => {
          backdrop.remove();
          resolve();
        }, { once: true });
      });
    },
  };
}

// --- 1. playback speed test ---

export async function runPlaybackSpeedTest({ canvasSize }) {
  const { width, height } = canvasSize;
  const half = { width: Math.round(width / 2), height: Math.round(height / 2) };
  const report = openReport('Playback speed test');
  report.row('Canvas', `${width} × ${height}, decoded frame ${mb(width * height * 4)}`);
  try {
    // Eight layer PNGs, as they'd come out of storage.
    report.setStatus('Drawing test layers…');
    await nextFrame();
    const layerBlobs = [];
    for (let i = 0; i < 8; i++) {
      const canvas = makeCanvas(width, height);
      drawLayer(canvas.getContext('2d'), width, height, i + 1);
      layerBlobs.push(await encode(canvas));
      freeCanvas(canvas);
    }

    // Building one cache entry: decode each layer, draw it, encode.
    report.section('Flatten one frame from saved layers (cache build)');
    for (const count of [1, 4, 8]) {
      report.setStatus(`Flattening ${count} layers…`);
      const flattenTimes = [];
      const encodeTimes = [];
      for (let run = 0; run < 3; run++) {
        const canvas = makeCanvas(width, height);
        const ctx = canvas.getContext('2d');
        const start = now();
        for (const blob of layerBlobs.slice(0, count)) {
          const image = await createImageBitmap(blob);
          ctx.drawImage(image, 0, 0);
          image.close?.();
        }
        ctx.getImageData(0, 0, 1, 1); // wait for the drawing to really happen
        flattenTimes.push(now() - start);
        const encodeStart = now();
        await encode(canvas);
        encodeTimes.push(now() - encodeStart);
        freeCanvas(canvas);
        await nextFrame();
      }
      report.row(`${count} layer${count > 1 ? 's' : ''}`, `${ms(median(flattenTimes))} + encode ${ms(median(encodeTimes))}`);
    }

    // The playback frames: flattened, encoded at full and half size.
    report.setStatus(`Making ${PLAYBACK_FRAMES} test frames…`);
    await nextFrame();
    const fullBlobs = [];
    const halfBlobs = [];
    for (let f = 0; f < PLAYBACK_FRAMES; f++) {
      const canvas = makeCanvas(width, height);
      const ctx = canvas.getContext('2d');
      for (let l = 0; l < LAYERS_PER_FRAME; l++) drawLayer(ctx, width, height, 100 + f * 10 + l);
      fullBlobs.push(await encode(canvas));
      const small = makeCanvas(half.width, half.height);
      small.getContext('2d').drawImage(canvas, 0, 0, half.width, half.height);
      halfBlobs.push(await encode(small));
      freeCanvas(small);
      freeCanvas(canvas);
      report.setStatus(`Making test frames… ${f + 1} of ${PLAYBACK_FRAMES}`);
    }

    // Is WebP encoding available? (Smaller files, maybe faster decode.)
    let webpBlob = null;
    {
      const canvas = makeCanvas(width, height);
      const ctx = canvas.getContext('2d');
      for (let l = 0; l < LAYERS_PER_FRAME; l++) drawLayer(ctx, width, height, 100 + l);
      const blob = await encode(canvas, 'image/webp');
      if (blob.type === 'image/webp') webpBlob = blob;
      freeCanvas(canvas);
    }

    report.section(`Flattened frame (${LAYERS_PER_FRAME} layers), encoded`);
    const average = (blobs) => blobs.reduce((sum, b) => sum + b.size, 0) / blobs.length;
    report.row('PNG, full size', `${kb(average(fullBlobs))} each, ${PLAYBACK_FRAMES} = ${mb(average(fullBlobs) * PLAYBACK_FRAMES)}`);
    report.row('PNG, half size', `${kb(average(halfBlobs))} each`);
    report.row('WebP, full size', webpBlob ? kb(webpBlob.size) : 'not supported');

    // The stage: about the size the canvas shows on her screen.
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.min(560, window.innerWidth - 120);
    const cssHeight = Math.round(cssWidth * (height / width));
    const stage = report.stage;
    stage.hidden = false;
    stage.style.width = `${cssWidth}px`;
    stage.style.height = `${cssHeight}px`;
    stage.width = Math.round(cssWidth * dpr);
    stage.height = Math.round(cssHeight * dpr);
    const stageCtx = stage.getContext('2d');

    // Decode + draw one frame, as playback does it.
    report.section('Decode and show one frame');
    const decodeTime = async (blobs) => {
      const times = [];
      for (const blob of blobs.slice(0, 6)) {
        const start = now();
        const image = await createImageBitmap(blob);
        stageCtx.fillStyle = '#ffffff';
        stageCtx.fillRect(0, 0, stage.width, stage.height);
        stageCtx.drawImage(image, 0, 0, stage.width, stage.height);
        stageCtx.getImageData(0, 0, 1, 1);
        times.push(now() - start);
        image.close?.();
        await nextFrame();
      }
      return median(times);
    };
    report.setStatus('Timing decodes…');
    report.row('PNG, full size', ms(await decodeTime(fullBlobs)));
    report.row('PNG, half size', ms(await decodeTime(halfBlobs)));
    if (webpBlob) report.row('WebP, full size', ms(await decodeTime([webpBlob, webpBlob, webpBlob])));

    // Real playback runs, decoding a few frames ahead.
    report.section(`Playback, ${SPEED_SECONDS} s each, decoding ${DECODE_AHEAD} ahead`);
    for (const [label, blobs] of [['full', fullBlobs], ['half', halfBlobs]]) {
      for (const fps of SPEED_FPS) {
        report.setStatus(`Playing ${fps} fps, ${label} size…`);
        const result = await simulatePlayback({ blobs, fps, ctx: stageCtx, stage });
        report.row(`${fps} fps, ${label} size`, `${result.shown} of ${result.expected} shown, ${result.dropped} dropped (${Math.round((result.dropped / result.expected) * 100)}%)`);
      }
    }
    stage.hidden = true;
    freeCanvas(stage);
    report.setStatus('Done. Take a screenshot of this.');
  } catch (err) {
    console.error('Parapara! playback speed test failed:', err);
    report.setStatus(`The test stopped: ${err?.message ?? err}`);
  }
  await report.done();
}

// Plays `blobs` in a loop at `fps` for SPEED_SECONDS, the way step 4b
// will: the frame comes from elapsed time, a ring of decoded frames is
// kept just ahead of the playhead, and a frame that isn't decoded in
// time (or a beat the screen never got to) counts as dropped.
async function simulatePlayback({ blobs, fps, ctx, stage }) {
  const n = blobs.length;
  const ready = new Map();   // beat -> ImageBitmap
  const pending = new Set(); // beats being decoded
  let stopped = false;

  function fill(fromBeat) {
    for (let beat = fromBeat; beat < fromBeat + DECODE_AHEAD; beat++) {
      if (ready.has(beat) || pending.has(beat)) continue;
      pending.add(beat);
      createImageBitmap(blobs[beat % n]).then((image) => {
        pending.delete(beat);
        if (stopped) image.close?.();
        else ready.set(beat, image);
      }, () => pending.delete(beat));
    }
    for (const [beat, image] of ready) {
      if (beat < fromBeat) {
        image.close?.();
        ready.delete(beat);
      }
    }
  }

  // Start once the first frames are decoded, as real playback would.
  fill(0);
  while (!ready.has(0)) await nextFrame();

  const expected = SPEED_SECONDS * fps;
  let shown = 0;
  let dropped = 0;
  let lastBeat = -1;
  const start = now();
  await new Promise((resolve) => {
    function tick() {
      const beat = Math.min(beatAtTime(now() - start, fps), expected);
      if (beat >= expected) {
        resolve();
        return;
      }
      if (beat !== lastBeat) {
        dropped += Math.max(0, beat - lastBeat - 1); // beats the screen skipped
        const image = ready.get(beat);
        if (image) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, stage.width, stage.height);
          ctx.drawImage(image, 0, 0, stage.width, stage.height);
          shown++;
        } else {
          dropped++; // not decoded in time: the last frame stays up
        }
        lastBeat = beat;
        fill(beat + 1);
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  // The run's last beats may not have had a tick of their own.
  dropped += Math.max(0, expected - 1 - lastBeat);
  stopped = true;
  for (const image of ready.values()) image.close?.();
  ready.clear();
  await wait(200);
  return { shown, dropped, expected };
}

// --- 2. frame memory test ---

function writeMemoryProgress(record) {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(record));
  } catch {
    // Without localStorage an interrupted run just isn't reported.
  }
}

function readMemoryProgress() {
  try {
    const record = JSON.parse(localStorage.getItem(MEMORY_KEY));
    localStorage.removeItem(MEMORY_KEY);
    return record && typeof record.held === 'number' ? record : null;
  } catch {
    return null;
  }
}

// layerCount: the open project's layers, which stay in memory during
// the test (run Fill all layers first for the worst case). The caller
// saves her work before starting.
export async function runFrameMemoryTest({ canvasSize, layerCount }) {
  const { width, height } = canvasSize;
  const frameBytes = width * height * 4;
  const report = openReport('Frame memory test');
  report.row('Open project', `${layerCount} layer${layerCount === 1 ? '' : 's'} in memory`);
  report.row('Each frame', mb(frameBytes));
  const held = [];
  let outcome = `Stopped at the test's limit of ${MEMORY_MAX} frames.`;
  try {
    // One test picture, drawn into every held frame so each canvas
    // really gets its memory.
    const source = makeCanvas(width, height);
    const sourceCtx = source.getContext('2d');
    sourceCtx.fillStyle = '#ffffff';
    sourceCtx.fillRect(0, 0, width, height);
    for (let l = 0; l < LAYERS_PER_FRAME; l++) drawLayer(sourceCtx, width, height, 500 + l);

    outer:
    while (held.length < MEMORY_MAX) {
      writeMemoryProgress({ held: held.length, frameBytes, layerCount, at: Date.now() });
      report.setStatus(`Holding ${held.length} frames (${mb(held.length * frameBytes)})… adding ${MEMORY_STEP} more`);
      for (let i = 0; i < MEMORY_STEP; i++) {
        const canvas = makeCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          outcome = `Safari refused another canvas at ${held.length} frames.`;
          freeCanvas(canvas);
          break outer;
        }
        ctx.drawImage(source, 0, 0);
        // Over its limit Safari may hand back a canvas that silently
        // doesn't draw — check a pixel that must be white.
        const pixel = ctx.getImageData(0, 0, 1, 1).data;
        if (pixel[3] === 0) {
          outcome = `Safari stopped drawing into new canvases at ${held.length} frames.`;
          freeCanvas(canvas);
          break outer;
        }
        held.push(canvas);
      }
      // Give iOS a moment to object before going further.
      await nextFrame();
      await wait(300);
    }
    freeCanvas(source);
  } catch (err) {
    console.error('Parapara! frame memory test failed:', err);
    outcome = `The test stopped at ${held.length} frames: ${err?.message ?? err}`;
  }
  const count = held.length;
  held.forEach(freeCanvas);
  held.length = 0;
  try {
    localStorage.removeItem(MEMORY_KEY);
  } catch {
    // nothing to clean up
  }
  report.section('Result');
  report.row('Frames held', `${count} (${mb(count * frameBytes)})`);
  report.row('Why it stopped', outcome);
  report.setStatus('Done. Take a screenshot of this.');
  await report.done();
}

// At launch: if a memory test was running when the page went away,
// iOS most likely killed it — report the last count that survived.
export function reportInterruptedMemoryTest() {
  const record = readMemoryProgress();
  if (!record) return;
  const report = openReport('Frame memory test (interrupted)');
  report.row('Open project', `${record.layerCount} layer${record.layerCount === 1 ? '' : 's'} in memory`);
  report.row('Frames held when it stopped', `${record.held} (${mb(record.held * record.frameBytes)}) — the next ${MEMORY_STEP} didn't survive`);
  report.setStatus('The page reloaded mid-test, so iOS most likely ran out of memory. Take a screenshot of this.');
  report.done();
}
