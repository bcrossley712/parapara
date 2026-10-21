// js/timeline/clock.js
//
// Owns: the pure "which frame shows at this moment" math for playback.
// Playback is driven by elapsed time, never by counting timer ticks
// (PROJECT_NOTES.md, step 4): whatever supplies the time — the wall
// clock today, the audio clip's position in step 5 — the frame comes
// out of one function, so a slow frame is dropped rather than slowing
// the animation down and drifting from the sound.
//
// Also the project's fps rules (4b): she picks 1–30 (Flipaclip's own
// range), 12 by default.
//
// No DOM, no timers: unit-tested in tests/unit/clock.test.js.

export const MIN_FPS = 1;
export const MAX_FPS = 30;
export const DEFAULT_FPS = 12;
// The transport's quick picks.
export const FPS_PRESETS = [6, 8, 12, 15, 24, 30];

// A saved fps made safe: a whole number in MIN_FPS–MAX_FPS. Out-of-range
// numbers are clamped (a 60 from somewhere plays at 30, not 12);
// anything that isn't a number gives the default.
export function sanitizeFps(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FPS;
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(value)));
}

// Which beat (frame slot since playback started) `elapsedMs` falls in.
// Each frame lasts one beat today; frame holds would change only
// frameAtTime, not callers. The tiny epsilon keeps exact boundaries
// (e.g. 1000 ms at 12 fps) from landing a beat early through float
// rounding.
export function beatAtTime(elapsedMs, fps) {
  if (!(elapsedMs > 0) || !(fps > 0)) return 0;
  return Math.floor((elapsedMs * fps) / 1000 + 1e-9);
}

// The frame index for `beat` of a run that started on frame `start`.
// Looping wraps around; otherwise playback holds the last frame and
// reports `ended` once it's past it.
export function frameAtBeat(beat, frameCount, { loop = true, start = 0 } = {}) {
  if (frameCount <= 0) return { index: 0, ended: true };
  const from = Math.min(Math.max(0, Math.floor(start) || 0), frameCount - 1);
  const at = from + Math.max(0, beat);
  if (loop) return { index: at % frameCount, ended: false };
  if (at >= frameCount) return { index: frameCount - 1, ended: true };
  return { index: at, ended: false };
}

// The frame index to show `elapsedMs` after playback started from
// frame `start` (default the first).
export function frameAtTime(elapsedMs, fps, frameCount, { loop = true, start = 0 } = {}) {
  return frameAtBeat(beatAtTime(elapsedMs, fps), frameCount, { loop, start });
}
