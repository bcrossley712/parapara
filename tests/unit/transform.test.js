// Unit tests for the reference image placement math (step 3a) in
// js/canvas/transform.js. The pointer routing in canvas.js's adjust
// mode is covered by tests/e2e/reference.spec.js; stylus feel is
// device-only.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fitPlacement,
  clampImageScale,
  dragPlacement,
  pinchPlacement,
  placementMatrix,
  flipPlacement,
  samePlacement,
  sanitizePlacement,
  DEFAULT_IMAGE_OPACITY,
  MIN_IMAGE_SIDE,
  MAX_IMAGE_ZOOM,
} from '../../js/canvas/transform.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ''} ${a} ≈ ${b}`);

// Where image pixel (px, py) lands on the canvas under a matrix.
function apply(m, px, py) {
  const [a, b, c, d, e, f] = m;
  return { x: a * px + c * py + e, y: b * px + d * py + f };
}

test('a fresh import fits inside the canvas, centered, at 50%', () => {
  const wide = fitPlacement(4000, 1000, 1920, 1080);
  assert.deepEqual(wide, {
    x: 960, y: 540, scale: 1920 / 4000, rotation: 0, opacity: DEFAULT_IMAGE_OPACITY, flipX: false, flipY: false,
  });
  const tall = fitPlacement(1000, 2000, 1920, 1080);
  assert.equal(tall.scale, 1080 / 2000);
  assert.equal(DEFAULT_IMAGE_OPACITY, 0.5);
});

const SIZE = (imageW, imageH) => ({ imageW, imageH, canvasW: 1920, canvasH: 1080 });

test('scale is clamped so the image never vanishes or explodes', () => {
  assert.equal(clampImageScale(0.0001, SIZE(1000, 500)), MIN_IMAGE_SIDE / 1000);
  assert.equal(clampImageScale(100, SIZE(1000, 500)), (MAX_IMAGE_ZOOM * 1920) / 1000);
  assert.equal(clampImageScale(1.5, SIZE(1000, 500)), 1.5);
});

test('a small image can always fill the canvas (fit is within the limits)', () => {
  const fit = fitPlacement(40, 30, 1920, 1080);
  assert.equal(clampImageScale(fit.scale, SIZE(40, 30)), fit.scale);
});

test('one finger moves the image by exactly how far the finger moved', () => {
  const start = fitPlacement(1000, 1000, 1920, 1080);
  const moved = dragPlacement(start, { x: 100, y: 100 }, { x: 150, y: 80 });
  assert.equal(moved.x, start.x + 50);
  assert.equal(moved.y, start.y - 20);
  assert.equal(moved.scale, start.scale);
  assert.equal(moved.opacity, start.opacity);
});

test('a pinch keeps the image point under the fingers under them', () => {
  const start = { x: 500, y: 400, scale: 1, rotation: 0, opacity: 0.5 };
  const a0 = { x: 400, y: 400 };
  const b0 = { x: 600, y: 400 };
  // Fingers spread to twice the distance, the pair turns 90° and the
  // midpoint moves.
  const a1 = { x: 700, y: 100 };
  const b1 = { x: 700, y: 500 };
  const next = pinchPlacement(start, { a0, b0, a1, b1, turned: Math.PI / 2 }, SIZE(1000, 1000));
  close(next.scale, 2, 'scale');
  close(next.rotation, Math.PI / 2, 'rotation');
  // The image point that was under finger a0 is under a1 now.
  const w = 1000;
  const h = 1000;
  const before = placementMatrix(start, w, h);
  const after = placementMatrix(next, w, h);
  // Invert `before` for a0: start has no rotation and scale 1.
  const imgPt = { x: a0.x - before[4], y: a0.y - before[5] };
  const landed = apply(after, imgPt.x, imgPt.y);
  close(landed.x, a1.x, 'x');
  close(landed.y, a1.y, 'y');
});

test('rotation keeps accumulating past 180° (no snap)', () => {
  const start = { x: 0, y: 0, scale: 1, rotation: 3, opacity: 1 };
  const p = { x: 0, y: 0 };
  const q = { x: 10, y: 0 };
  const next = pinchPlacement(start, { a0: p, b0: q, a1: p, b1: q, turned: 1 }, SIZE(100, 100));
  close(next.rotation, 4);
});

test('a pinch clamped at max scale still keeps the midpoint fixed', () => {
  const max = (MAX_IMAGE_ZOOM * 1920) / 100;
  const start = { x: 500, y: 500, scale: max, rotation: 0, opacity: 1 };
  const a0 = { x: 400, y: 500 };
  const b0 = { x: 600, y: 500 };
  const a1 = { x: 300, y: 500 };
  const b1 = { x: 700, y: 500 };
  const next = pinchPlacement(start, { a0, b0, a1, b1, turned: 0 }, SIZE(100, 100));
  assert.equal(next.scale, max);
  close(next.x, 500);
  close(next.y, 500);
});

test('the matrix puts the image center at (x, y) and honors unit/origin', () => {
  const p = { x: 300, y: 200, scale: 2, rotation: 0.7, opacity: 1 };
  const m = placementMatrix(p, 80, 60);
  const center = apply(m, 40, 30);
  close(center.x, 300);
  close(center.y, 200);
  const thumb = placementMatrix(p, 80, 60, { unit: 0.25, originX: 100, originY: 50 });
  const c2 = apply(thumb, 40, 30);
  close(c2.x, (300 - 100) * 0.25);
  close(c2.y, (200 - 50) * 0.25);
  // Corner distance from center = half-diagonal × scale × unit.
  const corner = apply(thumb, 0, 0);
  close(Math.hypot(corner.x - c2.x, corner.y - c2.y), 50 * 2 * 0.25);
});

test('samePlacement compares every field, and null only equals null', () => {
  const p = { x: 1, y: 2, scale: 3, rotation: 4, opacity: 0.5 };
  assert.ok(samePlacement(p, { ...p }));
  assert.ok(!samePlacement(p, { ...p, opacity: 0.6 }));
  assert.ok(samePlacement(null, null));
  assert.ok(!samePlacement(p, null));
});

test('a broken saved placement falls back field by field', () => {
  const clean = sanitizePlacement({ x: 'no', y: 10, scale: -1, rotation: NaN, opacity: 7 }, 1000, 500, 1920, 1080);
  const fit = fitPlacement(1000, 500, 1920, 1080);
  assert.deepEqual(clean, { x: fit.x, y: 10, scale: fit.scale, rotation: 0, opacity: 1, flipX: false, flipY: false });
  assert.deepEqual(sanitizePlacement(null, 1000, 500, 1920, 1080), fit);
});

// --- flip (3b) ---

test('flip fields survive sanitize, and anything but true reads as false', () => {
  const kept = sanitizePlacement({ x: 1, y: 2, scale: 1, rotation: 0, opacity: 1, flipX: true, flipY: true }, 100, 100, 1920, 1080);
  assert.equal(kept.flipX, true);
  assert.equal(kept.flipY, true);
  // 3a records have no flip fields.
  const old = sanitizePlacement({ x: 1, y: 2, scale: 1, rotation: 0, opacity: 1 }, 100, 100, 1920, 1080);
  assert.equal(old.flipX, false);
  assert.equal(old.flipY, false);
  const odd = sanitizePlacement({ flipX: 'yes', flipY: 1 }, 100, 100, 1920, 1080);
  assert.equal(odd.flipX, false);
  assert.equal(odd.flipY, false);
});

test('samePlacement counts flips, and a missing flip equals false', () => {
  const p = { x: 1, y: 2, scale: 3, rotation: 4, opacity: 0.5 };
  assert.ok(samePlacement(p, { ...p, flipX: false, flipY: false }));
  assert.ok(!samePlacement(p, { ...p, flipX: true }));
  assert.ok(!samePlacement(p, { ...p, flipY: true }));
});

// Mirror a canvas point across the vertical / horizontal line through c.
const mirrorH = (pt, c) => ({ x: 2 * c.x - pt.x, y: pt.y });
const mirrorV = (pt, c) => ({ x: pt.x, y: 2 * c.y - pt.y });

for (const rotation of [0, 0.7, -2.1, Math.PI / 2]) {
  test(`a flip mirrors the image as seen on screen (rotation ${rotation.toFixed(2)})`, () => {
    const p = { x: 300, y: 200, scale: 2, rotation, opacity: 1 };
    const before = placementMatrix(p, 80, 60);
    for (const [direction, mirror] of [['horizontal', mirrorH], ['vertical', mirrorV]]) {
      const flipped = flipPlacement(p, direction);
      assert.equal(flipped.x, p.x);
      assert.equal(flipped.y, p.y);
      assert.equal(flipped.scale, p.scale);
      const after = placementMatrix(flipped, 80, 60);
      // Every image pixel lands where its old spot, mirrored across
      // the image center, was.
      for (const [px, py] of [[0, 0], [80, 0], [0, 60], [17, 43]]) {
        const want = mirror(apply(before, px, py), p);
        const got = apply(after, px, py);
        close(got.x, want.x, `${direction} x`);
        close(got.y, want.y, `${direction} y`);
      }
    }
  });
}

test('flipping twice looks the same as not flipping', () => {
  const p = { x: 300, y: 200, scale: 2, rotation: 0.7, opacity: 1, flipX: false, flipY: false };
  for (const direction of ['horizontal', 'vertical']) {
    const twice = flipPlacement(flipPlacement(p, direction), direction);
    assert.ok(samePlacement(twice, p), direction);
  }
});

test('a pinch keeps the flip and still turns the image the way the fingers turn', () => {
  const start = flipPlacement({ x: 500, y: 500, scale: 1, rotation: 0.3, opacity: 1 }, 'horizontal');
  const a0 = { x: 400, y: 500 };
  const b0 = { x: 600, y: 500 };
  const turned = 0.5;
  const a1 = { x: 500 - 100 * Math.cos(turned), y: 500 - 100 * Math.sin(turned) };
  const b1 = { x: 500 + 100 * Math.cos(turned), y: 500 + 100 * Math.sin(turned) };
  const next = pinchPlacement(start, { a0, b0, a1, b1, turned }, SIZE(100, 100));
  assert.equal(next.flipX, true);
  // The image pixel under finger b at the start is under it now.
  const m0 = placementMatrix(start, 100, 100);
  const m1 = placementMatrix(next, 100, 100);
  const inv = invert(m0);
  const local = apply(inv, b0.x, b0.y);
  const now = apply(m1, local.x, local.y);
  close(now.x, b1.x);
  close(now.y, b1.y);
});

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
