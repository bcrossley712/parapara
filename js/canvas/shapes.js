// js/canvas/shapes.js
//
// Shape tools (8d), pure: the outline of each shape as a polyline in
// canvas pixels. canvas.js stamps the active Draw tip along it (one
// continuous path, spacing carried round the corners) through the
// stroke buffer, so undo, symmetry and lock/hide work as for a stroke.
//
// Line: start → end. Rectangle: corner to corner. Oval: from its
// center, the drag's end at the corner of its box (Sketchbook's way).
// Triangle: two steps — a base drawn like a Line, then a third corner
// (triangleOutline). Perfect: the line and the triangle's base snap to
// 45° steps, the rectangle is a square, the oval a circle, the
// triangle equilateral on its base (the third corner only picks a
// side). Decisions: DESIGN_NOTES → "8d scoping".

export const SHAPES = ['line', 'rect', 'oval', 'triangle'];
export const DEFAULT_SHAPE = 'line';

export const SHAPE_LABELS = {
  line: 'Line',
  rect: 'Rectangle',
  oval: 'Oval',
  triangle: 'Triangle',
};

export function sanitizeShape(value) {
  return SHAPES.includes(value) ? value : DEFAULT_SHAPE;
}

// The longest chord of an oval's polyline, in canvas px — short enough
// that the stamped outline reads as a curve at any brush size.
const OVAL_CHORD_PX = 4;
const OVAL_MIN_SEGMENTS = 24;
const OVAL_MAX_SEGMENTS = 2048;

// `end` moved onto the nearest 45° direction from `start`, keeping its
// distance along that direction (its projection), so the line stays
// under the stylus as nearly as a snapped line can.
export function snapTo45(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return { x: end.x, y: end.y };
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const along = dx * ux + dy * uy;
  // Exact zeros on the axes (cos(π/2) isn't quite 0).
  const clean = (v) => (Math.abs(v) < 1e-9 ? 0 : v);
  return { x: start.x + clean(ux * along), y: start.y + clean(uy * along) };
}

// Where a Line (or a triangle's base) ends, Perfect applied.
export function lineEnd(start, end, perfect) {
  return perfect ? snapTo45(start, end) : { x: end.x, y: end.y };
}

// The outline of a one-step shape (line, rect, oval; a triangle's
// first step is its base, a line). Returns { points, closed }.
export function shapeOutline(shape, start, end, perfect) {
  if (shape === 'rect') return rectOutline(start, end, perfect);
  if (shape === 'oval') return ovalOutline(start, end, perfect);
  return { points: [{ x: start.x, y: start.y }, lineEnd(start, end, perfect)], closed: false };
}

const sign = (v) => (v < 0 ? -1 : 1);

function rectOutline(start, end, perfect) {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (perfect) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = sign(dx) * side;
    dy = sign(dy) * side;
  }
  const { x, y } = start;
  return {
    points: [{ x, y }, { x: x + dx, y }, { x: x + dx, y: y + dy }, { x, y: y + dy }],
    closed: true,
  };
}

function ovalOutline(center, end, perfect) {
  let rx = Math.abs(end.x - center.x);
  let ry = Math.abs(end.y - center.y);
  if (perfect) rx = ry = Math.max(rx, ry);
  // Ramanujan's approximation — only to pick a segment count.
  const h = ((rx - ry) ** 2) / (((rx + ry) ** 2) || 1);
  const perimeter = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  // A multiple of 4, so the outline passes through its four extremes
  // exactly (the oval fills its box).
  const wanted = Math.min(OVAL_MAX_SEGMENTS, Math.max(OVAL_MIN_SEGMENTS, Math.ceil(perimeter / OVAL_CHORD_PX)));
  const n = Math.ceil(wanted / 4) * 4;
  const points = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    points.push({ x: center.x + rx * Math.cos(t), y: center.y + ry * Math.sin(t) });
  }
  return { points, closed: true };
}

// The triangle's second step: base a → b (already snapped, if
// Perfect), third corner at `corner`. Perfect makes it equilateral on
// the base, on the side of the base `corner` is on; exactly on the
// base's line, it points up (or left, for an upright base).
export function triangleOutline(a, b, corner, perfect) {
  if (!perfect) {
    return { points: [{ ...a }, { ...b }, { x: corner.x, y: corner.y }], closed: true };
  }
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const length = Math.hypot(bx, by);
  if (length === 0) return { points: [{ ...a }, { ...b }, { ...a }], closed: true };
  // Normal to the base; pick the one on the corner's side.
  let nx = -by / length;
  let ny = bx / length;
  const side = (corner.x - a.x) * nx + (corner.y - a.y) * ny;
  if (side < 0 || (side === 0 && (ny > 0 || (ny === 0 && nx > 0)))) {
    nx = -nx;
    ny = -ny;
  }
  const height = (length * Math.sqrt(3)) / 2;
  const apex = { x: (a.x + b.x) / 2 + nx * height, y: (a.y + b.y) / 2 + ny * height };
  return { points: [{ ...a }, { ...b }, apex], closed: true };
}

// Where to stamp along a polyline: every `spacing` px of its length,
// carried across corners (so a corner gets no extra stamp), starting
// at its first point. An open path also gets its last point; a closed
// one goes back to its start without stamping it twice. A path with
// no length is one stamp.
export function stampPoints(points, closed, spacing) {
  if (points.length === 0) return [];
  const path = closed && points.length > 1 ? [...points, points[0]] : points;
  const out = [];
  let next = 0;
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;
    while (next < walked + length) {
      const t = (next - walked) / length;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      next += spacing;
    }
    walked += length;
  }
  if (out.length === 0) return [{ x: points[0].x, y: points[0].y }];
  if (!closed) {
    const last = path[path.length - 1];
    out.push({ x: last.x, y: last.y });
  }
  return out;
}
