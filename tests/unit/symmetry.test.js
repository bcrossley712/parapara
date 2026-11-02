// Unit tests for symmetry (8b-i): js/canvas/symmetry.js.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYMMETRY_MODES,
  sanitizeSymmetry,
  mirrorPoints,
  mergeOverlapping,
} from '../../js/canvas/symmetry.js';

const W = 1920;
const H = 1080;
const xy = (points) => points.map(({ x, y }) => [x, y]);

test('sanitizeSymmetry keeps the four modes and turns anything else off', () => {
  for (const mode of SYMMETRY_MODES) assert.equal(sanitizeSymmetry(mode), mode);
  for (const bad of [undefined, null, '', 'diagonal', 'Vertical', 1, {}]) {
    assert.equal(sanitizeSymmetry(bad), 'off');
  }
});

test('off returns only the point itself, unflipped', () => {
  assert.deepEqual(mirrorPoints({ x: 100, y: 200 }, 'off', W, H), [
    { x: 100, y: 200, flipX: false, flipY: false },
  ]);
});

test('vertical mirrors left and right across the center line', () => {
  const out = mirrorPoints({ x: 100, y: 200 }, 'vertical', W, H);
  assert.deepEqual(xy(out), [[100, 200], [1820, 200]]);
  assert.deepEqual(out.map((p) => [p.flipX, p.flipY]), [[false, false], [true, false]]);
});

test('horizontal mirrors top and bottom', () => {
  const out = mirrorPoints({ x: 100, y: 200 }, 'horizontal', W, H);
  assert.deepEqual(xy(out), [[100, 200], [100, 880]]);
  assert.deepEqual(out.map((p) => [p.flipX, p.flipY]), [[false, false], [false, true]]);
});

test('both gives four copies in a fixed order: original, x-flip, y-flip, both', () => {
  const out = mirrorPoints({ x: 100, y: 200 }, 'both', W, H);
  assert.deepEqual(xy(out), [[100, 200], [1820, 200], [100, 880], [1820, 880]]);
  assert.deepEqual(out.map((p) => [p.flipX, p.flipY]), [
    [false, false], [true, false], [false, true], [true, true],
  ]);
});

test('a point on the axis mirrors onto itself (stamped twice, same place)', () => {
  assert.deepEqual(xy(mirrorPoints({ x: 960, y: 50 }, 'vertical', W, H)), [[960, 50], [960, 50]]);
});

test('mergeOverlapping leaves separate rects alone', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 100, y: 0, w: 10, h: 10 };
  assert.deepEqual(mergeOverlapping([a, b]), [a, b]);
});

test('mergeOverlapping joins overlapping rects, chained ones too, and drops nulls', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 5, y: 5, w: 10, h: 10 };   // overlaps a
  const c = { x: 14, y: 14, w: 10, h: 10 };  // overlaps b only
  const d = { x: 500, y: 500, w: 1, h: 1 };
  const out = mergeOverlapping([a, null, b, c, undefined, d]);
  assert.deepEqual(out, [{ x: 0, y: 0, w: 24, h: 24 }, d]);
});

test('mergeOverlapping treats touching edges as separate (no shared pixel)', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 10, y: 0, w: 10, h: 10 };
  assert.equal(mergeOverlapping([a, b]).length, 2);
});

test('mergeOverlapping does not change its input', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 5, y: 5, w: 10, h: 10 };
  mergeOverlapping([a, b]);
  assert.deepEqual(a, { x: 0, y: 0, w: 10, h: 10 });
});
