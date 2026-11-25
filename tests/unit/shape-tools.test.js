// Unit tests for the shape tools' geometry (8d): js/canvas/shapes.js.
// (canvas-shapes.test.js is the canvas's aspect — portrait/square.)
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SHAPES,
  DEFAULT_SHAPE,
  sanitizeShape,
  snapTo45,
  lineEnd,
  shapeOutline,
  triangleOutline,
  stampPoints,
} from '../../js/canvas/shapes.js';

const near = (actual, expected, msg) => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg ?? ''} ${actual} ≈ ${expected}`);
};
const nearPoint = (p, q, msg) => {
  near(p.x, q.x, `${msg ?? ''} x`);
  near(p.y, q.y, `${msg ?? ''} y`);
};
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

test('sanitizeShape keeps the four shapes and falls back to Line', () => {
  for (const s of SHAPES) assert.equal(sanitizeShape(s), s);
  assert.equal(DEFAULT_SHAPE, 'line');
  for (const bad of [undefined, null, 'star', 3, {}]) assert.equal(sanitizeShape(bad), 'line');
});

test('snapTo45 snaps to the nearest 45° and keeps the projected length', () => {
  const a = { x: 100, y: 100 };
  // Nearly horizontal → horizontal, length along x.
  nearPoint(snapTo45(a, { x: 200, y: 110 }), { x: 200, y: 100 });
  // Nearly vertical, upward.
  nearPoint(snapTo45(a, { x: 105, y: 20 }), { x: 100, y: 20 });
  // Nearly diagonal (down-left): projection onto (-1, 1)/√2.
  const end = snapTo45(a, { x: 40, y: 165 });
  near(end.x - a.x, -(end.y - a.y), 'diagonal');
  near(dist(a, end), (60 + 65) / Math.SQRT2, 'projected length');
  // No movement stays put.
  nearPoint(snapTo45(a, a), a);
});

test('lineEnd snaps only with Perfect', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 50, y: 7 };
  assert.deepEqual(lineEnd(a, b, false), b);
  nearPoint(lineEnd(a, b, true), { x: 50, y: 0 });
});

test('a line (and a triangle base) is an open two-point path', () => {
  const out = shapeOutline('line', { x: 1, y: 2 }, { x: 30, y: 40 }, false);
  assert.equal(out.closed, false);
  assert.deepEqual(out.points, [{ x: 1, y: 2 }, { x: 30, y: 40 }]);
  assert.equal(shapeOutline('triangle', { x: 1, y: 2 }, { x: 30, y: 40 }, false).closed, false);
});

test('a rectangle runs corner to corner in any drag direction; Perfect is a square', () => {
  const r = shapeOutline('rect', { x: 100, y: 100 }, { x: 40, y: 160 }, false);
  assert.equal(r.closed, true);
  assert.deepEqual(r.points, [
    { x: 100, y: 100 }, { x: 40, y: 100 }, { x: 40, y: 160 }, { x: 100, y: 160 },
  ]);
  // Square: the longer side wins, in the drag's direction.
  const s = shapeOutline('rect', { x: 100, y: 100 }, { x: 70, y: 20 }, true);
  assert.deepEqual(s.points, [
    { x: 100, y: 100 }, { x: 20, y: 100 }, { x: 20, y: 20 }, { x: 100, y: 20 },
  ]);
});

test('an oval is centered on the start, its box corner at the drag; Perfect is a circle', () => {
  const c = { x: 500, y: 400 };
  const o = shapeOutline('oval', c, { x: 600, y: 350 }, false);
  assert.equal(o.closed, true);
  const xs = o.points.map((p) => p.x);
  const ys = o.points.map((p) => p.y);
  near(Math.max(...xs), 600);
  near(Math.min(...xs), 400);
  near(Math.max(...ys), 450);
  near(Math.min(...ys), 350);
  const circle = shapeOutline('oval', c, { x: 600, y: 350 }, true);
  for (const p of circle.points) near(dist(c, p), 100, 'radius');
  // Chords stay short on a big oval, and a tiny one still has a shape.
  const big = shapeOutline('oval', c, { x: 1400, y: 1000 }, false);
  for (let i = 1; i < big.points.length; i++) {
    assert.ok(dist(big.points[i - 1], big.points[i]) <= 5, 'short chords');
  }
  assert.ok(shapeOutline('oval', c, { x: 502, y: 401 }, false).points.length >= 24);
});

test('a free triangle puts its third corner where she lifts', () => {
  const t = triangleOutline({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 20, y: 70 }, false);
  assert.equal(t.closed, true);
  assert.deepEqual(t.points, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 20, y: 70 }]);
});

test('a perfect triangle is equilateral, on the side of the base she picks', () => {
  const a = { x: 100, y: 500 };
  const b = { x: 300, y: 500 };
  const h = 100 * Math.sqrt(3);
  const up = triangleOutline(a, b, { x: 900, y: 10 }, true);
  nearPoint(up.points[2], { x: 200, y: 500 - h }, 'up');
  const down = triangleOutline(a, b, { x: -50, y: 501 }, true);
  nearPoint(down.points[2], { x: 200, y: 500 + h }, 'down');
  for (const t of [up, down]) {
    const [p, q, r] = t.points;
    near(dist(p, q), 200);
    near(dist(q, r), 200);
    near(dist(r, p), 200);
  }
  // A tilted base works too.
  const tilted = triangleOutline({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, true);
  const [p, q, r] = tilted.points;
  near(dist(q, r), dist(p, q));
  near(dist(r, p), dist(p, q));
  assert.ok(r.x > r.y, 'on the side of the corner (above-right of y = x)');
});

test('a perfect triangle with its corner exactly on the base points up (or left)', () => {
  const flat = triangleOutline({ x: 0, y: 100 }, { x: 100, y: 100 }, { x: 50, y: 100 }, true);
  assert.ok(flat.points[2].y < 100, 'up');
  const upright = triangleOutline({ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 50 }, true);
  assert.ok(upright.points[2].x < 100, 'left');
  // Reversed base, same rule.
  const flatReversed = triangleOutline({ x: 100, y: 100 }, { x: 0, y: 100 }, { x: 50, y: 100 }, true);
  assert.ok(flatReversed.points[2].y < 100, 'up, reversed');
});

test('stampPoints spaces stamps evenly round corners, ends on an open path', () => {
  // A 10 × 10 square at spacing 4: 40 px of path → stamps at 0, 4, … 36;
  // the corner at 10 gets none of its own, and the start isn't repeated.
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const closed = stampPoints(square, true, 4);
  assert.equal(closed.length, 10);
  nearPoint(closed[0], { x: 0, y: 0 });
  nearPoint(closed[3], { x: 10, y: 2 }, 'carried past the corner');
  nearPoint(closed[9], { x: 0, y: 4 });
  // An open line: every 4 px, then its end.
  const line = stampPoints([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, 4);
  assert.deepEqual(line.map((p) => p.x), [0, 4, 8, 10]);
  // No length → one stamp.
  assert.deepEqual(stampPoints([{ x: 5, y: 5 }, { x: 5, y: 5 }], false, 4), [{ x: 5, y: 5 }]);
  assert.deepEqual(stampPoints([], true, 4), []);
});
