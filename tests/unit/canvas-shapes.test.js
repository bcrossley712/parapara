// Unit tests for canvas shapes (after 8b-ii): the sizes a new
// animation can take, and how the frame strip's tiles follow them.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_SHAPES,
  DEFAULT_CANVAS_SHAPE,
  sanitizeCanvasShape,
  createProjectRecord,
} from '../../js/storage/storage.js';
import { tileCssSize, TILE_HEIGHT } from '../../js/timeline/frame-strip.js';

test('the three shapes, with landscape as the default', () => {
  assert.deepEqual(CANVAS_SHAPES.landscape, { width: 1920, height: 1080 });
  assert.deepEqual(CANVAS_SHAPES.portrait, { width: 1080, height: 1920 });
  assert.deepEqual(CANVAS_SHAPES.square, { width: 1080, height: 1080 });
  assert.equal(DEFAULT_CANVAS_SHAPE, 'landscape');
  for (const bad of [undefined, null, '', 'tall', 'toString', '__proto__', 7]) {
    assert.equal(sanitizeCanvasShape(bad), 'landscape', String(bad));
  }
});

test('a new project takes its shape (and gets its own copy of the size)', () => {
  assert.deepEqual(createProjectRecord('A').canvas, { width: 1920, height: 1080 });
  assert.deepEqual(createProjectRecord('A', 'portrait').canvas, { width: 1080, height: 1920 });
  assert.deepEqual(createProjectRecord('A', 'square').canvas, { width: 1080, height: 1080 });
  assert.deepEqual(createProjectRecord('A', 'nonsense').canvas, { width: 1920, height: 1080 });
  const p = createProjectRecord('A', 'portrait');
  p.canvas.width = 1;
  assert.equal(CANVAS_SHAPES.portrait.width, 1080);
});

test('frame tiles follow the shape, within their limits', () => {
  assert.deepEqual(tileCssSize(CANVAS_SHAPES.landscape), { width: 85, height: TILE_HEIGHT });
  assert.deepEqual(tileCssSize(CANVAS_SHAPES.square), { width: 48, height: TILE_HEIGHT });
  // Portrait would be 27 px wide; the tile keeps a tappable minimum.
  assert.deepEqual(tileCssSize(CANVAS_SHAPES.portrait), { width: 36, height: TILE_HEIGHT });
});
