// js/export/aac.js
//
// Owns: turning the export's mixed sound (an AudioBuffer from
// audio/offline-mix.js) into AAC frames for the MP4's audio track
// (step 6b), with WebCodecs' AudioEncoder. mp4.js lays them out.
//
// Knows nothing about projects or the DOM. The encoder, decoder and
// AudioData are passed in (defaults: the browser's), so it's
// unit-tested with fakes (tests/unit/aac.test.js).
//
// Rules (docs/ARCHITECTURE.md, Export):
//   - The AudioSpecificConfig is ours, never the encoder's: WebKit's AAC
//     AudioEncoder writes a malformed one, and an MP4 muxed with it has
//     a silent audio track (WebKit bug 302253, still in Safari 27.0.1).
//     AAC-LC at a fixed rate and channel count needs only these 2 bytes.
//   - Raw AAC frames ('aac' format). ADTS headers, if an encoder adds
//     them anyway, are stripped — MP4 wants bare frames.
//   - Like the video loop: never more than MAX_QUEUE blocks waiting in
//     the encoder, a stall fails after ENCODER_STALL_MS, a cancel stops
//     between blocks.
//   - The encoder's "priming" (silence it puts first) is measured on
//     this device by measurePriming — a short click encoded and decoded
//     — not assumed, so the edit list starts the sound with frame 1
//     exactly. If it can't be measured, the edit skips nothing: the
//     sound may trail by the priming (~20–45 ms), never start early.

import { ENCODER_STALL_MS, ExportError, MAX_QUEUE } from './export.js';

export const AAC_CODEC = 'mp4a.40.2'; // AAC-LC
export const AUDIO_BITRATE = 128_000;
export const AUDIO_CHANNELS = 2;
export const SAMPLE_RATES = [48000, 44100]; // first the encoder takes
export const AAC_FRAME = 1024;              // samples per AAC-LC frame
const BLOCK_FRAMES = 4096;                  // samples per AudioData handed in
const WAIT_MS = 5;

// The priming probe: silence, then a 1 kHz burst starting at PROBE_AT.
export const PROBE_AT = 8192;
const PROBE_LENGTH = PROBE_AT + 8192;
const PROBE_AMPLITUDE = 0.5;
const PROBE_THRESHOLD = 0.1;
export const MAX_PRIMING = 4096;
const PROBE_TIMEOUT_MS = 5000;

// MPEG-4 sampling frequency indices.
const FREQUENCY_INDEX = new Map([
  [96000, 0], [88200, 1], [64000, 2], [48000, 3], [44100, 4], [32000, 5],
  [24000, 6], [22050, 7], [16000, 8], [12000, 9], [11025, 10], [8000, 11],
]);

// The 2-byte AudioSpecificConfig for AAC-LC: object type 2 (5 bits),
// frequency index (4), channel configuration (4), 3 zero bits.
export function audioSpecificConfig(sampleRate, channels) {
  const index = FREQUENCY_INDEX.get(sampleRate);
  if (index === undefined) throw new Error(`No AAC frequency index for ${sampleRate} Hz`);
  if (!(channels >= 1 && channels <= 7)) throw new Error(`Unsupported channel count ${channels}`);
  const bits = (2 << 11) | (index << 7) | (channels << 3);
  return Uint8Array.of(bits >> 8, bits & 0xff);
}

// The AAC frame without its ADTS header, if it has one (sync 0xFFF,
// layer 0); 7 bytes, or 9 with a CRC.
export function stripADTS(bytes) {
  if (bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    const header = (bytes[1] & 0x01) ? 7 : 9;
    return bytes.subarray(header);
  }
  return bytes;
}

export function isAudioExportSupported() {
  return typeof globalThis.AudioEncoder === 'function' && typeof globalThis.AudioData === 'function';
}

// The first AAC config the browser says it can encode, or null.
export async function pickAudioConfig(isConfigSupported = defaultIsConfigSupported) {
  for (const sampleRate of SAMPLE_RATES) {
    const config = {
      codec: AAC_CODEC,
      sampleRate,
      numberOfChannels: AUDIO_CHANNELS,
      bitrate: AUDIO_BITRATE,
      aac: { format: 'aac' },
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

// Encodes `buffer` (AudioBuffer-like: sampleRate, numberOfChannels,
// length, getChannelData(c)) with `config` (pickAudioConfig's; the
// buffer must be at its rate and channel count). Resolves
// { samples: [{ data, duration }], description, encoderDescription }:
// description is ours; encoderDescription is what the encoder gave (for
// the activity log — it shows the WebKit bug), or null.
export async function encodeAAC({
  buffer,
  config,
  signal = null,
  createEncoder = (init) => new globalThis.AudioEncoder(init),
  createData = (init) => new globalThis.AudioData(init),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const { sampleRate, numberOfChannels: channels } = config;
  if (buffer.sampleRate !== sampleRate || buffer.numberOfChannels !== channels) {
    throw new Error(`The sound is ${buffer.sampleRate} Hz × ${buffer.numberOfChannels}, not ${sampleRate} × ${channels}`);
  }
  const samples = [];
  let encoderDescription = null;
  let failure = null;
  const encoder = createEncoder({
    output: (chunk, metadata) => {
      const desc = metadata?.decoderConfig?.description;
      if (desc && !encoderDescription) encoderDescription = copyBytes(desc);
      const raw = new Uint8Array(chunk.byteLength);
      chunk.copyTo(raw);
      const data = stripADTS(raw);
      if (data.length > 0) samples.push({ data: data.slice(), duration: AAC_FRAME });
    },
    error: (err) => {
      failure ??= err instanceof Error ? err : new Error(String(err));
    },
  });
  const stalled = () => new ExportError('stalled', 'The sound encoder stopped responding.');

  try {
    encoder.configure(config);
    const planes = [];
    for (let c = 0; c < channels; c++) planes.push(buffer.getChannelData(c));
    for (let at = 0; at < buffer.length; at += BLOCK_FRAMES) {
      checkAbort(signal);
      if (failure) throw failure;
      const frames = Math.min(BLOCK_FRAMES, buffer.length - at);
      const block = new Float32Array(frames * channels);
      for (let c = 0; c < channels; c++) block.set(planes[c].subarray(at, at + frames), c * frames);
      const data = createData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round((at * 1e6) / sampleRate),
        data: block,
      });
      try {
        encoder.encode(data);
      } finally {
        data.close();
      }
      await drain(encoder, () => failure, signal, wait, stalled);
    }
    await withTimeout(encoder.flush(), ENCODER_STALL_MS, wait, stalled);
    if (failure) throw failure;
    checkAbort(signal);
    if (samples.length === 0) throw new ExportError('audio', 'The sound encoder gave back nothing.');
    return { samples, description: audioSpecificConfig(sampleRate, channels), encoderDescription };
  } finally {
    closeQuietly(encoder);
  }
}

// How many samples of silence this device's AAC encoder puts before the
// sound: a burst at PROBE_AT is encoded and decoded (with our
// AudioSpecificConfig) and found again. Resolves a whole number of
// samples, or null when it can't be measured (no decoder, an error, a
// result outside 0..MAX_PRIMING) — the caller then skips nothing.
export async function measurePriming({
  config,
  createEncoder = (init) => new globalThis.AudioEncoder(init),
  createDecoder = typeof globalThis.AudioDecoder === 'function' ? (init) => new globalThis.AudioDecoder(init) : null,
  createData = (init) => new globalThis.AudioData(init),
  createChunk = (init) => new globalThis.EncodedAudioChunk(init),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof createDecoder !== 'function') return null;
  const { sampleRate, numberOfChannels: channels } = config;
  const probe = probeBuffer(sampleRate, channels);
  let decoder = null;
  try {
    const encoded = await encodeAAC({ buffer: probe, config, createEncoder, createData, wait });
    const decoded = [];
    let failure = null;
    decoder = createDecoder({
      output: (data) => {
        try {
          decoded.push(firstChannel(data));
        } finally {
          data.close();
        }
      },
      error: (err) => { failure ??= err; },
    });
    decoder.configure({ codec: AAC_CODEC, sampleRate, numberOfChannels: channels, description: encoded.description });
    encoded.samples.forEach((s, i) => {
      decoder.decode(createChunk({
        type: 'key',
        timestamp: Math.round((i * AAC_FRAME * 1e6) / sampleRate),
        data: s.data,
      }));
    });
    await withTimeout(decoder.flush(), PROBE_TIMEOUT_MS, wait, () => new Error('decoder timed out'));
    if (failure) return null;
    const onset = findOnset(decoded);
    if (onset === null) return null;
    // Against where the probe itself crosses the threshold (a sample or
    // two after PROBE_AT, as the sine rises), so the rise cancels out.
    const priming = onset - findOnset([probe.getChannelData(0)]);
    return priming >= 0 && priming <= MAX_PRIMING ? priming : null;
  } catch {
    return null;
  } finally {
    if (decoder) closeQuietly(decoder);
  }
}

// The probe: silence, then a sine burst starting at zero (so its onset
// is sharp to within a sample or two) at PROBE_AT, on every channel.
export function probeBuffer(sampleRate, channels) {
  const data = new Float32Array(PROBE_LENGTH);
  for (let i = PROBE_AT; i < PROBE_LENGTH; i++) {
    data[i] = PROBE_AMPLITUDE * Math.sin((2 * Math.PI * 1000 * (i - PROBE_AT)) / sampleRate);
  }
  return {
    sampleRate,
    numberOfChannels: channels,
    length: PROBE_LENGTH,
    getChannelData: () => data,
  };
}

// The first sample index (across the decoded blocks, in order) whose
// level reaches PROBE_THRESHOLD, or null.
export function findOnset(blocks) {
  let at = 0;
  for (const block of blocks) {
    for (let i = 0; i < block.length; i++) {
      if (Math.abs(block[i]) >= PROBE_THRESHOLD) return at + i;
    }
    at += block.length;
  }
  return null;
}

// Channel 0 of a decoded AudioData as floats, whatever its format.
function firstChannel(data) {
  const frames = data.numberOfFrames;
  const format = data.format ?? 'f32-planar';
  if (format === 'f32-planar') {
    const out = new Float32Array(frames);
    data.copyTo(out, { planeIndex: 0 });
    return out;
  }
  if (format === 'f32') {
    const all = new Float32Array(frames * data.numberOfChannels);
    data.copyTo(all, { planeIndex: 0 });
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) out[i] = all[i * data.numberOfChannels];
    return out;
  }
  // Anything else: ask for floats (engines that convert in copyTo).
  const out = new Float32Array(frames);
  data.copyTo(out, { planeIndex: 0, format: 'f32-planar' });
  return out;
}

async function drain(encoder, failed, signal, wait, stalled) {
  let waited = 0;
  let queued = encoder.encodeQueueSize;
  while (encoder.encodeQueueSize > MAX_QUEUE && !failed()) {
    checkAbort(signal);
    await wait(WAIT_MS);
    if (encoder.encodeQueueSize < queued) {
      queued = encoder.encodeQueueSize;
      waited = 0;
    } else if ((waited += WAIT_MS) >= ENCODER_STALL_MS) {
      throw stalled();
    }
  }
}

async function withTimeout(promise, ms, wait, makeError) {
  const TIMED_OUT = Symbol('timed out');
  const winner = await Promise.race([promise, wait(ms).then(() => TIMED_OUT)]);
  if (winner === TIMED_OUT) throw makeError();
  return winner;
}

function checkAbort(signal) {
  if (signal?.aborted) {
    const err = new Error('Export cancelled');
    err.name = 'AbortError';
    throw err;
  }
}

function closeQuietly(codec) {
  if (codec.state === 'closed') return;
  try {
    codec.close();
  } catch {
    // already closed by an error
  }
}

function copyBytes(source) {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
}

function defaultIsConfigSupported(config) {
  return globalThis.AudioEncoder.isConfigSupported(config);
}

// Bytes as hex, for the activity log ("1190").
export function hex(bytes) {
  return bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') : '';
}
