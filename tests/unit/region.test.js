// Unit tests for js/canvas/region.js — inkBounds (4d's copy drawing),
// flipSpan (8c's flip).
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inkBounds, flipSpan } from '../../js/canvas/region.js';

function image(width, height, inked = []) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x, y, a = 255] of inked) data[(y * width + x) * 4 + 3] = a;
  return data;
}

test('a blank image has no ink bounds', () => {
  assert.equal(inkBounds(image(5, 4), 5, 4), null);
});

test('one pixel, including a barely visible one, is a 1×1 box', () => {
  assert.deepEqual(inkBounds(image(5, 4, [[3, 2, 1]]), 5, 4), { x: 3, y: 2, w: 1, h: 1 });
});

test('the box covers every inked pixel, whichever row reaches furthest', () => {
  const data = image(10, 8, [[4, 1], [1, 3], [8, 5], [5, 6]]);
  assert.deepEqual(inkBounds(data, 10, 8), { x: 1, y: 1, w: 8, h: 6 });
});

test('ink at the edges reaches the edges', () => {
  const data = image(6, 3, [[0, 0], [5, 2]]);
  assert.deepEqual(inkBounds(data, 6, 3), { x: 0, y: 0, w: 6, h: 3 });
});

test('a horizontal flip changes the drawing and its mirror across the vertical center line', () => {
  // A 100-wide drawing near the left of a 1920 canvas: its mirror is
  // near the right, so the span reaches across both.
  assert.deepEqual(flipSpan({ x: 10, y: 50, w: 100, h: 20 }, 'horizontal', 1920, 1080),
    { x: 10, y: 50, w: 1900, h: 20 });
  // Already centered: the span is the drawing itself.
  assert.deepEqual(flipSpan({ x: 860, y: 0, w: 200, h: 5 }, 'horizontal', 1920, 1080),
    { x: 860, y: 0, w: 200, h: 5 });
});

test('a vertical flip changes the drawing and its mirror across the horizontal center line', () => {
  assert.deepEqual(flipSpan({ x: 10, y: 1000, w: 100, h: 30 }, 'vertical', 1920, 1080),
    { x: 10, y: 50, w: 100, h: 980 });
});

test('the flip span is symmetric about the center line, on a portrait canvas too', () => {
  const r = flipSpan({ x: 3, y: 7, w: 41, h: 13 }, 'horizontal', 1080, 1920);
  assert.equal(r.x, 1080 - (r.x + r.w));
  const v = flipSpan({ x: 3, y: 7, w: 41, h: 13 }, 'vertical', 1080, 1920);
  assert.equal(v.y, 1920 - (v.y + v.h));
});
