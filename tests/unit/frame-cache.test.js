// Unit tests for js/timeline/frame-cache.js — the flattened-frame
// cache's invalidation and rebuild order.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFrameCache, layerSignature } from '../../js/timeline/frame-cache.js';

// Manual clock: timers only fire when the test advances time.
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map(); // id -> { at, fn }
  return {
    now: () => now,
    set(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(id) {
      pending.delete(id);
    },
    // Moves time forward, running due timers (and the promise work
    // they start) in order.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        let due = null;
        for (const [id, t] of pending) {
          if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

// A build whose results the test releases by hand.
function manualBuild() {
  const calls = [];
  const build = (id) => new Promise((resolve, reject) => {
    calls.push({ id, resolve, reject });
  });
  return { build, calls };
}

function setup(overrides = {}) {
  const timers = fakeTimers();
  const { build, calls } = manualBuild();
  const updates = [];
  const disposed = [];
  const cache = createFrameCache({
    build,
    timers,
    onUpdate: (id, value) => updates.push([id, value]),
    dispose: (value) => disposed.push(value),
    onError: () => {},
    ...overrides,
  });
  return { cache, timers, calls, updates, disposed };
}

test('the layer signature covers visible layers, order and opacity only', () => {
  const a = { id: 'a', name: 'Sketch', visible: true, opacity: 1, locked: false };
  const b = { id: 'b', name: 'Ink', visible: true, opacity: 0.5, locked: false };
  assert.equal(layerSignature([a, b]), 'a:1|b:0.5');
  assert.equal(layerSignature([b, a]), 'b:0.5|a:1');
  assert.equal(layerSignature([a, { ...b, visible: false }]), 'a:1');
  assert.equal(layerSignature([a, { ...b, opacity: 0 }]), 'a:1');
  // Renaming or locking doesn't change what a frame looks like.
  assert.equal(layerSignature([{ ...a, name: 'x', locked: true }, b]), layerSignature([a, b]));
});

test('builds wait for changes to settle, then go nearest the current frame first', async () => {
  const { cache, timers, calls } = setup();
  cache.setSignature('s1');
  cache.setFrames(['f1', 'f2', 'f3', 'f4', 'f5'], 'f3');
  await timers.advance(299);
  assert.equal(calls.length, 0, 'nothing before the settle time');
  const order = [];
  for (let i = 0; i < 5; i++) {
    await timers.advance(300);
    assert.equal(calls.length, i + 1, 'one build at a time');
    order.push(calls[i].id);
    calls[i].resolve(`v-${calls[i].id}`);
  }
  assert.deepEqual(order, ['f3', 'f4', 'f2', 'f5', 'f1']);
  await timers.advance(0);
  assert.equal(cache.staleCount, 0);
});

test('a fresh value is stored and reported; a replaced one is disposed', async () => {
  const { cache, timers, calls, updates, disposed } = setup();
  cache.setFrames(['f1'], 'f1');
  await timers.advance(300);
  calls[0].resolve('old');
  await timers.advance(0);
  assert.equal(cache.get('f1'), 'old');
  assert.deepEqual(updates, [['f1', 'old']]);

  cache.touch('f1');
  assert.equal(cache.get('f1'), null, 'stale after a touch');
  assert.equal(cache.latest('f1'), 'old', 'the stale value stays available');
  await timers.advance(300);
  calls[1].resolve('new');
  await timers.advance(0);
  assert.equal(cache.get('f1'), 'new');
  assert.deepEqual(disposed, ['old']);
});

test('a signature change makes every frame stale; changing it back makes them fresh again', async () => {
  const { cache, timers, calls } = setup();
  cache.setSignature('a:1');
  cache.setFrames(['f1', 'f2'], 'f1');
  for (let i = 0; i < 2; i++) {
    await timers.advance(300);
    calls[i].resolve(`v${i}`);
  }
  await timers.advance(0);
  assert.equal(cache.staleCount, 0);

  cache.setSignature('a:0.5');
  assert.equal(cache.staleCount, 2);
  cache.setSignature('a:1'); // e.g. undoing the opacity change
  assert.equal(cache.staleCount, 0);
  await timers.advance(1000);
  assert.equal(calls.length, 2, 'nothing rebuilt');
});

test('dragging a slider restarts the settle time instead of starting builds', async () => {
  const { cache, timers, calls } = setup();
  cache.setFrames(['f1', 'f2'], 'f1');
  for (let i = 1; i <= 20; i++) {
    cache.setSignature(`a:${i / 20}`);
    await timers.advance(50);
  }
  assert.equal(calls.length, 0, 'no builds while the value keeps changing');
  await timers.advance(300);
  assert.equal(calls.length, 1);
});

test('a result that went stale while it was building is thrown away', async () => {
  const { cache, timers, calls, updates, disposed } = setup();
  cache.setFrames(['f1'], 'f1');
  await timers.advance(300);
  assert.equal(calls.length, 1);
  cache.touch('f1'); // she drew while it was building
  calls[0].resolve('too-old');
  await timers.advance(0);
  assert.equal(cache.get('f1'), null);
  assert.deepEqual(updates, []);
  assert.deepEqual(disposed, ['too-old']);
  // It's rebuilt once things settle again.
  await timers.advance(300);
  assert.equal(calls.length, 2);
  calls[1].resolve('current');
  await timers.advance(0);
  assert.equal(cache.get('f1'), 'current');
});

test('the same goes for a signature change mid-build', async () => {
  const { cache, timers, calls, disposed } = setup();
  cache.setSignature('a:1');
  cache.setFrames(['f1'], 'f1');
  await timers.advance(300);
  cache.setSignature('a:1|b:1');
  calls[0].resolve('without-b');
  await timers.advance(0);
  assert.equal(cache.get('f1'), null);
  assert.deepEqual(disposed, ['without-b']);
});

test('no background work while canWork() is false; it resumes on its own', async () => {
  let ok = false;
  const { cache, timers, calls } = setup({ canWork: () => ok });
  cache.setFrames(['f1'], 'f1');
  await timers.advance(2000);
  assert.equal(calls.length, 0);
  ok = true;
  await timers.advance(250);
  assert.equal(calls.length, 1);
});

test('removed frames are dropped and disposed; a frame removed mid-build is not stored', async () => {
  const { cache, timers, calls, disposed } = setup();
  cache.setFrames(['f1', 'f2'], 'f1');
  await timers.advance(300);
  calls[0].resolve('one');
  await timers.advance(300);
  assert.equal(calls[1].id, 'f2');
  cache.setFrames(['f2'], 'f2'); // f1 taken out (undo add frame)
  assert.deepEqual(disposed, ['one']);
  cache.setFrames([], null);     // and f2, while it builds
  calls[1].resolve('two');
  await timers.advance(0);
  assert.deepEqual(disposed, ['one', 'two']);
  assert.equal(cache.latest('f2'), null);
});

test('a failed build is not retried until that frame changes', async () => {
  const errors = [];
  const { cache, timers, calls } = setup({ onError: (err, id) => errors.push([err.message, id]) });
  cache.setFrames(['f1'], 'f1');
  await timers.advance(300);
  calls[0].reject(new Error('decode failed'));
  await timers.advance(5000);
  assert.equal(calls.length, 1, 'no retry loop');
  assert.deepEqual(errors, [['decode failed', 'f1']]);
  cache.touch('f1');
  await timers.advance(300);
  assert.equal(calls.length, 2);
});

test('destroy stops work and disposes everything, including a late result', async () => {
  const { cache, timers, calls, disposed } = setup();
  cache.setFrames(['f1', 'f2'], 'f1');
  await timers.advance(300);
  calls[0].resolve('one');
  await timers.advance(300);
  cache.destroy();
  assert.deepEqual(disposed, ['one']);
  calls[1].resolve('two');
  await timers.advance(1000);
  assert.deepEqual(disposed, ['one', 'two']);
  assert.equal(calls.length, 2);
});
