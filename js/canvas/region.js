// js/canvas/region.js
//
// Pure rectangle helpers for undo capture: canvas.js grows a "dirty"
// rect as a stroke paints, then clamps it to the canvas before reading
// the "before" patch. Rects are { x, y, w, h } in canvas pixels,
// integer-aligned. No DOM here, so it's unit-tested directly.

// Antialiased edges bleed a pixel past the geometric shape.
const EDGE_PAD = 2;

// The integer box covering a circle of diameter `size` at `point`.
export function rectAroundPoint(point, size) {
  const half = size / 2 + EDGE_PAD;
  const x = Math.floor(point.x - half);
  const y = Math.floor(point.y - half);
  return {
    x,
    y,
    w: Math.ceil(point.x + half) - x,
    h: Math.ceil(point.y + half) - y,
  };
}

// Smallest rect containing both; either may be null.
export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

// Intersects with the canvas; null if nothing is left.
export function clampRect(rect, width, height) {
  if (!rect) return null;
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.w);
  const bottom = Math.min(height, rect.y + rect.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}
