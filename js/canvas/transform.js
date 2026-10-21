// js/canvas/transform.js
//
// Pure math for the reference image's placement (step 3a). No DOM, so
// it's unit-tested directly.
//
// A placement is { x, y, scale, rotation, opacity, flipX, flipY }, all
// in canvas pixels: (x, y) is where the image's center sits, `scale`
// is canvas px per image px (always positive), `rotation` is radians
// clockwise, and flipX/flipY (3b; missing = false) mirror the image
// across its own vertical/horizontal axis. This is the schema's
// frame.image minus blobRef. Drawing it is
//   translate(x, y) · rotate(rotation) · scale(±scale, ±scale) · translate(-w/2, -h/2)
// for an image of w × h pixels (see reference.js).
//
// Adjust mode feeds pointer positions here already converted to canvas
// space (canvas.js's toCanvasPoint), so the view's own pan, zoom and
// rotation never leak into the image's placement.

import { distance, midpoint } from './gestures.js';

// What a fresh import starts at: 50% so she can trace over it.
export const DEFAULT_IMAGE_OPACITY = 0.5;

// Smallest the image may get: its longer side this many canvas px, so
// it can't vanish under her fingers. Largest: its longer side this
// many times the canvas's longer side — room to enlarge a small part
// of a photo, whatever size the photo was.
export const MIN_IMAGE_SIDE = 48;
export const MAX_IMAGE_ZOOM = 8;

// `size` everywhere below: { imageW, imageH, canvasW, canvasH }.

// The whole image fits inside the canvas, centered, unrotated.
export function fitPlacement(imageW, imageH, canvasW, canvasH) {
  return {
    x: canvasW / 2,
    y: canvasH / 2,
    scale: Math.min(canvasW / imageW, canvasH / imageH),
    rotation: 0,
    opacity: DEFAULT_IMAGE_OPACITY,
    flipX: false,
    flipY: false,
  };
}

// Flip as she sees it on screen: 'horizontal' mirrors left↔right,
// 'vertical' top↔bottom, about the image's center, whatever its
// rotation. Mirroring across a canvas axis is the same as mirroring
// across the image's own axis with the rotation negated (M·R(θ) =
// R(−θ)·M), so only the flag and the angle change; x, y and scale
// stay put. Flipping twice gives back the same look.
export function flipPlacement(placement, direction) {
  const key = direction === 'vertical' ? 'flipY' : 'flipX';
  return {
    ...placement,
    rotation: placement.rotation === 0 ? 0 : -placement.rotation,
    [key]: placement[key] !== true,
  };
}

export function clampImageScale(scale, { imageW, imageH, canvasW, canvasH }) {
  const side = Math.max(imageW, imageH);
  const min = MIN_IMAGE_SIDE / side;
  const max = (MAX_IMAGE_ZOOM * Math.max(canvasW, canvasH)) / side;
  return Math.min(Math.max(scale, min), max);
}

// One finger: the image follows it. `from` and `to` are canvas points
// (where the finger started, where it is now); `start` is the
// placement when the finger went down.
export function dragPlacement(start, from, to) {
  return { ...start, x: start.x + (to.x - from.x), y: start.y + (to.y - from.y) };
}

// Two fingers: the image moves, scales and turns with them, as if
// pinned under both. a0/b0 are the fingers' canvas points when the
// pinch started, a1/b1 where they are now. `turned` is how far the
// pair has rotated since the start, accumulated move by move by the
// caller (shortestAngleDelta) — a single start-to-now angle diff
// snaps when a twist passes 180°, the same lesson as the view's
// rotation. The point under the fingers' midpoint stays under it.
export function pinchPlacement(start, { a0, b0, a1, b1, turned }, size) {
  const ratio = distance(a1, b1) / Math.max(1e-6, distance(a0, b0));
  const scale = clampImageScale(start.scale * ratio, size);
  const k = scale / start.scale; // the scale actually applied, after clamping
  const m0 = midpoint(a0, b0);
  const m1 = midpoint(a1, b1);
  const cos = Math.cos(turned);
  const sin = Math.sin(turned);
  const dx = (start.x - m0.x) * k;
  const dy = (start.y - m0.y) * k;
  return {
    ...start,
    x: m1.x + dx * cos - dy * sin,
    y: m1.y + dx * sin + dy * cos,
    scale,
    rotation: start.rotation + turned,
  };
}

// The 2D matrix [a, b, c, d, e, f] (as ctx.setTransform takes it) that
// draws an imageW × imageH image at `placement`, with every canvas px
// multiplied by `unit` (1 for the full-size canvas; smaller for a
// thumbnail) and the origin moved by (-originX, -originY) canvas px
// (for drawing just a region of the canvas).
export function placementMatrix(placement, imageW, imageH, { unit = 1, originX = 0, originY = 0 } = {}) {
  const s = placement.scale * unit;
  const sx = placement.flipX === true ? -s : s;
  const sy = placement.flipY === true ? -s : s;
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  const tx = (placement.x - originX) * unit;
  const ty = (placement.y - originY) * unit;
  // translate(tx, ty) · rotate · scale(sx, sy) · translate(-w/2, -h/2)
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const hw = imageW / 2;
  const hh = imageH / 2;
  return [a, b, c, d, tx - a * hw - c * hh, ty - b * hw - d * hh];
}

// True when two placements would look the same — Done on an untouched
// image isn't an undo step.
export function samePlacement(p, q) {
  if (!p || !q) return p === q;
  return p.x === q.x && p.y === q.y && p.scale === q.scale
    && p.rotation === q.rotation && p.opacity === q.opacity
    && (p.flipX === true) === (q.flipX === true)
    && (p.flipY === true) === (q.flipY === true);
}

// A saved placement with anything missing or broken replaced, so a
// bad record can't throw or draw nothing at all.
export function sanitizePlacement(raw, imageW, imageH, canvasW, canvasH) {
  const fit = fitPlacement(imageW, imageH, canvasW, canvasH);
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const scale = num(raw?.scale, fit.scale);
  return {
    x: num(raw?.x, fit.x),
    y: num(raw?.y, fit.y),
    scale: scale > 0 ? clampImageScale(scale, { imageW, imageH, canvasW, canvasH }) : fit.scale,
    rotation: num(raw?.rotation, 0),
    opacity: Math.min(1, Math.max(0, num(raw?.opacity, DEFAULT_IMAGE_OPACITY))),
    flipX: raw?.flipX === true,
    flipY: raw?.flipY === true,
  };
}
