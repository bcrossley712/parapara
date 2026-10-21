// js/timeline/clock.js
//
// Owns: the pure "which frame shows at this moment" math for playback.
// Playback is driven by elapsed time, never by counting timer ticks
// (PROJECT_NOTES.md, step 4): whatever supplies the time — the wall
// clock today, the audio clip's position in step 5 — the frame comes
// out of one function, so a slow frame is dropped rather than slowing
// the animation down and drifting from the sound.
//
// No DOM, no timers: unit-tested in tests/unit/clock.test.js.

// Which beat (frame slot since playback started) `elapsedMs` falls in.
// Each frame lasts one beat today; frame holds would change only
// frameAtTime, not callers. The tiny epsilon keeps exact boundaries
// (e.g. 1000 ms at 12 fps) from landing a beat early through float
// rounding.
export function beatAtTime(elapsedMs, fps) {
  if (!(elapsedMs > 0) || !(fps > 0)) return 0;
  return Math.floor((elapsedMs * fps) / 1000 + 1e-9);
}

// The frame index to show `elapsedMs` after playback started from
// frame 0. Looping wraps around; otherwise playback holds the last
// frame and reports `ended`.
export function frameAtTime(elapsedMs, fps, frameCount, { loop = true } = {}) {
  if (frameCount <= 0) return { index: 0, ended: true };
  const beat = beatAtTime(elapsedMs, fps);
  if (loop) return { index: beat % frameCount, ended: false };
  if (beat >= frameCount) return { index: frameCount - 1, ended: true };
  return { index: beat, ended: false };
}
