// js/audio/audio.js
//
// Owns: the project's sound while the editor is open (step 5) — the
// AudioContext, decoding a stored file, and the audio clock that
// playback (timeline/playback.js) runs on when there's a clip, so the
// frames follow what she hears. No DOM and no storage: main.js reads
// the file and hands over bytes; the rules for where the clip lands
// are in clip.js. Unit-tested with a fake AudioContext
// (tests/unit/audio.test.js). The mic itself is recorder.js (5c).
//
// Two clips (5c): the Music and Voice rows play together, each placed
// by its own clip record. start({ skip }) leaves kinds out of a run —
// while she records, the old Voice is silent and the Music plays.
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
//
// Silent mode (5a, checked on her iPad): iOS mutes web sound in Silent
// mode unless the page says its sound is media. The audio session is
// set to 'playback' (Safari's navigator.audioSession) before the
// context starts, so her animation's sound plays like a video's. 5c's
// recording switches it to 'play-and-record' while the mic is on.
//
// onEvent(name, detail) reports, for the activity log, whether a run's
// sound actually started: 'sound-start' { waitedMs }, 'sound-silent'
// { reason, state }, and 'sound-unlock-failed' { error }.

import { animationSeconds, clipPlacement } from './clip.js';

// How far ahead the next loop pass is queued, in seconds.
export const LOOKAHEAD = 1;
// How long a run waits for a starting context before going silent.
export const START_TIMEOUT_MS = 1000;

function defaultContext() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

// The page's audio session (Safari 16.4+), or null elsewhere.
function defaultSession() {
  return globalThis.navigator?.audioSession ?? null;
}

// createContext(): a new AudioContext, or null without Web Audio.
// wallNow(): the wall clock in ms (tests pass a fake).
// audioSession: Safari's navigator.audioSession, or null.
// onEvent(name, detail): what happened to a run's sound (see above).
export function createAudio({
  createContext = defaultContext,
  wallNow = () => performance.now(),
  audioSession = defaultSession(),
  onEvent = () => {},
} = {}) {
  let ctx = null;
  let contextFailed = false;
  // The project's clips with their decoded sound: [{ clip, buffer }].
  let tracks = [];
  let run = null;       // the playing run (see start)
  let recording = false; // the mic is on (setRecording)

  // Says the page's sound is media, so Silent mode doesn't mute it.
  function setSession(type) {
    if (!audioSession) return;
    try {
      if (audioSession.type !== type) audioSession.type = type;
    } catch (err) {
      console.warn('Parapara! could not set the audio session:', err);
    }
  }

  function context() {
    if (ctx || contextFailed) return ctx;
    setSession('playback');
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
  function schedule(buffer, when, from, duration) {
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
    const { parts, length } = run;
    for (;;) {
      const passStart = run.startedAt + run.nextPass * length - run.position;
      if (passStart - ctx.currentTime > LOOKAHEAD) return;
      for (const { buffer, placement } of parts) {
        schedule(buffer, passStart + placement.at, placement.from, placement.to - placement.from);
      }
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

  // Once per run: the sound began (after how long a wait).
  function reportStarted() {
    if (run.reported) return;
    run.reported = true;
    onEvent('sound-start', { waitedMs: Math.round(Math.max(0, wallNow() - run.requestedAt)) });
  }

  const clock = {
    // skip: clip kinds left out of this run (['voice'] while recording).
    start({ position = 0, fps, frameCount, loop = true, skip = [] }) {
      clock.stop();
      const length = animationSeconds(frameCount, fps);
      const parts = [];
      for (const { clip, buffer } of tracks) {
        if (skip.includes(clip.kind ?? 'music')) continue;
        const placement = clipPlacement(clip, length);
        if (placement) parts.push({ buffer, placement });
      }
      run = { mode: 'wall', t0: wallNow(), sources: new Set() };
      // A suspended or interrupted context may be starting (the Play tap
      // asked it to): run on it, holding until it does (see now()).
      if (parts.length === 0) return;
      if (!context() || ctx.state === 'closed') {
        onEvent('sound-silent', { reason: 'no-web-audio', state: ctx?.state ?? 'none' });
        return;
      }
      Object.assign(run, {
        requestedAt: wallNow(),
        reported: false,
        mode: 'audio',
        position,
        length,
        loop,
        parts,
        startedAt: ctx.currentTime,
        waitingSince: ctx.state === 'running' ? null : wallNow(),
        nextPass: 1,
      });
      // This pass: whatever's left of each clip from `position` on.
      for (const { buffer, placement: { at, from, to } } of parts) {
        const into = position - at; // how far into the clip the run starts
        if (into < to - from) {
          const cut = Math.max(0, into);
          schedule(buffer, run.startedAt + Math.max(0, -into), from + cut, to - from - cut);
        }
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
          // Only a run that never started is "silent"; a later stop
          // (an interruption) is reported the same way.
          onEvent('sound-silent', { reason: run.reported ? 'stopped' : 'did-not-start', state: ctx.state });
          goWall(elapsed);
          return elapsed;
        }
        return Math.max(0, (ctx.currentTime - run.startedAt) * 1000);
      }
      run.waitingSince = null;
      reportStarted();
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
    // from one. Nothing to do without sound — but a sound still being
    // loaded counts (`expectSound`): Play pressed while a project opens
    // waits in "Getting ready", and this tap is the only chance to
    // start the context for it.
    unlock({ expectSound = false } = {}) {
      if (!(tracks.length > 0 || expectSound) || !context()) return;
      if (!recording) setSession('playback');
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        const resumed = ctx.resume();
        resumed?.catch?.((err) => {
          console.warn('Parapara! sound could not start:', err);
          onEvent('sound-unlock-failed', { error: String(err?.message ?? err) });
        });
      }
    },

    // For the log: the context's state ('none' before one exists) and
    // the audio session's type ('none' without one).
    get debugState() {
      return { ctx: ctx?.state ?? 'none', session: audioSession?.type ?? 'none' };
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

    // The project's clips and their decoded sound: [{ clip, buffer }]
    // (entries without a buffer — not decoded yet — are left out).
    // Takes effect from the next run.
    setClips(list) {
      tracks = (list ?? []).filter((t) => t && t.clip && t.buffer);
    },

    // Whether any clip's sound is loaded (for the log).
    get hasSound() {
      return tracks.length > 0;
    },

    // While the mic is recording (5c): the audio session says so
    // ('play-and-record'), so iOS lets the music play while the mic is
    // on; back to 'playback' after.
    setRecording(on) {
      recording = Boolean(on);
      setSession(recording ? 'play-and-record' : 'playback');
    },

    // The AudioContext, created if needed (null without Web Audio) —
    // for the dev Mic delay test, which plays a click on it.
    get context() {
      return context();
    },

    destroy() {
      clock.stop();
      tracks = [];
      if (recording) setSession('playback');
      recording = false;
      const closing = ctx;
      ctx = null;
      contextFailed = true;
      closing?.close?.()?.catch?.(() => {});
    },
  };
}
