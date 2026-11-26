// Unit tests for smudge's pure blending (8e): js/canvas/smudge.js.
// How it looks on the canvas is in tests/e2e/smudge.spec.js.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { falloff, smudgeMask, startBuffer, smudgeDab, smudgeRates, SMUDGE_SPACING_RATIO, DEFAULT_SMUDGE_STRENGTH } from '../../js/canvas/smudge.js';

// A size × size patch filled with one RGBA color.
function patch(size, [r, g, b, a]) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < data.length; j += 4) data.set([r, g, b, a], j);
  return data;
}
const pixel = (data, size, x, y) => Array.from(data.slice((y * size + x) * 4, (y * size + x) * 4 + 4));

test('falloff: full at the center, fading to nothing at the edge', () => {
  assert.equal(falloff(0), 1);
  assert.equal(falloff(1), 0);
  assert.equal(falloff(2), 0);
  let last = 1;
  for (let t = 0; t <= 1; t += 0.05) {
    assert.ok(falloff(t) <= last + 1e-9);
    last = falloff(t);
  }
});

test('mask: soft round, nothing outside the circle (no hard edge)', () => {
  const size = 20;
  const mask = smudgeMask(size);
  assert.equal(mask.length, size * size);
  assert.equal(mask[0], 0); // a corner
  assert.ok(mask[10 * size + 10] > 0.9);
  // The rim is faint: no step from strong to nothing.
  assert.ok(mask[10 * size + 0] < 0.1);
  assert.equal(smudgeMask(size), mask); // cached
});

test('a dab carrying the same color changes nothing', () => {
  const size = 12;
  const data = patch(size, [200, 40, 40, 255]);
  const before = data.slice();
  const buffer = startBuffer(data);
  assert.equal(smudgeDab(data, buffer, smudgeMask(size), 1), false);
  assert.deepEqual(data, before);
});

test('a dab drags carried color in, strongest at the center, untouched outside', () => {
  const size = 16;
  const red = patch(size, [255, 0, 0, 255]);
  const buffer = startBuffer(red);
  const data = patch(size, [0, 0, 255, 255]);
  assert.equal(smudgeDab(data, buffer, smudgeMask(size), 1), true);
  const center = pixel(data, size, 8, 8);
  const rim = pixel(data, size, 8, 1);
  // One dab is a small step (a pass is many dabs).
  assert.ok(center[0] > 20 && center[2] < 240, `center ${center}`);
  assert.ok(rim[0] < center[0], 'fades toward the rim');
  assert.deepEqual(pixel(data, size, 0, 0), [0, 0, 255, 255], 'corner outside the circle');
  // The carried color picked some blue up.
  assert.ok(buffer[(8 * size + 8) * 4 + 2] > 0);
});

test('strength: a weaker smudge moves less color', () => {
  const size = 16;
  const run = (strength) => {
    const buffer = startBuffer(patch(size, [255, 0, 0, 255]));
    const data = patch(size, [0, 0, 255, 255]);
    smudgeDab(data, buffer, smudgeMask(size), strength);
    return pixel(data, size, 8, 8)[0];
  };
  assert.ok(run(0.2) < run(DEFAULT_SMUDGE_STRENGTH / 100));
  assert.ok(run(DEFAULT_SMUDGE_STRENGTH / 100) < run(1));
});

test('smudging paint into empty canvas fades it out, never drags black in', () => {
  const size = 16;
  const buffer = startBuffer(patch(size, [255, 200, 0, 255]));
  const data = patch(size, [0, 0, 0, 0]);
  smudgeDab(data, buffer, smudgeMask(size), 1);
  const center = pixel(data, size, 8, 8);
  assert.ok(center[3] > 0 && center[3] < 255, `alpha ${center[3]}`);
  // Same hue as the paint (unpremultiplied), not darkened.
  assert.ok(center[0] >= 250 && center[1] >= 195, `color ${center}`);
  // And empty canvas smudged into paint thins it.
  const thin = patch(size, [255, 200, 0, 255]);
  smudgeDab(thin, startBuffer(patch(size, [0, 0, 0, 0])), smudgeMask(size), 1);
  assert.ok(pixel(thin, size, 8, 8)[3] < 255);
});

test('color runs out along a drag: each dab carries less of where it started', () => {
  const size = 16;
  const buffer = startBuffer(patch(size, [255, 0, 0, 255]));
  const mask = smudgeMask(size);
  const reds = [];
  for (let i = 0; i < 40; i++) {
    const data = patch(size, [0, 0, 255, 255]);
    smudgeDab(data, buffer, mask, DEFAULT_SMUDGE_STRENGTH / 100);
    reds.push(pixel(data, size, 8, 8)[0]);
  }
  for (let i = 1; i < reds.length; i++) assert.ok(reds[i] <= reds[i - 1], `${reds}`);
  assert.ok(reds[reds.length - 1] < reds[0] / 2, `${reds}`);
});

test('rates: stronger lays down more per dab and carries color farther', () => {
  const weak = smudgeRates(0.2);
  const strong = smudgeRates(1);
  assert.ok(strong.deposit > weak.deposit);
  assert.ok(strong.pickup < weak.pickup);
  for (const { deposit, pickup } of [weak, strong]) {
    assert.ok(deposit > 0 && deposit < 1);
    assert.ok(pickup > 0 && pickup < 1);
  }
});

test('one pass over a pixel moves it most of the way at full strength, never all', () => {
  // A row of dabs passing over one pixel at the center line, carrying
  // red over blue, with the carried color topped up (a long red smear).
  const size = 40;
  const mask = smudgeMask(size);
  const step = Math.max(1, Math.round(size * SMUDGE_SPACING_RATIO));
  const run = (strength) => {
    const { deposit } = smudgeRates(strength);
    let blue = 1;
    for (let offset = -size / 2; offset < size / 2; offset += step) {
      const x = Math.floor(size / 2 + offset);
      if (x < 0 || x >= size) continue;
      blue *= 1 - mask[(size / 2) * size + x] * deposit;
    }
    return 1 - blue;
  };
  const full = run(1);
  const half = run(0.5);
  assert.ok(full > 0.6 && full < 0.95, `full ${full}`);
  assert.ok(half > 0.25 && half < full, `half ${half}`);
});

test('dabs sit close together (smooth drag)', () => {
  assert.ok(SMUDGE_SPACING_RATIO > 0 && SMUDGE_SPACING_RATIO <= 0.25);
});
