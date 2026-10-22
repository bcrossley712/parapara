// Unit tests for js/canvas/ink-map.js — noticing a layer canvas that
// lost its pixels, without tripping on her own erasing.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  INK_CELL,
  MIN_LOST_CELLS,
  inkGrid,
  emptyInk,
  inkFromRgba,
  countInk,
  markEdited,
  compareInk,
  looksLost,
} from '../../js/canvas/ink-map.js';

const grid = inkGrid(1920, 1080); // 240 × 135

// Ink in every cell of [c0..c1] × [r0..r1].
function inkBlock(c0, r0, c1, r1, base = emptyInk(grid)) {
  const ink = base.slice();
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) ink[r * grid.cols + c] = 1;
  return ink;
}

function cells(c0, r0, c1, r1) {
  return { x: c0 * INK_CELL, y: r0 * INK_CELL, w: (c1 - c0 + 1) * INK_CELL, h: (r1 - r0 + 1) * INK_CELL };
}

test('the grid covers the canvas, rounding up', () => {
  assert.deepEqual(inkGrid(1920, 1080), { cols: 240, rows: 135 });
  assert.deepEqual(inkGrid(100, 50), { cols: 13, rows: 7 });
});

test('ink is any alpha above zero', () => {
  const g = { cols: 3, rows: 1 };
  const rgba = new Uint8ClampedArray([0, 0, 0, 0, 255, 0, 0, 1, 0, 0, 0, 255]);
  assert.deepEqual([...inkFromRgba(rgba, g)], [0, 1, 1]);
});

test('a canvas that went blank looks lost', () => {
  const drawing = inkBlock(50, 30, 120, 90);
  const result = compareInk(drawing, emptyInk(grid), null);
  assert.equal(result.lost, result.had);
  assert.ok(looksLost(result));
});

test('erasing a big area on purpose does not look lost', () => {
  const drawing = inkBlock(50, 30, 120, 90);
  // She erased most of it: every erased cell was edited.
  const edited = markEdited(null, cells(50, 30, 110, 90), grid);
  const now = inkBlock(111, 30, 120, 90);
  const result = compareInk(drawing, now, edited);
  assert.ok(!looksLost(result), JSON.stringify(result));
});

test('erasing everything, stroke by stroke, does not look lost', () => {
  const drawing = inkBlock(50, 30, 120, 90);
  let edited = null;
  for (let r = 30; r <= 90; r += 5) edited = markEdited(edited, cells(50, r, 120, Math.min(90, r + 4)), grid);
  assert.ok(!looksLost(compareInk(drawing, emptyInk(grid), edited)));
});

test('losing ink outside her edits looks lost, even with edits elsewhere', () => {
  const drawing = inkBlock(50, 30, 120, 90);
  const edited = markEdited(null, cells(10, 10, 20, 20), grid); // a stroke somewhere else
  const now = inkBlock(10, 10, 20, 20); // only that stroke survives
  assert.ok(looksLost(compareInk(drawing, now, edited)));
});

test('edits mark a one-cell margin and stay inside the grid', () => {
  const edited = markEdited(null, { x: 0, y: 0, w: 1, h: 1 }, grid);
  assert.equal(edited[0], 1);
  assert.equal(edited[1], 1); // margin to the right
  assert.equal(edited[grid.cols], 1); // and below
  assert.equal(edited[2], 0);
  const corner = markEdited(null, { x: 1919, y: 1079, w: 5, h: 5 }, grid);
  assert.equal(corner[grid.cols * grid.rows - 1], 1);
  assert.equal(corner.length, grid.cols * grid.rows);
});

test('small differences (resampling noise, tiny drawings) are ignored', () => {
  const drawing = inkBlock(50, 30, 120, 90);
  const noisy = drawing.slice();
  for (let i = 0; i < MIN_LOST_CELLS - 1; i++) noisy[(30 + i) * grid.cols + 50] = 0;
  assert.ok(!looksLost(compareInk(drawing, noisy, null)));

  const tiny = inkBlock(5, 5, 6, 6); // 4 cells
  assert.ok(!looksLost(compareInk(tiny, emptyInk(grid), null)));
});

test('a few lost cells in a big drawing are under the share', () => {
  const drawing = inkBlock(0, 0, 99, 99); // 10,000 cells
  const now = drawing.slice();
  for (let i = 0; i < 100; i++) now[i] = 0; // 1% gone
  const result = compareInk(drawing, now, null);
  assert.equal(result.lost, 100);
  assert.ok(!looksLost(result));
  assert.equal(countInk(drawing), 10000);
});
