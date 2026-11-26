// Unit tests for brush tips' pure parts (8b-ii): js/canvas/brush.js.
// The tips' pixels are checked in tests/e2e/brush.spec.js.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TIPS, TIP_LABELS, sanitizeTipName, getTip, grainAlpha, seededRandom, GRAIN_TILE, createTrail } from '../../js/canvas/brush.js';

test('every tip has a label, a positive spacing and a stamper', () => {
  for (const name of TIPS) {
    assert.equal(typeof TIP_LABELS[name], 'string');
    const tip = getTip(name);
    // Stamps (8e) sit apart; the other tips overlap into a line.
    if (tip.trail) assert.ok(tip.spacingRatio >= 1, name);
    else assert.ok(tip.spacingRatio > 0 && tip.spacingRatio <= 0.25, name);
    assert.equal(typeof tip.stamper, 'function');
    assert.ok([null, 'fine', 'coarse'].includes(tip.grain), name);
  }
});

test('unknown tip names become Pen', () => {
  assert.equal(sanitizeTipName('pencil'), 'pencil');
  for (const bad of ['crayon', '', null, undefined, 3, {}]) assert.equal(sanitizeTipName(bad), 'pen');
  assert.equal(getTip('crayon'), getTip('pen'));
});

test('grain: pencil and chalk have grain, the rest none', () => {
  assert.equal(getTip('pencil').grain, 'fine');
  assert.equal(getTip('chalk').grain, 'coarse');
  for (const name of ['pen', 'chisel', 'paintbrush', 'soft', 'web', 'star', 'heart']) assert.equal(getTip(name).grain, null);
});

test('stamps (8e): Web, Star and Heart are the trail tips', () => {
  assert.deepEqual(TIPS.filter((name) => getTip(name).trail), ['web', 'star', 'heart']);
});

test('trail: points land every spacing along the whole path, however it is split', () => {
  const whole = createTrail(10).walk({ x: 0, y: 0 }, { x: 35, y: 0 });
  assert.deepEqual(whole.map((p) => p.x), [10, 20, 30]);
  // The same path in uneven pieces gives the same points.
  const trail = createTrail(10);
  const pieces = [];
  let x = 0;
  for (const step of [3, 4, 0, 6, 1, 13, 8]) {
    pieces.push(...trail.walk({ x, y: 0 }, { x: x + step, y: 0 }));
    x += step;
  }
  assert.deepEqual(pieces.map((p) => Math.round(p.x * 1e9) / 1e9), [10, 20, 30]);
  // Turning a corner carries the leftover distance.
  const corner = createTrail(10);
  assert.deepEqual(corner.walk({ x: 0, y: 0 }, { x: 6, y: 0 }), []);
  const after = corner.walk({ x: 6, y: 0 }, { x: 6, y: 20 });
  assert.deepEqual(after.map((p) => Math.round(p.y * 1e9) / 1e9), [4, 14]);
  // A zero-length piece places nothing; spacing below 1 acts as 1.
  assert.deepEqual(createTrail(10).walk({ x: 5, y: 5 }, { x: 5, y: 5 }), []);
  assert.equal(createTrail(0.2).walk({ x: 0, y: 0 }, { x: 3, y: 0 }).length, 3);
});

test('grain is the same every launch, and tiles without a seam', () => {
  for (const kind of ['fine', 'coarse']) {
    const a = grainAlpha(kind);
    assert.equal(a.length, GRAIN_TILE * GRAIN_TILE);
    assert.deepEqual(a, grainAlpha(kind));
    // Neighbors across the wrap differ no more than neighbors inside.
    let inside = 0;
    let across = 0;
    for (let y = 0; y < GRAIN_TILE; y++) {
      inside = Math.max(inside, Math.abs(a[y * GRAIN_TILE + 1] - a[y * GRAIN_TILE]));
      across = Math.max(across, Math.abs(a[y * GRAIN_TILE] - a[y * GRAIN_TILE + GRAIN_TILE - 1]));
    }
    assert.ok(across <= inside + 64, `${kind}: ${across} vs ${inside}`);
  }
});

test('grain: fine (pencil) never fully blocks; coarse (chalk) has real gaps', () => {
  const fine = grainAlpha('fine');
  const coarse = grainAlpha('coarse');
  assert.ok(Math.min(...fine) >= 100);
  const gaps = coarse.filter((v) => v < 64).length / coarse.length;
  assert.ok(gaps > 0.05 && gaps < 0.5, `chalk gaps ${gaps}`);
});

test('seededRandom repeats for a seed and stays in [0, 1)', () => {
  const a = seededRandom(3);
  const b = seededRandom(3);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});
