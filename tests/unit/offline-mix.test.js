// Unit tests for js/audio/offline-mix.js — the export's sound (step 6b),
// mixed offline through the same buildMix and placement as Play. A fake
// OfflineAudioContext records the graph and the scheduled starts.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mixPlan, renderMix } from '../../js/audio/offline-mix.js';

function param(value = 1) {
  return {
    value,
    ramps: [],
    setTargetAtTime(v, at, k) { this.ramps.push([v, at, k]); },
    cancelScheduledValues() {},
  };
}

function node(kind, extra = {}) {
  return { kind, out: [], connect(target) { this.out.push(target); }, ...extra };
}

function fakeContext() {
  const log = { created: null, sources: [], gains: [], compressors: [] };
  const ctx = {
    currentTime: 0,
    destination: node('destination'),
    createGain() { const g = node('gain', { gain: param() }); log.gains.push(g); return g; },
    createDynamicsCompressor() {
      const c = node('compressor', { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
      log.compressors.push(c);
      return c;
    },
    createBufferSource() {
      const s = node('source', { start(...args) { this.started = args; } });
      log.sources.push(s);
      return s;
    },
    async startRendering() { return { rendered: true }; },
  };
  return {
    log,
    createContext: (channels, length, rate) => { log.created = { channels, length, rate }; return ctx; },
  };
}

const music = { id: 'm', kind: 'music', blobRef: 'a', trimStart: 2, trimEnd: 10, offset: 0, volume: 0.6 };
const voice = { id: 'v', kind: 'voice', blobRef: 'b', trimStart: 0.5, trimEnd: 3, offset: 1, gain: 3, leveling: 'loudness', volume: 1.5 };

test('mixPlan places clips like Play: trim, offset, cut at the end; undecoded left out', () => {
  const plan = mixPlan([{ clip: music, buffer: 'A' }, { clip: voice, buffer: 'B' }, { clip: { ...music, id: 'x' }, buffer: null }], 4);
  assert.deepEqual(plan.map(({ clip, at, from, to }) => [clip.id, at, from, to]), [
    ['m', 0, 2, 6],     // 4 s of the music from its trim start
    ['v', 1, 0.5, 3],   // the whole take (2.5 s) fits from 1 s
  ]);
  assert.deepEqual(mixPlan([{ clip: { ...voice, offset: 5 }, buffer: 'B' }], 4), []);
});

test('renderMix: one stereo buffer as long as the video, sources started where the plan says', async () => {
  const fake = fakeContext();
  const result = await renderMix({
    entries: [{ clip: music, buffer: 'A' }, { clip: voice, buffer: 'B' }],
    seconds: 4, sampleRate: 48000, createContext: fake.createContext,
  });
  assert.deepEqual(result, { rendered: true });
  assert.deepEqual(fake.log.created, { channels: 2, length: 4 * 48000, rate: 48000 });
  const [m, v] = fake.log.sources;
  assert.equal(m.buffer, 'A');
  assert.deepEqual(m.started, [0, 2, 4]);
  assert.deepEqual(v.started, [1, 0.5, 2.5]);
  // Through the mix: the voice take's leveling gain, then its compressor,
  // then the Voice bus; the music straight to the Music bus.
  const leveling = v.out[0];
  assert.equal(leveling.gain.value, 3);
  assert.equal(leveling.out[0].kind, 'compressor');
  assert.equal(leveling.out[0].out[0].bus, 'voice');
  assert.equal(m.out[0].bus, 'music');
});

test('renderMix sets the saved volumes at once (no glide from 1 at the start)', async () => {
  const fake = fakeContext();
  await renderMix({
    entries: [{ clip: music, buffer: 'A' }, { clip: voice, buffer: 'B' }],
    seconds: 4, sampleRate: 48000, createContext: fake.createContext,
  });
  const bus = (kind) => fake.log.gains.find((g) => g.bus === kind);
  assert.equal(bus('music').gain.value, 0.6);
  assert.equal(bus('voice').gain.value, 1.5);
  assert.deepEqual(bus('music').gain.ramps, []);
  assert.deepEqual(bus('voice').gain.ramps, []);
});

test('renderMix is null when nothing would play', async () => {
  const fake = fakeContext();
  assert.equal(await renderMix({ entries: [], seconds: 4, sampleRate: 48000, createContext: fake.createContext }), null);
  assert.equal(await renderMix({ entries: [{ clip: music, buffer: null }], seconds: 4, sampleRate: 48000, createContext: fake.createContext }), null);
  assert.equal(fake.log.created, null);
});
