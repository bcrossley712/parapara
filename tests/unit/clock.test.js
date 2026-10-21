// Unit tests for js/timeline/clock.js — elapsed time → frame.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { beatAtTime, frameAtTime } from '../../js/timeline/clock.js';

test('beats advance with elapsed time, not with calls', () => {
  assert.equal(beatAtTime(0, 12), 0);
  assert.equal(beatAtTime(83, 12), 0);
  assert.equal(beatAtTime(84, 12), 1);
  assert.equal(beatAtTime(2500, 24), 60);
});

test('exact beat boundaries never land a beat early through rounding', () => {
  for (const fps of [1, 6, 8, 12, 15, 24, 25, 30, 60]) {
    for (let beat = 0; beat <= 600; beat++) {
      assert.equal(beatAtTime((beat * 1000) / fps, fps), beat, `fps ${fps}, beat ${beat}`);
    }
  }
});

test('negative or missing time and bad fps give beat 0', () => {
  assert.equal(beatAtTime(-50, 12), 0);
  assert.equal(beatAtTime(NaN, 12), 0);
  assert.equal(beatAtTime(1000, 0), 0);
});

test('looping wraps to the first frame', () => {
  assert.deepEqual(frameAtTime(0, 12, 3), { index: 0, ended: false });
  assert.deepEqual(frameAtTime(250, 12, 3), { index: 0, ended: false }); // beat 3
  assert.deepEqual(frameAtTime(1000, 12, 5), { index: 2, ended: false }); // beat 12
});

test('a slow caller skips frames instead of slowing down', () => {
  // 500 ms in at 12 fps is beat 6 whether or not beats 1–5 were drawn.
  assert.equal(frameAtTime(500, 12, 48).index, 6);
});

test('without looping, playback holds the last frame and ends', () => {
  assert.deepEqual(frameAtTime(249, 12, 3, { loop: false }), { index: 2, ended: false });
  assert.deepEqual(frameAtTime(250, 12, 3, { loop: false }), { index: 2, ended: true });
  assert.deepEqual(frameAtTime(9999, 12, 3, { loop: false }), { index: 2, ended: true });
});

test('a single frame always shows itself', () => {
  assert.equal(frameAtTime(12345, 24, 1).index, 0);
});
