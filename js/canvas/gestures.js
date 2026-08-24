// js/canvas/gestures.js
//
// Pure math for the two-finger pan/zoom gesture. Deliberately no DOM
// or pointer event handling here — that dispatch logic (deciding
// whether a touch is a stroke or a gesture candidate) lives in
// canvas.js. Kept separate so the transform math, which is the fiddly
// part, can be reasoned about and retuned on its own.

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
// counts as a "tap" — used to reset pan/zoom to fit, the common
// two-finger-tap-to-reset convention.
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVEMENT_PX = 12;

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function clampScale(scale) {
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

export function isQuickTap(durationMs, totalMovementPx) {
  return durationMs <= TAP_MAX_DURATION_MS && totalMovementPx <= TAP_MAX_MOVEMENT_PX;
}

// Computes the new CSS transform (translate x/y in px, plus scale)
// for a two-finger gesture in progress, given where it started.
//
// The canvas element's transform-origin is fixed at its own natural
// top-left corner, and the transform is applied as
// `translate(x, y) scale(s)` — with that ordering, a content point at
// fractional position (u, v) within the canvas's natural box maps to
// on-screen (container-relative) position:
//   screenX = natLeft + x + u * natWidth  * s
//   screenY = natTop  + y + v * natHeight * s
//
// This solves for the (x, y) that keeps the gesture's starting anchor
// point fixed under the fingers as scale changes, then adds whatever
// extra panning the fingers' midpoint has done since the gesture
// started. Recomputing from the gesture's start values every call
// (rather than incrementally from the previous frame) avoids drift
// across a long or jittery gesture.
export function computeGestureTransform({
  natLeft, natTop,
  startScale, startX, startY,
  startMidpointLocal,   // gesture-start midpoint, container-relative px
  startDistance,
  currentMidpointLocal, // current midpoint, container-relative px
  currentDistance,
}) {
  const scale = clampScale(startScale * (currentDistance / startDistance));
  const ratio = scale / startScale;

  const anchorX = startMidpointLocal.x - natLeft;
  const anchorY = startMidpointLocal.y - natTop;

  const anchoredX = anchorX * (1 - ratio) + startX * ratio;
  const anchoredY = anchorY * (1 - ratio) + startY * ratio;

  const panDeltaX = currentMidpointLocal.x - startMidpointLocal.x;
  const panDeltaY = currentMidpointLocal.y - startMidpointLocal.y;

  return {
    scale,
    x: anchoredX + panDeltaX,
    y: anchoredY + panDeltaY,
  };
}
