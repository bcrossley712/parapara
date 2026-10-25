// js/audio/audio.js
//
// Owns: the project's sound while the editor is open (step 5) — the
// AudioContext, decoding a stored file, and the audio clock that
// playback (timeline/playback.js) runs on when there's a clip, so the
// frames follow what she hears. No DOM and no storage: main.js reads
// the file and hands over bytes; the rules for where the clip lands
// are in clip.js. Unit-tested with a fake AudioContext
// (tests/unit/audio.test.js). Recording (5c) joins later.
//
// The clock (PROJECT_NOTES.md, step 5):
//   - start({ position, fps, frameCount, loop }) begins a run from
//     `position` seconds of animation time; now() is the time since,
//     in ms, from the AudioContext's clock minus the output delay — the
//     frame showing is the one she hears.
//   - The clip is scheduled on that clock, never re-timed by the
//     screen: its first stretch at once, and with loop on, the next
//     pass is queued a little ahead (LOOKAHEAD), so loops are seamless
//     and never drift. Only the part inside the animation's length
//     plays (clipPlacement) — the animation's length wins.
//   - No clip, no Web Audio, or a context iOS won't start: the run uses
//     the wall clock, silently, exactly like playback without sound.
//     A context still starting (resume() is asked for in the Play tap)
//     holds the first frame until sound begins; if it hasn't begun
//     within START_TIMEOUT_MS, the run carries on silently.

import { animationSeconds, clipPlacement } from './clip.js';

// How far ahead the next loop pass is queued, in seconds.
export const LOOKAHEAD = 1;
// How long a run waits for a starting context before going silent.
export const START_TIMEOUT_MS = 1000;

function defaultContext() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

// createContext(): a new AudioContext, or null without Web Audio.
// wallNow(): the wall clock in ms (tests pass a fake).
export function createAudio({ createContext = defaultContext, wallNow = () => performance.now() } = {}) {
  let ctx = null;
  let contextFailed = false;
  let clip = null;      // the project's clip record
  let buffer = null;    // its decoded sound (an AudioBuffer)
  let run = null;       // the playing run (see start)

  function context() {
    if (ctx || contextFailed) return ctx;
    try {
      ctx = createContext();
    } catch (err) {
      console.warn('Parapara! Web Audio is not available:', err);
      ctx = null;
    }
    if (!ctx) contextFailed = true;
    return ctx;
  }

  // Seconds between the context's clock and the speaker.
  function outputDelay() {
    const out = ctx.outputLatency;
    if (typeof out === 'number' && Number.isFinite(out) && out > 0) return out;
    const base = ctx.baseLatency;
    return typeof base === 'number' && Number.isFinite(base) && base > 0 ? base : 0;
  }

  // Plays buffer[from .. from+duration) at context time `when`. A start
  // already in the past is shifted (its beginning cut), never late.
  function schedule(when, from, duration) {
    const lateBy = Math.max(0, ctx.currentTime - when);
    const length = duration - lateBy;
    if (!(length > 0)) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(when + lateBy, from + lateBy, length);
    run.sources.add(source);
    source.onended = () => run?.sources.delete(source);
  }

  // Queues loop passes that start within LOOKAHEAD of now. Pass k of
  // the run begins at startedAt + k·length − position (context time).
  function pump() {
    if (!run || run.mode !== 'audio' || !run.loop) return;
    const { placement, length } = run;
    for (;;) {
      const passStart = run.startedAt + run.nextPass * length - run.position;
      if (passStart - ctx.currentTime > LOOKAHEAD) return;
      schedule(passStart + placement.at, placement.from, placement.to - placement.from);
      run.nextPass += 1;
    }
  }

  function stopSources() {
    if (!run) return;
    for (const source of run.sources) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // already stopped
      }
    }
    run.sources.clear();
  }

  function goWall(elapsedMs = 0) {
    stopSources();
    run.mode = 'wall';
    run.t0 = wallNow() - elapsedMs;
  }

  const clock = {
    start({ position = 0, fps, frameCount, loop = true }) {
      clock.stop();
      const length = animationSeconds(frameCount, fps);
      const placement = buffer ? clipPlacement(clip, length) : null;
      run = { mode: 'wall', t0: wallNow(), sources: new Set() };
      // A suspended or interrupted context may be starting (the Play tap
      // asked it to): run on it, holding until it does (see now()).
      if (!placement || !context() || ctx.state === 'closed') return;
      Object.assign(run, {
        mode: 'audio',
        position,
        length,
        loop,
        placement,
        startedAt: ctx.currentTime,
        waitingSince: ctx.state === 'running' ? null : wallNow(),
        nextPass: 1,
      });
      // This pass: whatever's left of the clip from `position` on.
      const { at, from, to } = placement;
      const into = position - at; // how far into the clip the run starts
      if (into < to - from) {
        const skip = Math.max(0, into);
        schedule(run.startedAt + Math.max(0, -into), from + skip, to - from - skip);
      }
      pump();
    },

    now() {
      if (!run) return 0;
      if (run.mode === 'wall') return wallNow() - run.t0;
      if (ctx.state !== 'running') {
        // Still starting (or iOS stopped it): hold, then go silent.
        if (run.waitingSince === null) run.waitingSince = wallNow();
        if (wallNow() - run.waitingSince > START_TIMEOUT_MS) {
          const elapsed = Math.max(0, (ctx.currentTime - run.startedAt) * 1000);
          goWall(elapsed);
          return elapsed;
        }
        return Math.max(0, (ctx.currentTime - run.startedAt) * 1000);
      }
      run.waitingSince = null;
      pump();
      return (ctx.currentTime - outputDelay() - run.startedAt) * 1000;
    },

    stop() {
      stopSources();
      run = null;
    },

    // For the log and tests: 'audio' | 'wall' | null.
    get mode() {
      return run?.mode ?? null;
    },
  };

  return {
    clock,

    // Call synchronously inside a tap (Play): iOS only starts sound
    // from one. Nothing to do without a clip.
    unlock() {
      if (!buffer || !context()) return;
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        const resumed = ctx.resume();
        resumed?.catch?.((err) => console.warn('Parapara! sound could not start:', err));
      }
    },

    // Decodes a stored file's bytes (ArrayBuffer) into sound. Rejects if
    // it isn't sound this device can play — the import test.
    decode(bytes) {
      const c = context();
      if (!c) return Promise.reject(new Error('Web Audio is not available'));
      return new Promise((resolve, reject) => {
        const promise = c.decodeAudioData(bytes, resolve, reject);
        promise?.then?.(resolve, reject);
      });
    },

    // `decoded` cut to its first `seconds` (unchanged if shorter): a
    // longer file keeps only what a clip can use, so memory stays
    // capped.
    keepFirst(decoded, seconds) {
      if (!decoded || decoded.duration <= seconds) return decoded;
      const frames = Math.floor(seconds * decoded.sampleRate);
      const out = context().createBuffer(decoded.numberOfChannels, frames, decoded.sampleRate);
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        out.getChannelData(ch).set(decoded.getChannelData(ch).subarray(0, frames));
      }
      return out;
    },

    // The project's clip and its decoded sound (both null: no sound).
    // Takes effect from the next run.
    setClip(nextClip, decoded) {
      clip = nextClip ?? null;
      buffer = nextClip ? decoded ?? null : null;
    },

    // The blobRef whose sound is loaded, or null.
    get loadedRef() {
      return buffer && clip ? clip.blobRef : null;
    },

    destroy() {
      clock.stop();
      clip = null;
      buffer = null;
      const closing = ctx;
      ctx = null;
      contextFailed = true;
      closing?.close?.()?.catch?.(() => {});
    },
  };
}
