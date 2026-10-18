// Unit tests for the undo/redo and reset-view gesture classifiers in
// js/canvas/gestures.js, and the dirty-rect helpers in
// js/canvas/region.js. The pointer dispatch in canvas.js isn't
// covered here — multi-touch is device-checked (see PROJECT_NOTES.md).
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyThreeFinger,
  isDoubleTap,
  centroid,
  DOUBLE_TAP_MAX_GAP_MS,
} from '../../js/canvas/gestures.js';
import { rectAroundPoint, unionRect, clampRect } from '../../js/canvas/region.js';

test('a short, still three-finger touch is a tap', () => {
  assert.equal(classifyThreeFinger({ durationMs: 150, dx: 3, dy: -2, maxTravel: 6 }), 'tap');
});

test('a three-finger drag left is swipe-left, right is swipe-right', () => {
  assert.equal(classifyThreeFinger({ durationMs: 400, dx: -120, dy: 10, maxTravel: 125 }), 'swipe-left');
  assert.equal(classifyThreeFinger({ durationMs: 400, dx: 90, dy: -20, maxTravel: 95 }), 'swipe-right');
});

test('a mostly vertical or too-short three-finger drag is ignored', () => {
  assert.equal(classifyThreeFinger({ durationMs: 400, dx: 70, dy: 60, maxTravel: 95 }), null);
  assert.equal(classifyThreeFinger({ durationMs: 400, dx: -40, dy: 0, maxTravel: 40 }), null);
});

test('a slow, still three-finger hold is not a tap', () => {
  assert.equal(classifyThreeFinger({ durationMs: 900, dx: 0, dy: 0, maxTravel: 4 }), null);
});

test('two two-finger taps close together are a double-tap', () => {
  assert.equal(isDoubleTap(null, 1000), false);
  assert.equal(isDoubleTap(1000, 1000 + DOUBLE_TAP_MAX_GAP_MS), true);
  assert.equal(isDoubleTap(1000, 1001 + DOUBLE_TAP_MAX_GAP_MS), false);
});

test('centroid averages the points', () => {
  assert.deepEqual(centroid([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 9 }]), { x: 2, y: 3 });
});

test('rectAroundPoint covers the stamp plus an antialias margin', () => {
  const r = rectAroundPoint({ x: 100.5, y: 50 }, 10);
  assert.ok(r.x <= 100.5 - 5 - 1 && r.y <= 50 - 5 - 1);
  assert.ok(r.x + r.w >= 100.5 + 5 + 1 && r.y + r.h >= 50 + 5 + 1);
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.w));
});

test('unionRect grows to contain both, and handles null', () => {
  assert.deepEqual(unionRect(null, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: -1, w: 1, h: 1 }), { x: 0, y: -1, w: 6, h: 3 });
  assert.equal(unionRect(null, null), null);
});

test('clampRect trims to the canvas and returns null when outside', () => {
  assert.deepEqual(clampRect({ x: -5, y: -5, w: 10, h: 10 }, 100, 100), { x: 0, y: 0, w: 5, h: 5 });
  assert.deepEqual(clampRect({ x: 95, y: 90, w: 10, h: 20 }, 100, 100), { x: 95, y: 90, w: 5, h: 10 });
  assert.equal(clampRect({ x: 120, y: 0, w: 10, h: 10 }, 100, 100), null);
  assert.equal(clampRect(null, 100, 100), null);
});
