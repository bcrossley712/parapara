// js/timeline/playback.js
//
// Owns: playing the animation (step 4b) — the state (idle, getting
// ready, playing), the animation loop, and the small ring of decoded
// frames just ahead of the playhead. What a frame's decoded value is,
// how it's drawn and where the time comes from are the caller's
// (main.js passes them in), so this file never touches pixels, the DOM
// or storage and is unit-tested (tests/unit/playback.test.js).
//
// The rules (PROJECT_NOTES.md, step 4; measured in 4a-i):
//   - The frame comes from elapsed time (clock.js), never from counting
//     ticks. A frame that isn't decoded by its beat is skipped — the
//     last one stays up — rather than slowing the animation down, and a
//     late beat is never decoded after the fact (that's how the 60 fps
//     dev test fell behind for good).
//   - Playback never starts early: while any frame still has to be
//     flattened (`pending()`), it shows "Getting ready" and waits. A
//     rebuild can't outrun playback.
//   - It starts on the frame she's on, loops by default, and without
//     loop ends on the last frame (onEnd).
//   - Changing fps or loop while playing takes effect from the frame
//     showing, with no jump.
//   - The time comes from a clock (step 5): the wall clock, or the
//     audio clock when the project has sound, so the frames follow
//     what she hears. The clock is told where each run starts (the
//     frame's time, with fps, frame count and loop) — at the start,
//     and again whenever a run re-anchors (fps or loop changed) — and
//     stopped when playback halts. Its now() is the time since that
//     start, in ms; the loop counts beats from it exactly as before.

import { beatAtTime, frameAtBeat } from './clock.js';

// Decoded frames kept ahead of the playhead (6 played 30 fps full size
// on her iPad in 4a-i; each is ~8 MB decoded at 1920×1080).
export const DECODE_AHEAD = 6;

// decode(frameId): Promise<value> — one frame, ready to show (a
//   rejection or null shows blank paper rather than stopping).
// release(value): a decoded value is no longer needed.
// show(frameId, value): draw this frame now.
// pending(): how many frames still have to be flattened before playing.
// prepare(): getting ready started (main.js hurries the cache).
// onChange({ state, ready, total }): state is 'idle' | 'preparing' |
//   'playing'; ready/total count flattened frames while preparing.
// onEnd(frameId): without loop, playback reached the end; it has
//   stopped, and frameId is the last frame.
// clock: { start({ position, fps, frameCount, loop }), now(), stop() }
//   — position in seconds of animation time; now() in ms since start.
//   Defaults to the wall clock built on `now` (tests pass `now`).
export function createPlayback({
  decode,
  release = () => {},
  show,
  pending = () => 0,
  prepare = () => {},
  onChange = () => {},
  onEnd = () => {},
  now = () => performance.now(),
  clock = wallClock(now),
  requestFrame = (fn) => requestAnimationFrame(fn),
  cancelFrame = (id) => cancelAnimationFrame(id),
  ahead = DECODE_AHEAD,
}) {
  // 'idle' | 'preparing' | 'starting' (first frame decoding) | 'playing'
  let state = 'idle';
  let frameIds = [];
  let start = 0;       // frame index the current run started from
  let fps = 12;
  let loop = true;
  let lastBeat = -1;   // the last beat handled
  let shownId = null;  // the frame last drawn this run
  let request = null;
  let lastReport = '';
  const ring = new Map(); // beat -> { done, value }

  function report(force = false) {
    const total = frameIds.length;
    const preparing = state === 'preparing' || state === 'starting';
    const ready = preparing ? Math.max(0, total - pending()) : total;
    const status = { state: preparing ? 'preparing' : state, ready, total };
    const key = `${status.state}|${ready}|${total}`;
    if (!force && key === lastReport) return;
    lastReport = key;
    onChange(status);
  }

  function schedule() {
    if (request === null) request = requestFrame(tick);
  }

  function frameFor(beat) {
    return frameAtBeat(beat, frameIds.length, { loop, start });
  }

  // Decodes the next `ahead` beats that aren't decoding already, and
  // lets go of beats already past.
  function fill(fromBeat) {
    for (const [beat, entry] of ring) {
      if (beat >= fromBeat - 1) continue; // keep the one showing
      ring.delete(beat);
      if (entry.done && entry.value) release(entry.value);
    }
    for (let beat = fromBeat; beat < fromBeat + ahead; beat++) {
      if (ring.has(beat)) continue;
      const { index, ended } = frameFor(beat);
      if (ended) break;
      const entry = { done: false, value: null };
      ring.set(beat, entry);
      Promise.resolve()
        .then(() => decode(frameIds[index]))
        .then((value) => {
          if (ring.get(beat) !== entry) {
            if (value) release(value); // stopped or moved on meanwhile
            return;
          }
          entry.value = value ?? null;
          entry.done = true;
        }, () => {
          if (ring.get(beat) === entry) entry.done = true; // shows blank
        });
    }
  }

  function clearRing() {
    for (const entry of ring.values()) {
      if (entry.done && entry.value) release(entry.value);
    }
    ring.clear();
  }

  // Beat 0 of a new run is frame `start`: the clock starts from that
  // frame's time.
  function startClock() {
    clock.start({ position: start / fps, fps, frameCount: frameIds.length, loop });
  }

  function halt() {
    if (state === 'playing') clock.stop();
    if (request !== null) cancelFrame(request);
    request = null;
    clearRing();
    state = 'idle';
    report(true);
  }

  function tick() {
    request = null;
    if (state === 'idle') return;

    if (state === 'preparing') {
      report();
      if (pending() > 0) {
        schedule();
        return;
      }
      state = 'starting';
      fill(0);
    }

    if (state === 'starting') {
      if (!ring.get(0)?.done) {
        schedule();
        return;
      }
      state = 'playing';
      startClock();
      lastBeat = -1;
      report();
    }

    const beat = beatAtTime(clock.now(), fps);
    if (beat !== lastBeat) {
      const { index, ended } = frameFor(beat);
      if (ended) {
        const last = frameIds[frameIds.length - 1];
        shownId = last;
        halt();
        onEnd(last);
        return;
      }
      const entry = ring.get(beat);
      if (entry?.done) {
        shownId = frameIds[index];
        show(shownId, entry.value);
      } // else: not decoded in time — the last frame stays up
      lastBeat = beat;
      fill(beat + 1);
    }
    schedule();
  }

  // Makes the frame showing beat 0 of a new run, so new fps/loop
  // settings take effect from here with no jump. Decoded beats ahead
  // keep their frames; only their beat numbers move. The caller
  // applies the new setting and then restarts the clock (startClock),
  // so the clock hears the new fps/loop. Returns whether it re-anchored.
  function reanchor() {
    if (state !== 'playing' || lastBeat < 0) return false;
    const { index } = frameFor(lastBeat);
    const shift = lastBeat;
    const entries = [...ring.entries()];
    ring.clear();
    for (const [beat, entry] of entries) {
      if (beat < shift) {
        if (entry.done && entry.value) release(entry.value);
      } else {
        ring.set(beat - shift, entry);
      }
    }
    start = index;
    lastBeat = 0;
    return true;
  }

  return {
    // Gets ready, then plays `ids` (timeline order) from startIndex.
    start({ ids, startIndex = 0, fps: nextFps, loop: nextLoop = true }) {
      if (state !== 'idle' || ids.length === 0) return false;
      frameIds = [...ids];
      start = Math.min(Math.max(0, startIndex), ids.length - 1);
      fps = nextFps;
      loop = nextLoop;
      shownId = null;
      lastBeat = -1;
      state = 'preparing';
      prepare();
      report(true);
      schedule();
      return true;
    },

    // Stops. Returns the frame that was showing (null if nothing was
    // shown yet — stopped while getting ready).
    stop() {
      if (state === 'idle') return null;
      const id = state === 'playing' ? shownId : null;
      halt();
      return id;
    },

    setFps(next) {
      if (next === fps) return;
      const moved = reanchor();
      fps = next;
      if (moved) startClock();
    },

    setLoop(next) {
      if (next === loop) return;
      const moved = reanchor();
      loop = next;
      if (moved) startClock();
    },

    // 'idle' | 'preparing' | 'playing'
    get state() {
      return state === 'starting' ? 'preparing' : state;
    },

    // True while getting ready or playing.
    get active() {
      return state !== 'idle';
    },

    // The frame showing now, or null.
    get frameId() {
      return state === 'playing' ? shownId : null;
    },

    destroy() {
      if (state === 'playing') clock.stop();
      if (request !== null) cancelFrame(request);
      request = null;
      clearRing();
      state = 'idle';
    },
  };
}

// The wall clock: time since start(), from `now` (ms). Ignores where
// the run starts — beats count from 0 either way.
export function wallClock(now = () => performance.now()) {
  let t0 = 0;
  return {
    start() { t0 = now(); },
    now: () => now() - t0,
    stop() {},
  };
}
