// Unit tests for js/timeline/playback.js — getting ready, the decode
// ring, skipping late frames, loop/no-loop and live fps changes.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlayback } from '../../js/timeline/playback.js';

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

// A fake clock and animation-frame queue: frame() runs one "screen
// refresh" at the current time.
function setup({ decodeDelay = false, pendingFrames = 0, ...overrides } = {}) {
  let time = 0;
  let queued = null;
  let pendingLeft = pendingFrames;
  const shown = [];
  const states = [];
  const ended = [];
  const released = [];
  const decodes = [];      // { id, resolve } when decodeDelay
  let live = 0;            // decoded values not yet released
  const playback = createPlayback({
    decode: (id) => {
      live++;
      const value = { id };
      if (!decodeDelay) return Promise.resolve(value);
      return new Promise((resolve) => decodes.push({ id, resolve: () => resolve(value) }));
    },
    release: (value) => {
      live--;
      released.push(value.id);
    },
    show: (id) => shown.push(id),
    pending: () => pendingLeft,
    onChange: (s) => states.push(s),
    onEnd: (id) => ended.push(id),
    now: () => time,
    requestFrame: (fn) => {
      queued = fn;
      return 1;
    },
    cancelFrame: () => {
      queued = null;
    },
    ...overrides,
  });
  return {
    playback,
    shown,
    states,
    ended,
    released,
    decodes,
    get live() { return live; },
    setPending(n) { pendingLeft = n; },
    // Advances the clock to `ms` and runs one refresh.
    async frameAt(ms) {
      time = ms;
      await settle();
      const fn = queued;
      queued = null;
      fn?.();
      await settle();
    },
    get scheduled() { return queued !== null; },
  };
}

const IDS = ['a', 'b', 'c', 'd'];

test('plays from the frame she is on and loops', async () => {
  const t = setup();
  t.playback.start({ ids: IDS, startIndex: 2, fps: 10 });
  await t.frameAt(0);   // decodes the first frames
  await t.frameAt(0);   // first frame decoded: starts
  for (let ms = 100; ms <= 500; ms += 100) await t.frameAt(ms);
  assert.deepEqual(t.shown, ['c', 'd', 'a', 'b', 'c', 'd']);
  assert.equal(t.playback.state, 'playing');
  assert.equal(t.playback.frameId, 'd');
});

test('waits while frames are still being flattened, reporting progress', async () => {
  const t = setup({ pendingFrames: 3 });
  t.playback.start({ ids: IDS, fps: 12 });
  await t.frameAt(0);
  await t.frameAt(500);
  assert.deepEqual(t.shown, [], 'never starts early');
  assert.equal(t.playback.state, 'preparing');
  assert.deepEqual(t.states.at(-1), { state: 'preparing', ready: 1, total: 4 });
  t.setPending(0);
  await t.frameAt(600);
  await t.frameAt(600);
  assert.deepEqual(t.shown, ['a']);
  assert.equal(t.states.at(-1).state, 'playing');
});

test('a frame not decoded by its beat is skipped, never shown late', async () => {
  const t = setup({ decodeDelay: true });
  t.playback.start({ ids: IDS, fps: 10 });
  await t.frameAt(0);
  t.decodes.find((d) => d.id === 'a').resolve();
  await t.frameAt(0);
  assert.deepEqual(t.shown, ['a']);
  // 'b' is still decoding when its beat comes: 'a' stays up.
  await t.frameAt(100);
  assert.deepEqual(t.shown, ['a']);
  for (const d of t.decodes) d.resolve();
  await t.frameAt(150);
  assert.deepEqual(t.shown, ['a'], 'b is not shown after its beat');
  await t.frameAt(200);
  assert.deepEqual(t.shown, ['a', 'c']);
});

test('only a few frames are decoded ahead, and passed ones are released', async () => {
  const t = setup({ ahead: 3 });
  t.playback.start({ ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], fps: 10 });
  await t.frameAt(0);
  await t.frameAt(0);
  for (let ms = 100; ms <= 1000; ms += 100) {
    await t.frameAt(ms);
    assert.ok(t.live <= 5, `at most the ring plus the showing frame decoded (${t.live})`);
  }
  t.playback.stop();
  await settle();
  assert.equal(t.live, 0, 'stop releases everything');
});

test('without loop it ends on the last frame', async () => {
  const t = setup();
  t.playback.start({ ids: IDS, startIndex: 2, fps: 10, loop: false });
  await t.frameAt(0);
  await t.frameAt(0);
  await t.frameAt(100);
  await t.frameAt(200);
  assert.deepEqual(t.shown, ['c', 'd']);
  assert.deepEqual(t.ended, ['d']);
  assert.equal(t.playback.state, 'idle');
  assert.equal(t.scheduled, false, 'the loop stopped');
  await settle();
  assert.equal(t.live, 0);
});

test('stop returns the frame showing; stopping while getting ready returns null', async () => {
  const t = setup();
  t.playback.start({ ids: IDS, fps: 10 });
  await t.frameAt(0);
  await t.frameAt(0);
  await t.frameAt(100);
  assert.equal(t.playback.stop(), 'b');
  assert.equal(t.states.at(-1).state, 'idle');

  const u = setup({ pendingFrames: 2 });
  u.playback.start({ ids: IDS, fps: 10 });
  await u.frameAt(0);
  assert.equal(u.playback.stop(), null);
  assert.equal(u.playback.active, false);
});

test('a decode that finishes after stop is released, not kept', async () => {
  const t = setup({ decodeDelay: true });
  t.playback.start({ ids: IDS, fps: 10 });
  await t.frameAt(0);
  t.playback.stop();
  for (const d of t.decodes) d.resolve();
  await settle();
  assert.equal(t.live, 0);
});

test('changing fps while playing continues from the frame showing, without a jump', async () => {
  const t = setup();
  t.playback.start({ ids: IDS, fps: 10 });
  await t.frameAt(0);
  await t.frameAt(0);
  await t.frameAt(100);         // b
  await t.frameAt(150);
  t.playback.setFps(2);         // 500 ms a frame from here
  await t.frameAt(400);
  assert.deepEqual(t.shown, ['a', 'b'], 'b holds for a whole new beat');
  await t.frameAt(650);
  assert.deepEqual(t.shown, ['a', 'b', 'c']);
});

test('turning loop off while playing ends at the last frame from where it is', async () => {
  const t = setup();
  t.playback.start({ ids: IDS, fps: 10 });
  await t.frameAt(0);
  await t.frameAt(0);
  for (let ms = 100; ms <= 500; ms += 100) await t.frameAt(ms); // ... a, b
  t.playback.setLoop(false);
  for (let ms = 600; ms <= 900; ms += 100) await t.frameAt(ms);
  assert.deepEqual(t.shown, ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd']);
  assert.deepEqual(t.ended, ['d']);
});

test('a frame that will not decode shows blank instead of stopping', async () => {
  const t = setup({
    decode: (id) => (id === 'b' ? Promise.reject(new Error('bad')) : Promise.resolve({ id })),
  });
  t.playback.start({ ids: IDS, fps: 10 });
  await t.frameAt(0);
  await t.frameAt(0);
  await t.frameAt(100);
  await t.frameAt(200);
  assert.deepEqual(t.shown, ['a', 'b', 'c']);
  assert.equal(t.playback.state, 'playing');
});

// Step 5: the clock (the audio clock when there's sound) is told where
// each run starts and is stopped when playback halts; its time drives
// the frames.
function recordingClock() {
  let time = 0;
  const calls = [];
  return {
    calls,
    set(ms) { time = ms; },
    clock: {
      start: (opts) => { calls.push(['start', opts]); time = 0; },
      now: () => time,
      stop: () => calls.push(['stop']),
    },
  };
}

test('the clock starts from the first frame\'s time, once playing', async () => {
  const c = recordingClock();
  const t = setup({ clock: c.clock });
  t.playback.start({ ids: IDS, startIndex: 2, fps: 10, loop: true });
  await t.frameAt(0);
  assert.deepEqual(c.calls, [], 'not while getting ready');
  await t.frameAt(0);
  assert.deepEqual(c.calls, [['start', { position: 0.2, fps: 10, frameCount: 4, loop: true }]]);
  assert.deepEqual(t.shown, ['c']);
});

test('frames follow the clock\'s time, not the refresh timer', async () => {
  const c = recordingClock();
  const t = setup({ clock: c.clock });
  t.playback.start({ ids: IDS, fps: 10 });
  await t.frameAt(0);
  await t.frameAt(0);
  // The refresh timer says 1000 ms, but the sound has only reached 150.
  c.set(150);
  await t.frameAt(1000);
  assert.deepEqual(t.shown, ['a', 'b']);
});

test('changing fps or loop restarts the clock from the frame showing', async () => {
  const c = recordingClock();
  const t = setup({ clock: c.clock });
  t.playback.start({ ids: IDS, fps: 10, loop: true });
  await t.frameAt(0);
  await t.frameAt(0);
  c.set(100);
  await t.frameAt(100); // showing 'b' (index 1)
  t.playback.setFps(5);
  assert.deepEqual(c.calls.at(-1), ['start', { position: 0.2, fps: 5, frameCount: 4, loop: true }]);
  t.playback.setLoop(false);
  assert.deepEqual(c.calls.at(-1), ['start', { position: 0.2, fps: 5, frameCount: 4, loop: false }]);
  c.set(200);
  await t.frameAt(200);
  assert.deepEqual(t.shown, ['a', 'b', 'c']);
});

test('changing fps while getting ready doesn\'t start the clock early', async () => {
  const c = recordingClock();
  const t = setup({ clock: c.clock, pendingFrames: 1 });
  t.playback.start({ ids: IDS, fps: 10 });
  await t.frameAt(0);
  t.playback.setFps(20);
  assert.deepEqual(c.calls, []);
  t.setPending(0);
  await t.frameAt(0);
  await t.frameAt(0);
  assert.deepEqual(c.calls, [['start', { position: 0, fps: 20, frameCount: 4, loop: true }]]);
});

test('stopping, ending, or tearing down stops the clock', async () => {
  for (const how of ['stop', 'end', 'destroy']) {
    const c = recordingClock();
    const t = setup({ clock: c.clock });
    t.playback.start({ ids: IDS, fps: 10, loop: how !== 'end' });
    await t.frameAt(0);
    await t.frameAt(0);
    if (how === 'stop') t.playback.stop();
    if (how === 'destroy') t.playback.destroy();
    if (how === 'end') { c.set(400); await t.frameAt(400); }
    assert.deepEqual(c.calls.at(-1), ['stop'], how);
  }
  // Stopped while getting ready: it never started, so nothing to stop.
  const c = recordingClock();
  const t = setup({ clock: c.clock, pendingFrames: 1 });
  t.playback.start({ ids: IDS, fps: 10 });
  await t.frameAt(0);
  t.playback.stop();
  assert.deepEqual(c.calls, []);
});
