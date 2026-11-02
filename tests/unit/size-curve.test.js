// Unit tests for the brush-size slider's curve (8b-i):
// js/canvas/size-curve.js.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sliderToSize, sizeToSlider, SIZE_SLIDER_STEPS, MIN_BRUSH_SIZE } from '../../js/canvas/size-curve.js';
import { MAX_BRUSH_SIZE } from '../../js/canvas/canvas.js';

test('the ends of the slider are the smallest and largest sizes', () => {
  assert.equal(sliderToSize(0, MAX_BRUSH_SIZE), MIN_BRUSH_SIZE);
  assert.equal(sliderToSize(SIZE_SLIDER_STEPS, MAX_BRUSH_SIZE), MAX_BRUSH_SIZE);
  assert.equal(sizeToSlider(MIN_BRUSH_SIZE, MAX_BRUSH_SIZE), 0);
  assert.equal(sizeToSlider(MAX_BRUSH_SIZE, MAX_BRUSH_SIZE), SIZE_SLIDER_STEPS);
});

test('every whole size round-trips through its slider position', () => {
  for (let size = MIN_BRUSH_SIZE; size <= MAX_BRUSH_SIZE; size++) {
    assert.equal(sliderToSize(sizeToSlider(size, MAX_BRUSH_SIZE), MAX_BRUSH_SIZE), size, `size ${size}`);
  }
});

test('about half the slider covers sizes up to 30', () => {
  const at30 = sizeToSlider(30, MAX_BRUSH_SIZE) / SIZE_SLIDER_STEPS;
  assert.ok(at30 > 0.4 && at30 < 0.55, `30 sits at ${at30}`);
});

test('sizes only grow along the slider', () => {
  let last = 0;
  for (let p = 0; p <= SIZE_SLIDER_STEPS; p++) {
    const size = sliderToSize(p, MAX_BRUSH_SIZE);
    assert.ok(size >= last);
    last = size;
  }
});

test('out-of-range and junk input stay in range', () => {
  assert.equal(sliderToSize(-50, MAX_BRUSH_SIZE), MIN_BRUSH_SIZE);
  assert.equal(sliderToSize(SIZE_SLIDER_STEPS * 3, MAX_BRUSH_SIZE), MAX_BRUSH_SIZE);
  assert.equal(sliderToSize(NaN, MAX_BRUSH_SIZE), MIN_BRUSH_SIZE);
  assert.equal(sizeToSlider(0, MAX_BRUSH_SIZE), 0);
  assert.equal(sizeToSlider(999, MAX_BRUSH_SIZE), SIZE_SLIDER_STEPS);
});
