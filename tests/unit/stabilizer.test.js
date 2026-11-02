// Unit tests for the stabilizer (8a): js/canvas/stabilizer.js.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStabilizer,
  stabilizerLag,
  MAX_STABILIZER,
  MAX_STABILIZER_LAG_MS,
} from '../../js/canvas/stabilizer.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('strength 0 is off: every sample comes straight back', () => {
  const s = createStabilizer(0, { x: 0, y: 0 }, 0);
  assert.deepEqual(s.push({ x: 10, y: 5 }, 8), [{ x: 10, y: 5 }]);
  assert.deepEqual(s.push({ x: 20, y: 7 }, 16), [{ x: 20, y: 7 }]);
  assert.deepEqual(s.tick(100), []);
  assert.deepEqual(s.finish(), []);
});

test('lag grows with strength, gently at first, up to the maximum', () => {
  assert.equal(stabilizerLag(0), 0);
  assert.equal(stabilizerLag(-3), 0);
  assert.equal(stabilizerLag(MAX_STABILIZER), MAX_STABILIZER_LAG_MS);
  assert.equal(stabilizerLag(99), MAX_STABILIZER_LAG_MS);
  let prev = 0;
  for (let n = 1; n <= MAX_STABILIZER; n++) {
    assert.ok(stabilizerLag(n) > prev);
    prev = stabilizerLag(n);
  }
  // Low notches stay subtle: below a straight line.
  assert.ok(stabilizerLag(2) < MAX_STABILIZER_LAG_MS * 0.2);
});

test('the line trails a moving stylus, and trails more when stronger', () => {
  function trailAfterSweep(strength) {
    const s = createStabilizer(strength, { x: 0, y: 0 }, 0);
    let last;
    // 1 px/ms to the right, a sample every 8 ms.
    for (let t = 8; t <= 200; t += 8) [last] = s.push({ x: t, y: 0 }, t);
    return 200 - last.x;
  }
  const weak = trailAfterSweep(2);
  const strong = trailAfterSweep(10);
  assert.ok(weak > 0, 'some trail even when weak');
  assert.ok(strong > weak, `strong ${strong} > weak ${weak}`);
});

test('wobble is smoothed: a zigzag comes out flatter', () => {
  const s = createStabilizer(5, { x: 0, y: 0 }, 0);
  const out = [];
  for (let i = 1; i <= 60; i++) {
    const wobble = i % 2 ? 6 : -6; // ±6 px, every sample
    out.push(...s.push({ x: i * 4, y: wobble }, i * 8));
  }
  const late = out.slice(20);
  const maxY = Math.max(...late.map((p) => Math.abs(p.y)));
  assert.ok(maxY < 3, `wobble cut from 6 to ${maxY.toFixed(2)}`);
});

test('a resting stylus: ticks glide the line up to it, then stop', () => {
  const s = createStabilizer(10, { x: 0, y: 0 }, 0);
  s.push({ x: 100, y: 0 }, 16);
  assert.equal(s.settled, false);
  let t = 16;
  let lastX = -1;
  let frames = 0;
  while (!s.settled && frames < 200) {
    t += 16;
    const [p] = s.tick(t);
    assert.ok(p.x > lastX, 'keeps moving toward the stylus');
    lastX = p.x;
    frames++;
  }
  assert.ok(frames < 200, 'catches up');
  assert.equal(lastX, 100, 'ends exactly on the stylus');
  assert.deepEqual(s.tick(t + 16), [], 'nothing more once caught up');
});

test('lift finishes the line at the stylus', () => {
  const s = createStabilizer(10, { x: 0, y: 0 }, 0);
  s.push({ x: 50, y: 20 }, 8);
  s.push({ x: 80, y: 40 }, 16);
  assert.deepEqual(s.finish(), [{ x: 80, y: 40 }]);
  assert.deepEqual(s.finish(), [], 'already there');
});

test('a sample stamped earlier than the last tick moves nothing but still aims the line', () => {
  const s = createStabilizer(5, { x: 0, y: 0 }, 0);
  s.push({ x: 10, y: 0 }, 10);
  s.tick(30);
  // Coalesced sample from before that tick.
  assert.deepEqual(s.push({ x: 40, y: 0 }, 25), []);
  const [p] = s.tick(60);
  assert.ok(p.x > 10 && p.x < 40);
});

test('the result does not depend on how often samples arrive', () => {
  // Same stylus path (stop at 30 at t=0+), sampled every 4 ms vs 16 ms:
  // the line's position at the same time should match closely.
  function at(step) {
    const s = createStabilizer(7, { x: 0, y: 0 }, 0);
    s.push({ x: 30, y: 0 }, 0.001);
    let p;
    for (let t = step; t <= 96; t += step) [p] = s.tick(t);
    return p.x;
  }
  assert.ok(near(at(4), at(16), 0.01), `${at(4)} vs ${at(16)}`);
});
