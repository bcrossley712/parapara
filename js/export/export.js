// js/export/export.js
//
// Owns: turning a project's frames into an MP4 (step 6a): one canvas,
// one frame at a time, into WebCodecs' H.264 VideoEncoder, then mp4.js
// lays the encoded frames out as a file — with the sound track (6b),
// encoded beforehand by aac.js, beside them. The share-sheet hand-off and
// the UI live elsewhere (ui/export-sheet.js, main.js).
//
// Knows nothing about projects, storage or the DOM: the caller passes
// `drawFrame(index, ctx)`, which draws frame `index` exactly as
// playback shows it (main.js uses playback-frames.js), and the canvas
// to draw on. The encoder and VideoFrame are passed in too (defaults:
// the browser's), so the loop is unit-tested with fakes
// (tests/unit/export.test.js).
//
// Rules (docs/ARCHITECTURE.md, Export):
//   - Each drawing lasts exactly 1/fps — the track's timescale is
//     fps × 1000 and every sample is 1000 ticks, so no rounding drift.
//   - A keyframe every KEYFRAME_SECONDS (and the first frame).
//   - Never more than MAX_QUEUE frames waiting in the encoder, so
//     memory stays flat however long the animation (iPad Safari).
//   - Frames must come out in the order they went in (no B-frames):
//     the muxer writes no composition offsets. If an encoder ever
//     reorders, that's an error, not a scrambled file.
//   - An encoder that stalls fails after ENCODER_STALL_MS.
//   - H.264 needs even sizes: an odd width/height loses a pixel
//     (evenSize; the caller sizes the canvas with it).

import { muxMP4 } from './mp4.js';

export const VIDEO_BITRATE = 6_000_000;  // upper bound; line art comes in well under
export const KEYFRAME_SECONDS = 2;
export const MAX_QUEUE = 2;
// An encoder that stops taking frames (or never finishes) fails the
// export after this long instead of leaving "Making video" up forever
// — like exportPNG's timeout (a canvas toBlob that never called back
// was seen on the sandbox build).
export const ENCODER_STALL_MS = 15000;
const WAIT_MS = 5;
const TICKS_PER_FRAME = 1000;

// High, then Main, then Baseline. Level 4.0 covers 1920×1080 at 30 fps;
// bigger canvases need 5.1.
const PROFILES = ['64', '4D', '42'];

export function evenSize({ width, height }) {
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(width), height: even(height) };
}

export function codecCandidates({ width, height }) {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = macroblocks <= 8192 ? '28' : '33';
  return PROFILES.map((profile) => `avc1.${profile}00${level}`);
}

// The first H.264 config the browser says it can encode, or null.
export async function pickVideoConfig({ width, height, fps }, isConfigSupported = defaultIsConfigSupported) {
  for (const codec of codecCandidates({ width, height })) {
    const config = {
      codec,
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: fps,
      avc: { format: 'avc' }, // length-prefixed samples + avcC, what MP4 wants
    };
    try {
      const result = await isConfigSupported(config);
      if (result?.supported) return config;
    } catch {
      // try the next one
    }
  }
  return null;
}

export function isVideoExportSupported() {
  return typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoFrame === 'function';
}

// Makes the MP4. Resolves { blob, size, codec }.
//   frameCount, fps: what to make; canvas: where frames are drawn (its
//     size is the video's).
//   drawFrame(index, ctx): Promise — draws frame `index`.
//   onProgress(done, total): after each frame is handed to the encoder.
//   signal: AbortSignal — cancel; rejects with an AbortError.
//   audio: the sound track, already encoded (6b, aac.js + the edit's
//     priming and length — see muxMP4), or null for a silent video.
export async function exportVideo({
  frameCount,
  fps,
  canvas,
  drawFrame,
  audio = null,
  onProgress = () => {},
  signal = null,
  createEncoder = (init) => new globalThis.VideoEncoder(init),
  createFrame = (source, init) => new globalThis.VideoFrame(source, init),
  isConfigSupported = defaultIsConfigSupported,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!(frameCount > 0)) throw new Error('No frames to export');
  const { width, height } = canvas;
  const config = await pickVideoConfig({ width, height, fps }, isConfigSupported);
  if (!config) throw new ExportError('unsupported', 'This device can’t make videos.');
  checkAbort(signal);

  const samples = [];
  let description = null;
  let failure = null;
  let lastTimestamp = -Infinity;
  const encoder = createEncoder({
    output: (chunk, metadata) => {
      const desc = metadata?.decoderConfig?.description;
      if (desc && !description) description = copyBytes(desc);
      if (chunk.timestamp <= lastTimestamp) {
        failure ??= new ExportError('reordered', 'The video encoder reordered frames.');
      }
      lastTimestamp = chunk.timestamp;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, duration: TICKS_PER_FRAME, key: chunk.type === 'key' });
    },
    error: (err) => {
      failure ??= err instanceof Error ? err : new Error(String(err));
    },
  });

  try {
    encoder.configure(config);
    const ctx = canvas.getContext('2d');
    const keyEvery = Math.max(1, Math.round(fps * KEYFRAME_SECONDS));
    for (let index = 0; index < frameCount; index++) {
      checkAbort(signal);
      if (failure) throw failure;
      try {
        await drawFrame(index, ctx);
      } catch (err) {
        throw new ExportError('frame', `Frame ${index + 1} couldn’t be drawn.`, { frameIndex: index, cause: err });
      }
      checkAbort(signal);
      const frame = createFrame(canvas, {
        timestamp: Math.round((index * 1e6) / fps),
        duration: Math.round(1e6 / fps),
      });
      try {
        encoder.encode(frame, { keyFrame: index % keyEvery === 0 });
      } finally {
        frame.close();
      }
      onProgress(index + 1, frameCount);
      let waited = 0;
      let queued = encoder.encodeQueueSize;
      while (encoder.encodeQueueSize > MAX_QUEUE && !failure) {
        checkAbort(signal);
        await wait(WAIT_MS);
        if (encoder.encodeQueueSize < queued) {
          queued = encoder.encodeQueueSize;
          waited = 0;
        } else if ((waited += WAIT_MS) >= ENCODER_STALL_MS) {
          throw new ExportError('stalled', 'The video encoder stopped responding.');
        }
      }
    }
    await withTimeout(encoder.flush(), ENCODER_STALL_MS, wait,
      () => new ExportError('stalled', 'The video encoder stopped responding.'));
    if (failure) throw failure;
    checkAbort(signal);
    if (samples.length !== frameCount) {
      throw new ExportError('dropped', `The video encoder gave back ${samples.length} of ${frameCount} frames.`);
    }
    if (!description) throw new ExportError('config', 'The video encoder gave no H.264 configuration.');
    const { parts, size } = muxMP4({
      video: { width, height, timescale: fps * TICKS_PER_FRAME, description, samples },
      audio,
    });
    const blob = new Blob(parts, { type: 'video/mp4' });
    return { blob, size, codec: config.codec };
  } finally {
    if (encoder.state !== 'closed') {
      try {
        encoder.close();
      } catch {
        // already closed by an error
      }
    }
  }
}

// A file name for the export: the project's name without characters
// file systems refuse, plus the extension.
export function exportFileName(projectName, extension) {
  const base = String(projectName ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return `${base || 'Parapara animation'}.${extension}`;
}

export class ExportError extends Error {
  constructor(code, message, { frameIndex = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ExportError';
    this.code = code;
    this.frameIndex = frameIndex;
  }
}

// `promise`, or a rejection with makeError() once `ms` have passed.
async function withTimeout(promise, ms, wait, makeError) {
  const TIMED_OUT = Symbol('timed out');
  const winner = await Promise.race([promise, wait(ms).then(() => TIMED_OUT)]);
  if (winner === TIMED_OUT) throw makeError();
  return winner;
}

export function isAbort(err) {
  return err?.name === 'AbortError';
}

function checkAbort(signal) {
  if (signal?.aborted) {
    const err = new Error('Export cancelled');
    err.name = 'AbortError';
    throw err;
  }
}

function copyBytes(source) {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
}

function defaultIsConfigSupported(config) {
  return globalThis.VideoEncoder.isConfigSupported(config);
}
