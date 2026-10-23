// Unit tests for js/canvas/region.js — inkBounds (4d's copy drawing).
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inkBounds } from '../../js/canvas/region.js';

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
