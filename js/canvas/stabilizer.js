// js/canvas/stabilizer.js
//
// Stabilizer (8a): makes the line trail the stylus so hand wobble
// smooths out, as in Flipaclip's stabilizer and Procreate's
// StreamLine. Pure — no DOM, no clock of its own — so it's unit-tested
// with exact timestamps; canvas.js feeds it pointer samples and
// animation-frame ticks.
//
// How it trails: the drawn point chases the stylus's latest position,
// closing the gap exponentially over time (time constant `lag`). Time,
// not sample count, drives it, so the feel doesn't change with how
// often iPadOS reports the stylus. While the stylus sits still mid-
// stroke no samples arrive, so canvas.js calls tick() each animation
// frame and the line glides up to the stylus. On lift, finish() jumps
// the rest of the way, so the line always ends where she lifted.
//
// The output points go into the stroke path (canvas.js extendStroke),
// where the usual midpoint smoothing and stamping happen. Symmetry
// (planned) mirrors these output points.

// Strength is 0–10 on the rail's slider (11 notches: the rail's slider
// is short, so a fine scale would be hard to set). 0 = off.
export const MAX_STABILIZER = 10;
export const DEFAULT_STABILIZER = 5; // midway (his choice, 2026-11-01)

// Lag at full strength. Tune on her iPad: this is the one number that
// sets how strong the top of the slider feels.
export const MAX_STABILIZER_LAG_MS = 150;

// Below this gap (canvas px) the line counts as caught up: tick()
// stops producing points so a resting stylus doesn't keep stamping.
const SETTLED_PX = 0.5;

// Strength → time constant in ms. A curve rather than a straight line
// so the low notches stay subtle: 5 → ~53 ms, 10 → 150 ms.
export function stabilizerLag(strength) {
  if (!(strength > 0)) return 0;
  const s = Math.min(strength, MAX_STABILIZER) / MAX_STABILIZER;
  return MAX_STABILIZER_LAG_MS * s ** 1.5;
}

// start: the stroke's first point (already stamped by the caller).
// time: its timestamp (ms, the same clock as later calls).
export function createStabilizer(strength, start, time) {
  const lag = stabilizerLag(strength);
  let pos = { x: start.x, y: start.y };    // where the line is
  let target = { x: start.x, y: start.y }; // where the stylus is
  let last = time;

  // Moves pos toward target for the time since the last update.
  // Out-of-order timestamps (coalesced samples older than the last
  // tick) count as no time passing.
  function advance(now) {
    const dt = now - last;
    if (dt <= 0) return;
    last = now;
    const k = lag > 0 ? 1 - Math.exp(-dt / lag) : 1;
    pos = { x: pos.x + (target.x - pos.x) * k, y: pos.y + (target.y - pos.y) * k };
  }

  function gap() {
    return Math.hypot(target.x - pos.x, target.y - pos.y);
  }

  return {
    // A stylus sample. Returns the points to draw (0 or 1). The stylus
    // was at the old target until now, so the line catches up toward
    // that first, then aims at the new sample.
    push(point, now) {
      if (lag === 0) {
        pos = { x: point.x, y: point.y };
        target = pos;
        last = Math.max(last, now);
        return [pos];
      }
      const before = pos;
      advance(now);
      target = { x: point.x, y: point.y };
      return pos === before ? [] : [pos];
    },

    // An animation frame with no new sample: keep closing the gap.
    tick(now) {
      if (gap() < SETTLED_PX) return [];
      advance(now);
      if (gap() < SETTLED_PX) pos = target;
      return [pos];
    },

    // Lift: the rest of the way to where the stylus is.
    finish() {
      if (gap() === 0) return [];
      pos = target;
      return [pos];
    },

    // True once the line has caught up (nothing for tick() to do).
    get settled() {
      return gap() < SETTLED_PX;
    },
  };
}
