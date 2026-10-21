// Unit tests for js/timeline/clock.js — elapsed time → frame.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  beatAtTime, frameAtTime, frameAtBeat, sanitizeFps, MIN_FPS, MAX_FPS, DEFAULT_FPS, FPS_PRESETS,
} from '../../js/timeline/clock.js';

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

test('playback can start on any frame (4b)', () => {
  // Starting on frame 3 of 5 at 12 fps: beats 0, 1, 2 show 3, 4, then 0.
  assert.deepEqual(frameAtTime(0, 12, 5, { start: 3 }), { index: 3, ended: false });
  assert.deepEqual(frameAtTime(84, 12, 5, { start: 3 }), { index: 4, ended: false });
  assert.deepEqual(frameAtTime(167, 12, 5, { start: 3 }), { index: 0, ended: false });
});

test('without loop, a run from a middle frame ends after the last frame', () => {
  assert.deepEqual(frameAtBeat(1, 5, { loop: false, start: 3 }), { index: 4, ended: false });
  assert.deepEqual(frameAtBeat(2, 5, { loop: false, start: 3 }), { index: 4, ended: true });
});

test('a start outside the timeline is clamped', () => {
  assert.equal(frameAtBeat(0, 3, { start: 9 }).index, 2);
  assert.equal(frameAtBeat(0, 3, { start: -2 }).index, 0);
  assert.equal(frameAtBeat(0, 3, { start: NaN }).index, 0);
});

test('saved fps is clamped to 1–30; anything else is the default 12', () => {
  assert.equal(sanitizeFps(24), 24);
  assert.equal(sanitizeFps(60), MAX_FPS);
  assert.equal(sanitizeFps(0), MIN_FPS);
  assert.equal(sanitizeFps(7.6), 8);
  assert.equal(sanitizeFps('24'), DEFAULT_FPS);
  assert.equal(sanitizeFps(undefined), DEFAULT_FPS);
  assert.equal(sanitizeFps(NaN), DEFAULT_FPS);
  assert.ok(FPS_PRESETS.every((fps) => sanitizeFps(fps) === fps));
});
