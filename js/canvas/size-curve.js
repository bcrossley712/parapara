// js/canvas/size-curve.js
//
// The brush-size slider's curve (8b-i), pure. The rail's slider is
// short, so a linear 1–200 range would make small sizes — the ones
// she picks most precisely — a few pixels of travel. Like Procreate's
// size slider, small sizes get most of the length: about half the
// slider covers 1–30, and the top end goes up in bigger steps, where
// a few pixels don't show. The slider itself runs 0..SIZE_SLIDER_STEPS;
// these map between its position and a brush size in canvas pixels.

export const MIN_BRUSH_SIZE = 1;
export const SIZE_SLIDER_STEPS = 1000;

// size = 1 + (max - 1) * t^k. With max 200, k = 2.5 puts t = 0.5 at
// about 36 and t = 0.45 at 30 — "about half the slider for 1–30".
const CURVE_POWER = 2.5;

export function sliderToSize(position, maxSize) {
  const t = clamp01(position / SIZE_SLIDER_STEPS);
  return Math.max(MIN_BRUSH_SIZE,
    Math.min(maxSize, Math.round(MIN_BRUSH_SIZE + (maxSize - MIN_BRUSH_SIZE) * t ** CURVE_POWER)));
}

export function sizeToSlider(size, maxSize) {
  const clamped = Math.max(MIN_BRUSH_SIZE, Math.min(maxSize, size));
  const t = ((clamped - MIN_BRUSH_SIZE) / (maxSize - MIN_BRUSH_SIZE)) ** (1 / CURVE_POWER);
  return Math.round(clamp01(t) * SIZE_SLIDER_STEPS);
}

function clamp01(t) {
  return Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
}
