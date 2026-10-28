// Unit tests for js/export/aac.js — the export's sound track (step 6b):
// our AudioSpecificConfig (the WebKit bug workaround), ADTS stripping,
// the encode loop's rules, and measuring the encoder's priming.
//
// The fake "AAC" codec here passes samples through: the encoder puts
// `priming` zeros first, then emits 1024-sample frames whose bytes are
// channel 0's floats; the decoder gives them back. That's enough to
// check the probe finds the priming, as a real codec's decoded output
// would show it.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  audioSpecificConfig, stripADTS, pickAudioConfig, encodeAAC, measurePriming,
  findOnset, probeBuffer, hex, AAC_FRAME, PROBE_AT, MAX_PRIMING,
} from '../../js/export/aac.js';
import { MAX_QUEUE, ENCODER_STALL_MS } from '../../js/export/export.js';

const CONFIG = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000, aac: { format: 'aac' } };

function fakeData(init) {
  return { ...init, closed: false, close() { this.closed = true; } };
}

// A pass-through "AAC" encoder (see the header). `adts`: each frame
// gets a 7-byte ADTS header. `description`: what it reports as its own
// config (WebKit's is malformed). `autoDrain`: false holds frames.
function fakeCodec({ priming = 0, adts = false, description = Uint8Array.of(0xde, 0xad), autoDrain = true, failFlush = false } = {}) {
  const log = { configured: null, data: [], maxQueue: 0, closed: false, decoderConfig: null };
  let pending = [];   // channel-0 samples not yet in a frame
  let queue = [];     // blocks handed in, not yet "encoded"
  let sentConfig = false;
  let init;
  function emitFrames(final) {
    while (pending.length >= AAC_FRAME || (final && pending.length > 0)) {
      const frame = new Float32Array(AAC_FRAME);
      frame.set(pending.splice(0, AAC_FRAME));
      let data = new Uint8Array(frame.buffer);
      if (adts) data = Uint8Array.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0xfc, ...data]);
      const meta = sentConfig ? {} : { decoderConfig: { description } };
      sentConfig = true;
      init.output({ byteLength: data.length, copyTo: (t) => t.set(data) }, meta);
    }
  }
  const encoder = {
    state: 'unconfigured',
    get encodeQueueSize() { return queue.length; },
    configure(config) {
      log.configured = config;
      this.state = 'configured';
      pending = Array.from({ length: priming }, () => 0);
    },
    encode(data) {
      if (data.closed) throw new Error('encoding closed data');
      log.data.push({ timestamp: data.timestamp, frames: data.numberOfFrames, format: data.format, data: data.data });
      queue.push(data.data.subarray(0, data.numberOfFrames)); // channel 0 (planar)
      log.maxQueue = Math.max(log.maxQueue, queue.length);
      if (autoDrain) this.drain();
    },
    drain() {
      for (const block of queue) pending.push(...block);
      queue = [];
      emitFrames(false);
    },
    async flush() {
      if (failFlush) return new Promise(() => {});
      this.drain();
      emitFrames(true);
    },
    close() { this.state = 'closed'; log.closed = true; },
  };
  const decoder = {
    state: 'unconfigured',
    configure(config) { log.decoderConfig = config; this.state = 'configured'; },
    decode(chunk) {
      const floats = new Float32Array(chunk.data.slice().buffer);
      this.out({
        numberOfFrames: floats.length,
        numberOfChannels: 2,
        format: 'f32-planar',
        copyTo: (target) => target.set(floats),
        close() {},
      });
    },
    async flush() {},
    close() { this.state = 'closed'; },
  };
  return {
    log,
    encoder,
    createEncoder: (i) => { init = i; return encoder; },
    createDecoder: ({ output }) => { decoder.out = output; return decoder; },
    createChunk: (i) => i,
    createData: fakeData,
  };
}

function buffer(seconds, sampleRate = 48000, fill = (i) => (i % 100) / 100) {
  const length = Math.round(seconds * sampleRate);
  const left = Float32Array.from({ length }, (_, i) => fill(i));
  const right = Float32Array.from({ length }, (_, i) => -fill(i));
  return { sampleRate, numberOfChannels: 2, length, getChannelData: (c) => (c === 0 ? left : right) };
}

test('AudioSpecificConfig: AAC-LC, frequency index, channels — 2 bytes', () => {
  assert.equal(hex(audioSpecificConfig(48000, 2)), '1190');
  assert.equal(hex(audioSpecificConfig(44100, 2)), '1210');
  assert.equal(hex(audioSpecificConfig(48000, 1)), '1188');
  assert.throws(() => audioSpecificConfig(47000, 2), /frequency index/);
});

test('stripADTS drops a 7- or 9-byte header, leaves raw frames alone', () => {
  const raw = Uint8Array.of(0x21, 0x10, 5, 6);
  assert.deepEqual(stripADTS(raw), raw);
  assert.deepEqual([...stripADTS(Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 0, 0, 0xfc, 0x21, 0x10))], [0x21, 0x10]);
  assert.deepEqual([...stripADTS(Uint8Array.of(0xff, 0xf0, 0x50, 0x80, 0, 0, 0xfc, 1, 2, 0x21))], [0x21]);
});

test('pickAudioConfig: 48 kHz, then 44.1 kHz; none is null', async () => {
  const only441 = async (c) => ({ supported: c.sampleRate === 44100 });
  assert.equal((await pickAudioConfig(async () => ({ supported: true }))).sampleRate, 48000);
  assert.equal((await pickAudioConfig(only441)).sampleRate, 44100);
  assert.equal(await pickAudioConfig(async () => ({ supported: false })), null);
  assert.equal(await pickAudioConfig(async () => { throw new Error('nope'); }), null);
  const config = await pickAudioConfig(async () => ({ supported: true }));
  assert.equal(config.codec, 'mp4a.40.2');
  assert.equal(config.numberOfChannels, 2);
  assert.deepEqual(config.aac, { format: 'aac' });
});

test('encodeAAC: planar blocks in time order, our config not the encoder’s, ADTS stripped', async () => {
  const codec = fakeCodec({ adts: true });
  const sound = buffer(0.25); // 12000 samples
  const result = await encodeAAC({ buffer: sound, config: CONFIG, ...codec });
  assert.equal(codec.log.configured, CONFIG);
  // Blocks of 4096 samples, timestamps in µs.
  assert.deepEqual(codec.log.data.map((d) => d.timestamp), [0, Math.round((4096 * 1e6) / 48000), Math.round((8192 * 1e6) / 48000)]);
  assert.deepEqual(codec.log.data.map((d) => d.frames), [4096, 4096, 12000 - 8192]);
  assert.ok(codec.log.data.every((d) => d.format === 'f32-planar'));
  // Planar: channel 0's block, then channel 1's.
  const first = codec.log.data[0].data;
  assert.equal(first.length, 4096 * 2);
  assert.equal(first[1], sound.getChannelData(0)[1]);
  assert.equal(first[4096 + 1], sound.getChannelData(1)[1]);
  // 12000 samples → 12 frames (the last padded), each 1024 long, header gone.
  assert.equal(result.samples.length, Math.ceil(12000 / AAC_FRAME));
  assert.ok(result.samples.every((s) => s.duration === AAC_FRAME && s.data.length === AAC_FRAME * 4));
  assert.equal(hex(result.description), '1190');
  assert.equal(hex(result.encoderDescription), 'dead');
  assert.ok(codec.log.closed);
});

test('encodeAAC: never more than MAX_QUEUE blocks waiting; a stall fails', async () => {
  const codec = fakeCodec({ autoDrain: false });
  let waits = 0;
  const wait = async () => { if (++waits % 3 === 0) codec.encoder.drain(); };
  await encodeAAC({ buffer: buffer(1), config: CONFIG, ...codec, wait });
  assert.ok(codec.log.maxQueue <= MAX_QUEUE + 1, `max queue ${codec.log.maxQueue}`);

  const stuck = fakeCodec({ autoDrain: false });
  await assert.rejects(
    encodeAAC({ buffer: buffer(1), config: CONFIG, ...stuck, wait: async () => {} }),
    (err) => err.code === 'stalled',
  );
  assert.ok(stuck.log.closed);

  const neverFlushes = fakeCodec({ failFlush: true });
  await assert.rejects(
    encodeAAC({
      buffer: buffer(0.1), config: CONFIG, ...neverFlushes,
      wait: (ms) => (ms >= ENCODER_STALL_MS ? Promise.resolve() : new Promise(() => {})),
    }),
    (err) => err.code === 'stalled',
  );
});

test('encodeAAC: cancel stops with an AbortError; a wrong rate is refused', async () => {
  const controller = new AbortController();
  const codec = fakeCodec({ autoDrain: false });
  const wait = async () => { controller.abort(); };
  await assert.rejects(
    encodeAAC({ buffer: buffer(1), config: CONFIG, ...codec, signal: controller.signal, wait }),
    (err) => err.name === 'AbortError',
  );
  assert.ok(codec.log.closed);
  await assert.rejects(encodeAAC({ buffer: buffer(0.1, 44100), config: CONFIG, ...fakeCodec() }), /44100/);
});

test('measurePriming finds the encoder’s silence, using our config to decode', async () => {
  for (const priming of [0, 1024, 2112]) {
    const codec = fakeCodec({ priming });
    const measured = await measurePriming({ config: CONFIG, ...codec });
    assert.equal(measured, priming);
    assert.equal(hex(codec.log.decoderConfig.description), '1190');
  }
});

test('measurePriming gives null when it can’t tell (no decoder, too much, an error)', async () => {
  assert.equal(await measurePriming({ config: CONFIG, ...fakeCodec(), createDecoder: null }), null);
  assert.equal(await measurePriming({ config: CONFIG, ...fakeCodec({ priming: MAX_PRIMING + 500 }) }), null);
  const broken = fakeCodec();
  broken.createEncoder = () => { throw new Error('no AAC'); };
  assert.equal(await measurePriming({ config: CONFIG, ...broken }), null);
});

test('findOnset and the probe: silence, then the burst at PROBE_AT', () => {
  const probe = probeBuffer(48000, 2);
  const data = probe.getChannelData(0);
  assert.ok(data.subarray(0, PROBE_AT).every((v) => v === 0));
  const onset = findOnset([data.subarray(0, 5000), data.subarray(5000)]);
  assert.ok(onset >= PROBE_AT && onset <= PROBE_AT + 3);
  assert.equal(findOnset([new Float32Array(10)]), null);
});
