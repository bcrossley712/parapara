// Unit tests for js/export/export.js — the video export loop (step 6a),
// with a fake encoder and frames.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  exportVideo, evenSize, codecCandidates, pickVideoConfig, exportFileName, MAX_QUEUE,
} from '../../js/export/export.js';

const DESCRIPTION = Uint8Array.from([1, 0x64, 0, 0x28]);

// A fake VideoEncoder. Encoded frames wait in `queue` until `drain()`
// (or flush) outputs them.
function fakeEncoder({ supported = ['avc1.640028'], reorder = false, failOn = null, drop = 0, autoDrain = 2 } = {}) {
  const log = { configured: null, encoded: [], maxQueue: 0, closed: false };
  let init;
  const queue = [];
  let sentConfig = false;
  const encoder = {
    state: 'unconfigured',
    get encodeQueueSize() { return queue.length; },
    configure(config) { log.configured = config; this.state = 'configured'; },
    encode(frame, options) {
      if (frame.closed) throw new Error('encoding a closed frame');
      log.encoded.push({ timestamp: frame.init.timestamp, key: options.keyFrame });
      if (failOn === log.encoded.length - 1) {
        init.error(new Error('encoder broke'));
        return;
      }
      queue.push({ timestamp: frame.init.timestamp, key: options.keyFrame });
      log.maxQueue = Math.max(log.maxQueue, queue.length);
      // By default output as soon as two are waiting (so reordering
      // has a pair to swap); autoDrain: 0 leaves it to the test.
      if (autoDrain && queue.length >= autoDrain) this.drain();
    },
    drain(n = queue.length) {
      let items = queue.splice(0, n);
      if (reorder && items.length >= 2) items = [items[1], items[0], ...items.slice(2)];
      for (const item of items) {
        if (drop > 0) { drop--; continue; }
        const chunk = {
          timestamp: item.timestamp,
          type: item.key ? 'key' : 'delta',
          byteLength: 3,
          copyTo(target) { target.set([9, 9, 9]); },
        };
        const meta = sentConfig ? {} : { decoderConfig: { description: DESCRIPTION.buffer.slice(0) } };
        sentConfig = true;
        init.output(chunk, meta);
      }
    },
    async flush() { this.drain(); },
    close() { this.state = 'closed'; log.closed = true; },
  };
  return {
    log,
    encoder,
    createEncoder: (i) => { init = i; return encoder; },
    isConfigSupported: async (config) => ({ supported: supported.includes(config.codec) }),
  };
}

function fakeFrame(source, init) {
  return { init, closed: false, close() { this.closed = true; } };
}

function canvas(width = 1920, height = 1080) {
  return { width, height, getContext: () => ({ tag: 'ctx' }) };
}

async function bytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

test('draws and encodes every frame in order, keyframes every 2 s, makes an MP4', async () => {
  const fake = fakeEncoder();
  const drawn = [];
  const progress = [];
  const result = await exportVideo({
    frameCount: 30,
    fps: 12,
    canvas: canvas(),
    drawFrame: async (i, ctx) => { drawn.push(i); assert.equal(ctx.tag, 'ctx'); },
    onProgress: (done, total) => progress.push(`${done}/${total}`),
    createEncoder: fake.createEncoder,
    createFrame: fakeFrame,
    isConfigSupported: fake.isConfigSupported,
  });
  assert.deepEqual(drawn, [...Array(30).keys()]);
  assert.equal(progress.at(-1), '30/30');
  assert.equal(fake.log.encoded[1].timestamp, Math.round(1e6 / 12));
  assert.deepEqual(fake.log.encoded.flatMap((e, i) => (e.key ? [i] : [])), [0, 24]);
  assert.equal(fake.log.configured.codec, 'avc1.640028');
  assert.deepEqual(fake.log.configured.avc, { format: 'avc' });
  assert.ok(fake.log.closed);
  assert.equal(result.blob.type, 'video/mp4');
  const file = await bytes(result.blob);
  assert.equal(file.length, result.size);
  assert.equal(String.fromCharCode(...file.subarray(4, 8)), 'ftyp');
});

test('waits while the encoder has more than MAX_QUEUE frames', async () => {
  const fake = fakeEncoder({ autoDrain: 0 });
  let waits = 0;
  await exportVideo({
    frameCount: 10,
    fps: 12,
    canvas: canvas(),
    drawFrame: async () => {},
    createEncoder: fake.createEncoder,
    createFrame: fakeFrame,
    isConfigSupported: fake.isConfigSupported,
    wait: async () => { waits++; fake.encoder.drain(1); },
  });
  assert.ok(waits > 0);
  assert.ok(fake.log.maxQueue <= MAX_QUEUE + 1, `queue reached ${fake.log.maxQueue}`);
});

test('falls back to Main, then Baseline; none supported is a clear error', async () => {
  const main = fakeEncoder({ supported: ['avc1.4D0028'] });
  await exportVideo({
    frameCount: 1, fps: 12, canvas: canvas(), drawFrame: async () => {},
    createEncoder: main.createEncoder, createFrame: fakeFrame, isConfigSupported: main.isConfigSupported,
  });
  assert.equal(main.log.configured.codec, 'avc1.4D0028');

  const none = fakeEncoder({ supported: [] });
  await assert.rejects(exportVideo({
    frameCount: 1, fps: 12, canvas: canvas(), drawFrame: async () => {},
    createEncoder: none.createEncoder, createFrame: fakeFrame, isConfigSupported: none.isConfigSupported,
  }), (err) => err.code === 'unsupported');
});

test('cancel stops between frames with an AbortError and closes the encoder', async () => {
  const fake = fakeEncoder();
  const controller = new AbortController();
  const drawn = [];
  await assert.rejects(exportVideo({
    frameCount: 20, fps: 12, canvas: canvas(),
    drawFrame: async (i) => { drawn.push(i); if (i === 4) controller.abort(); },
    signal: controller.signal,
    createEncoder: fake.createEncoder, createFrame: fakeFrame, isConfigSupported: fake.isConfigSupported,
  }), (err) => err.name === 'AbortError');
  assert.deepEqual(drawn, [0, 1, 2, 3, 4]);
  assert.equal(fake.log.encoded.length, 4, 'the frame drawn when cancelled is not encoded');
  assert.ok(fake.log.closed);
});

test('a frame that fails to draw names the frame', async () => {
  const fake = fakeEncoder();
  await assert.rejects(exportVideo({
    frameCount: 5, fps: 12, canvas: canvas(),
    drawFrame: async (i) => { if (i === 2) throw new Error('lost'); },
    createEncoder: fake.createEncoder, createFrame: fakeFrame, isConfigSupported: fake.isConfigSupported,
  }), (err) => err.code === 'frame' && err.frameIndex === 2 && /Frame 3/.test(err.message));
  assert.ok(fake.log.closed);
});

test('encoder errors, reordered frames and dropped frames fail the export', async () => {
  for (const [options, code] of [[{ failOn: 1 }, undefined], [{ reorder: true }, 'reordered'], [{ drop: 1 }, 'dropped']]) {
    const fake = fakeEncoder(options);
    await assert.rejects(exportVideo({
      frameCount: 4, fps: 12, canvas: canvas(), drawFrame: async () => {},
      createEncoder: fake.createEncoder, createFrame: fakeFrame, isConfigSupported: fake.isConfigSupported,
    }), (err) => (code ? err.code === code : /encoder broke/.test(err.message)));
    assert.ok(fake.log.closed);
  }
});

test('evenSize, codec levels, config shape', async () => {
  assert.deepEqual(evenSize({ width: 1921, height: 1081 }), { width: 1920, height: 1080 });
  assert.deepEqual(evenSize({ width: 1, height: 3 }), { width: 2, height: 2 });
  assert.deepEqual(codecCandidates({ width: 1920, height: 1080 }), ['avc1.640028', 'avc1.4D0028', 'avc1.420028']);
  assert.equal(codecCandidates({ width: 2560, height: 1440 })[0], 'avc1.640033');
  const config = await pickVideoConfig({ width: 1920, height: 1080, fps: 7 }, async () => ({ supported: true }));
  assert.equal(config.framerate, 7);
  assert.ok(config.bitrate > 0);
  assert.equal(await pickVideoConfig({ width: 2, height: 2, fps: 1 }, async () => { throw new Error('x'); }), null);
});

test('exportFileName keeps her name, drops what file systems refuse', () => {
  assert.equal(exportFileName('Animation 3', 'mp4'), 'Animation 3.mp4');
  assert.equal(exportFileName('My/cat: "Bo"?', 'mp4'), 'Mycat Bo.mp4');
  assert.equal(exportFileName('  ..  ', 'mp4'), 'Parapara animation.mp4');
  assert.equal(exportFileName('ねこ', 'gif'), 'ねこ.gif');
});

test('an encoder that stops taking frames, or never flushes, fails as stalled', async () => {
  const stuck = fakeEncoder({ autoDrain: 0 });
  let waits = 0;
  await assert.rejects(exportVideo({
    frameCount: 10, fps: 12, canvas: canvas(), drawFrame: async () => {},
    createEncoder: stuck.createEncoder, createFrame: fakeFrame, isConfigSupported: stuck.isConfigSupported,
    wait: async () => { waits++; },
  }), (err) => err.code === 'stalled');
  assert.ok(waits >= 3000 && waits < 3100, `gave up after ${waits} waits`);
  assert.ok(stuck.log.closed);

  const noFlush = fakeEncoder();
  noFlush.encoder.flush = () => new Promise(() => {});
  await assert.rejects(exportVideo({
    frameCount: 2, fps: 12, canvas: canvas(), drawFrame: async () => {},
    createEncoder: noFlush.createEncoder, createFrame: fakeFrame, isConfigSupported: noFlush.isConfigSupported,
    wait: async () => {},
  }), (err) => err.code === 'stalled');
});
