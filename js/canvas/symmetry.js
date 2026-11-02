// js/canvas/symmetry.js
//
// Symmetry (8b-i), pure: where a stamp's mirrored copies go. The axis
// is fixed at the canvas center (her decision — nothing on the canvas
// to drag). Modes follow Procreate's names: 'vertical' is a vertical
// axis (left ↔ right copies), 'horizontal' a horizontal one (top ↔
// bottom), 'both' four copies. canvas.js stamps every point this
// returns, after the stabilizer, so the mirrors trail just like the
// line she draws.

export const SYMMETRY_MODES = ['off', 'vertical', 'horizontal', 'both'];

// Anything unknown or missing (older projects) is off.
export function sanitizeSymmetry(value) {
  return SYMMETRY_MODES.includes(value) ? value : 'off';
}

// The copies of `point` for `mode` on a width × height canvas, the
// original first. Each copy says whether it's flipped in x and/or y,
// so a directional tip (a chisel, 8b-ii) mirrors its angle too. The
// index of a copy is stable for a mode (0 = original, then x-flip,
// y-flip, both), which canvas.js uses to keep one dirty rect per copy.
export function mirrorPoints(point, mode, width, height) {
  const out = [{ x: point.x, y: point.y, flipX: false, flipY: false }];
  const mx = width - point.x;
  const my = height - point.y;
  if (mode === 'vertical' || mode === 'both') {
    out.push({ x: mx, y: point.y, flipX: true, flipY: false });
  }
  if (mode === 'horizontal' || mode === 'both') {
    out.push({ x: point.x, y: my, flipX: false, flipY: true });
  }
  if (mode === 'both') {
    out.push({ x: mx, y: my, flipX: true, flipY: true });
  }
  return out;
}

// Rects that overlap are merged until none do. Undo swaps each rect
// separately, so two overlapping ones would read each other's half-
// swapped pixels on redo; merged, every pixel is in exactly one.
// Order-independent result for the small counts here (≤ 4).
export function mergeOverlapping(rects) {
  const list = rects.filter(Boolean).map((r) => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlaps(list[i], list[j])) {
          list[i] = union(list[i], list[j]);
          list.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return list;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}
