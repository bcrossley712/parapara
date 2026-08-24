// js/canvas/gestures.js
//
// Pure math for the two-finger pan/zoom/rotate gesture. Deliberately
// no DOM or pointer event handling here — that dispatch logic
// (deciding whether a touch is a stroke or a gesture candidate, and
// the incremental rotation tracking below needs) lives in canvas.js.
// Kept separate so the transform math, which is the fiddly part, can
// be reasoned about and retuned on its own.

// Can't zoom out past the natural fit-to-screen size, capped at 8x
// for detail work.
export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

// How long a touch can sit alone before it's committed to being a
// solo stroke rather than a gesture candidate, and how far it can
// have moved and still count as "barely moved" for gesture purposes.
export const GESTURE_WINDOW_MS = 150;
export const GESTURE_MOVEMENT_THRESHOLD_PX = 8;

// A confirmed two-finger gesture that was short and barely moved
// counts as a "tap" — used to reset pan/zoom/rotation to fit, the
// common two-finger-tap-to-reset convention.
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVEMENT_PX = 12;

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function angleBetween(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// Normalizes an angle delta to the range (-π, π] — i.e. the shortest
// rotational path from one angle to another. Needed because raw
// atan2 differences jump by ~2π when the two fingers' angle crosses
// the ±180° boundary during a gesture; without this, a continuous
// twist past 180° would visibly snap instead of rotating smoothly.
// Only safe to use between two angles sampled close together in time
// (consecutive pointermove events) — see canvas.js's incremental
// accumulation, not a single start-to-current diff, which is why this
// isn't just folded into computeGestureTransform below.
export function shortestAngleDelta(from, to) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export function clampScale(scale) {
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

export function isQuickTap(durationMs, totalMovementPx) {
  return durationMs <= TAP_MAX_DURATION_MS && totalMovementPx <= TAP_MAX_MOVEMENT_PX;
}

function rotateVector(x, y, radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

// The canvas element's transform-origin is fixed at its own natural
// top-left corner (see canvas.js), and the transform is applied as
// `translate(x, y) rotate(r) scale(s)`. With that ordering, a content
// point at natural-box-local position P = (px, py) — CSS px measured
// from the canvas's own untransformed top-left corner — maps to
// on-screen, container-relative position:
//   screenPoint = (natLeft, natTop) + (x, y) + rotate(scale(P), r)
//
// screenToNaturalPoint is the inverse of that: given an on-screen
// point and the transform that's currently applied, what natural-box
// content point is under it. Used both by canvas.js's toCanvasPoint
// (so drawing stays accurate under any pan/zoom/rotation — computed
// analytically rather than read back from getBoundingClientRect(),
// which doesn't return a rotated element's true box) and internally
// below to solve for a gesture's anchor point.
export function screenToNaturalPoint(screenLocal, { natLeft, natTop, scale, rotation, x, y }) {
  const dx = screenLocal.x - natLeft - x;
  const dy = screenLocal.y - natTop - y;
  const unrotated = rotateVector(dx, dy, -rotation);
  return { x: unrotated.x / scale, y: unrotated.y / scale };
}

// Computes the new CSS transform (translate x/y, scale) for a
// two-finger gesture in progress, given where it started and the
// gesture's current absolute rotation (tracked incrementally by the
// caller — see canvas.js — since rotation can't be safely recomputed
// as a single start-to-current diff the way scale/translate can; it
// needs to accumulate frame-to-frame to handle a twist past 180°
// without snapping).
//
// Solves for the (x, y) that keeps the gesture's starting anchor
// point (the content point that was under the fingers when the
// gesture began) tracking the fingers' current midpoint as scale and
// rotation change — this single formula naturally covers simultaneous
// pan, zoom, and rotation, not three separate calculations.
// Recomputing from the gesture's start values every call (rather than
// incrementally from the previous frame) avoids scale/position drift
// across a long or jittery gesture; only rotation needs incremental
// tracking, for the reason above.
export function computeGestureTransform({
  natLeft, natTop,
  startScale, startRotation, startX, startY,
  startMidpointLocal,   // gesture-start midpoint, container-relative px
  startDistance,
  rotation,             // current absolute rotation (radians), precomputed by caller
  currentMidpointLocal, // current midpoint, container-relative px
  currentDistance,
}) {
  const scale = clampScale(startScale * (currentDistance / startDistance));

  const anchor = screenToNaturalPoint(startMidpointLocal, {
    natLeft, natTop,
    scale: startScale,
    rotation: startRotation,
    x: startX,
    y: startY,
  });

  const rotatedAnchor = rotateVector(anchor.x * scale, anchor.y * scale, rotation);

  return {
    scale,
    x: currentMidpointLocal.x - natLeft - rotatedAnchor.x,
    y: currentMidpointLocal.y - natTop - rotatedAnchor.y,
  };
}
