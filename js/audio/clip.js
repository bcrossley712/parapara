// js/audio/clip.js
//
// Owns: the pure rules for the project's sound (step 5) — what a saved
// clip record may look like, the import limits, and where the clip
// lands in the animation's time. No DOM, no Web Audio: unit-tested in
// tests/unit/clip.test.js. The audio engine (audio.js) and main.js
// apply these.
//
// The rules (PROJECT_NOTES.md, step 5):
//   - Two rows (5c): at most one Music clip (imported) and one Voice
//     clip (recorded), in `project.audioClips`, each with `kind`
//     ('music' | 'voice'; missing = 'music', as 5a/5b saved it). Music
//     comes first in the list. Times are in seconds.
//   - `trimStart`/`trimEnd` pick the part of the file that plays
//     (non-destructive); `offset` is where in the animation it starts
//     (missing = 0).
//   - A clip uses at most MAX_CLIP_SECONDS of its file; a longer file
//     is accepted and only its first MAX_CLIP_SECONDS are kept.
//   - The animation's length (frames ÷ fps) wins: sound past its end
//     doesn't play (or export).

// Longest stretch of a file a clip can use. Held decoded in memory
// (~23 MB a minute, stereo 48 kHz).
export const MAX_CLIP_SECONDS = 180;

// Largest file she can import, checked before decoding (≈2 minutes of
// WAV; far more of mp3/m4a). Keeps a big video out of memory too.
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

// The two rows, in the order they're listed (and drawn in the panel).
export const CLIP_KINDS = ['music', 'voice'];

// --- recording (5c) ---

// The countdown before a recording starts, in seconds (her choice: 3).
// Letting go during it records nothing.
export const COUNTDOWN_SECONDS = 3;

// How much later a sound she hears lands in the recorded file than
// the recorder's start says (speaker → mic → file), in seconds.
// Measured on her iPad with the dev Mic delay test and set here once;
// no setting. Measured 2026-10-25: -21 to -24 ms across 18 clicks and a
// relaunch (the file starts slightly before MediaRecorder's start
// event), so -22 ms.
export const MIC_DELAY_SECONDS = -0.022;

// Leveling a take (5c, after her first iPad takes came out very quiet:
// with echo cancellation off, iOS doesn't boost the mic). Each recorded
// clip gets a `gain` that lifts its loudest point to TAKE_TARGET_PEAK,
// at most MAX_TAKE_GAIN times (so a near-silent take doesn't become
// loud hiss), never below 1. Applied at playback (and step 6's export);
// the file itself is never changed. Missing = 1 (imports, older clips).
export const TAKE_TARGET_PEAK = 0.7;
export const MAX_TAKE_GAIN = 8;

// Leveling by loudness (after 5c: peak leveling left takes far quieter
// than music — a single loud instant capped the lift while the rest of
// the voice stayed quiet). New takes are lifted so their speech (silent
// stretches left out) averages TAKE_TARGET_LOUDNESS (RMS, 0–1), still
// at most MAX_TAKE_GAIN, never below 1, and with their loudest instant
// at most MAX_LEVELED_PEAK — what's over 1 is squeezed by the take's
// compressor and the mix's limiter (audio.js). Such clips are marked
// `leveling: 'loudness'` (missing = 'peak', 5c's takes, left as they
// were). First-try numbers: tune by ear on her iPad.
export const TAKE_TARGET_LOUDNESS = 0.18;
export const MAX_LEVELED_PEAK = 2;
// Speech loudness is measured in windows this long; a window quieter
// than SPEECH_FLOOR (RMS) is a pause and doesn't count.
export const LOUDNESS_WINDOW_SECONDS = 0.05;
export const SPEECH_FLOOR = 0.01;

// --- the mixer (after 5c) ---
//
// Each row has a `volume` (1 = 100%, missing = 1), set with its slider
// and applied on top of a take's leveling. Music only turns down; Voice
// can be boosted to 200% (her request: her voice must carry over the
// song). Saved per clip; one undo step per slider release.
export const MAX_VOLUME = { music: 1, voice: 2 };
export const VOLUME_STEP = 0.05;

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isGain = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_TAKE_GAIN;
const maxVolume = (kind) => MAX_VOLUME[kind] ?? 1;
const isVolume = (v, kind) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= maxVolume(kind);

// A saved `audioClips` made safe. Anything that isn't a usable clip is
// dropped (a bad clip shouldn't fail the project); a missing or bad
// `offset` becomes 0; a missing or unknown `kind` is 'music' (5a/5b's
// one clip). At most one clip of each kind — the first usable one —
// with Music first.
export function sanitizeAudioClips(value) {
  if (!Array.isArray(value)) return [];
  const byKind = new Map();
  for (const clip of value) {
    if (!clip || typeof clip !== 'object') continue;
    if (typeof clip.id !== 'string' || !clip.id) continue;
    if (typeof clip.blobRef !== 'string' || !clip.blobRef) continue;
    if (!isTime(clip.trimStart) || !isTime(clip.trimEnd) || clip.trimEnd <= clip.trimStart) continue;
    const kind = CLIP_KINDS.includes(clip.kind) ? clip.kind : 'music';
    if (byKind.has(kind)) continue;
    byKind.set(kind, {
      id: clip.id,
      kind,
      blobRef: clip.blobRef,
      trimStart: clip.trimStart,
      trimEnd: Math.min(clip.trimEnd, clip.trimStart + MAX_CLIP_SECONDS),
      offset: isTime(clip.offset) ? clip.offset : 0,
      ...(isGain(clip.gain) && clip.gain !== 1 ? { gain: clip.gain } : {}),
      ...(clip.leveling === 'loudness' ? { leveling: 'loudness' } : {}),
      ...(isVolume(clip.volume, kind) && clip.volume !== 1 ? { volume: clip.volume } : {}),
    });
  }
  return CLIP_KINDS.filter((kind) => byKind.has(kind)).map((kind) => byKind.get(kind));
}

// The clip of `kind` in a clip list, or null.
export function clipOfKind(clips, kind) {
  return (clips ?? []).find((clip) => (clip.kind ?? 'music') === kind) ?? null;
}

// A clip list with the `kind` row set to `clip` (null empties it); the
// other row is untouched. Music stays first.
export function withClip(clips, kind, clip) {
  const rows = new Map(CLIP_KINDS.map((k) => [k, clipOfKind(clips, k)]));
  rows.set(kind, clip ? { ...clip, kind } : null);
  return CLIP_KINDS.map((k) => rows.get(k)).filter(Boolean);
}

// A new clip for a freshly imported file `duration` seconds long: the
// whole file (up to the cap), from the animation's start. `clipped`
// says the file was longer than the cap.
export function newClip({ id, blobRef, duration, kind = 'music' }) {
  const length = Math.min(duration, MAX_CLIP_SECONDS);
  return {
    clip: { id, kind, blobRef, trimStart: 0, trimEnd: length, offset: 0 },
    clipped: duration > MAX_CLIP_SECONDS,
  };
}

// The Voice clip for a finished recording (5c). The file starts a
// little before the first frame showed (opening the recorder, "Getting
// ready"): `leadIn` seconds of it are cut with trimStart, plus the mic
// delay, so her voice lands where she heard and saw it. `offset` is
// where the take began in the animation (the frame she started on).
// null when nothing usable is left — shorter than `minLength` (one
// frame).
// `gain`: the take's leveling (takeGain / loudnessGain); 1 is left out.
// `leveling`: 'loudness' marks a take leveled by loudness (it plays
// through a compressor); anything else is left out.
export function recordedClip({ id, blobRef, duration, leadIn, offset, minLength = 0, micDelay = MIC_DELAY_SECONDS, gain = 1, leveling = null }) {
  if (!(duration > 0)) return null;
  const trimStart = Math.min(Math.max(0, (leadIn || 0) + micDelay), duration);
  const trimEnd = Math.min(duration, trimStart + MAX_CLIP_SECONDS);
  if (!(trimEnd - trimStart > 0) || trimEnd - trimStart < minLength) return null;
  const clip = { id, kind: 'voice', blobRef, trimStart, trimEnd, offset: isTime(offset) ? offset : 0 };
  if (isGain(gain) && gain !== 1) clip.gain = gain;
  if (leveling === 'loudness') clip.leveling = 'loudness';
  return clip;
}

// The gain that levels a take whose loudest sample is `peak` (0–1).
export function takeGain(peak) {
  if (!(peak > 0)) return 1;
  return Math.min(MAX_TAKE_GAIN, Math.max(1, TAKE_TARGET_PEAK / peak));
}

// A clip's gain (1 when it has none).
export function clipGain(clip) {
  return isGain(clip?.gain) ? clip.gain : 1;
}

// How loud a take's speech is: the RMS (0–1) over the windows between
// `from` and `to` seconds that aren't pauses (louder than SPEECH_FLOOR),
// channels averaged. 0 if it's all quiet. `channels`: Float32Arrays.
export function speechLoudness(channels, sampleRate, from, to) {
  if (!channels?.length || !(sampleRate > 0)) return 0;
  const size = Math.max(1, Math.round(LOUDNESS_WINDOW_SECONDS * sampleRate));
  const total = Math.min(...channels.map((c) => c.length));
  const start = Math.max(0, Math.floor(from * sampleRate));
  const end = Math.min(total, Math.ceil(to * sampleRate));
  const floor = SPEECH_FLOOR * SPEECH_FLOOR;
  let sum = 0;
  let windows = 0;
  for (let w = start; w < end; w += size) {
    const stop = Math.min(end, w + size);
    let power = 0;
    for (const data of channels) {
      for (let i = w; i < stop; i++) power += data[i] * data[i];
    }
    power /= (stop - w) * channels.length;
    if (power > floor) {
      sum += power;
      windows += 1;
    }
  }
  return windows ? Math.sqrt(sum / windows) : 0;
}

// The gain that levels a take by loudness (see TAKE_TARGET_LOUDNESS):
// `loudness` from speechLoudness, `peak` its loudest sample (0–1).
export function loudnessGain({ loudness, peak }) {
  if (!(loudness > 0)) return 1;
  let gain = TAKE_TARGET_LOUDNESS / loudness;
  if (peak > 0) gain = Math.min(gain, MAX_LEVELED_PEAK / peak);
  return Math.min(MAX_TAKE_GAIN, Math.max(1, gain));
}

// A clip's volume (its row's slider; 1 when it has none).
export function clipVolume(clip) {
  const kind = clip?.kind ?? 'music';
  return isVolume(clip?.volume, kind) ? clip.volume : 1;
}

// `value` as a row's volume: snapped to VOLUME_STEP and kept within the
// row's range (Music ≤ 100%, Voice ≤ 200%).
export function sanitizeVolume(value, kind) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  const snapped = Math.round(value / VOLUME_STEP) * VOLUME_STEP;
  return Math.min(maxVolume(kind), Math.max(0, Math.round(snapped * 100) / 100));
}

// The clip with its volume set (100% leaves the field out).
export function withVolume(clip, value) {
  const kind = clip.kind ?? 'music';
  const volume = sanitizeVolume(value, kind);
  const { volume: _old, ...rest } = clip;
  return volume === 1 ? rest : { ...rest, volume };
}

// Whether a picked file may be imported, before reading it:
// 'ok' | 'too-big' | 'empty'.
export function checkImportSize(bytes) {
  if (!(bytes > 0)) return 'empty';
  return bytes > MAX_IMPORT_BYTES ? 'too-big' : 'ok';
}

// The animation's length in seconds.
export function animationSeconds(frameCount, fps) {
  if (!(frameCount > 0) || !(fps > 0)) return 0;
  return frameCount / fps;
}

// Where a run starting on frame `index` is in the animation's time.
export function timeAtFrame(index, fps) {
  if (!(index > 0) || !(fps > 0)) return 0;
  return index / fps;
}

// Where the clip lands in an animation `length` seconds long:
//   { from, to } — the part of the decoded file that plays (seconds)
//   at          — when in the animation it starts
// The part past the animation's end is cut. null when none of it
// plays (no clip, or it starts at or after the end).
export function clipPlacement(clip, length) {
  if (!clip || !(length > 0)) return null;
  const at = clip.offset ?? 0;
  if (at >= length) return null;
  const span = Math.min(clip.trimEnd - clip.trimStart, length - at);
  if (!(span > 0)) return null;
  return { from: clip.trimStart, to: clip.trimStart + span, at };
}

// Same clip (or both none) — for skipping a no-op undo entry.
export function sameClips(a, b) {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((c, i) => c.id === y[i].id && c.blobRef === y[i].blobRef
    && (c.kind ?? 'music') === (y[i].kind ?? 'music')
    && c.trimStart === y[i].trimStart && c.trimEnd === y[i].trimEnd
    && (c.offset ?? 0) === (y[i].offset ?? 0)
    && clipGain(c) === clipGain(y[i])
    && clipVolume(c) === clipVolume(y[i])
    && (c.leveling ?? 'peak') === (y[i].leveling ?? 'peak'));
}

// --- editing in the sound panel (5b) ---
//
// Each rule takes the clip as it was when the drag began (`start`) and
// how far the finger has gone, in seconds (`dt`, + = later), and
// returns the clip to show and, on release, to keep. Working from the
// drag's start means moving back undoes what moving on did, within one
// drag. Limits:
//   duration  — seconds of the decoded file a clip can use (≤ the cap)
//   minLength — the shortest a clip may get: one frame (minClipSeconds)
//   length    — the animation's length (animationSeconds)
// `offset` never goes below 0 (frame 1), so sound before frame 1 is
// always `trimStart` — no schema change for Flipaclip's "drag it left
// past the start".

// Shortest clip: one frame.
export function minClipSeconds(fps) {
  return fps > 0 ? 1 / fps : 0;
}

// Within this of the file's end counts as "the end": an end there
// stays there when the clip is slipped, so the song keeps going.
const END_EPSILON = 1e-6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Where in the animation the clip's playing part ends: its own end, or
// the animation's end if it runs past it.
export function clipVisibleEnd(clip, length) {
  return Math.min(clip.offset + (clip.trimEnd - clip.trimStart), length);
}

// Drag the clip's middle. Later is fine up to one frame before the
// end (so it never vanishes); earlier than frame 1 slides the sound's
// start under it instead — trimStart grows, the end stays put in the
// file, as in Flipaclip, where the head is hidden before frame 1.
export function moveClip(start, dt, { minLength, length }) {
  const offset = start.offset + dt;
  if (offset >= 0) {
    return { ...start, offset: Math.min(offset, Math.max(0, length - minLength)) };
  }
  const trimStart = Math.min(start.trimStart - offset, start.trimEnd - minLength);
  return { ...start, offset: 0, trimStart: Math.max(start.trimStart, trimStart) };
}

// Drag the left handle. The rest of the sound stays where it is in
// time: trimStart and offset move together. Earlier is limited by the
// file's start and by frame 1; later by one frame before the clip's end
// (or the animation's end, if the clip runs past it).
export function trimClipStart(start, dt, { minLength, length }) {
  const lo = -Math.min(start.trimStart, start.offset);
  const hi = Math.min(
    start.trimEnd - minLength - start.trimStart,
    length - minLength - start.offset,
  );
  const d = clamp(dt, lo, Math.max(lo, hi));
  return { ...start, trimStart: start.trimStart + d, offset: start.offset + d };
}

// Drag the right handle, which sits at clipVisibleEnd. Pulled back to
// (or past) the animation's end means "keep going": an end that was
// already past it is kept; otherwise the clip plays to the file's end,
// so adding frames later reveals more of the song.
export function trimClipEnd(start, dt, { duration, minLength, length }) {
  const end = clipVisibleEnd(start, length) + dt;
  if (end >= length - END_EPSILON) {
    const pastEnd = start.offset + (start.trimEnd - start.trimStart) >= length;
    return { ...start, trimEnd: pastEnd ? start.trimEnd : duration };
  }
  const trimEnd = start.trimStart + (end - start.offset);
  return { ...start, trimEnd: clamp(trimEnd, start.trimStart + minLength, duration) };
}

// Drag the window on the whole-file overview: picks which part of the
// song plays, without moving it in the animation. The clip keeps its
// length, except that an end at the file's end stays there (so sliding
// earlier makes it longer, the song still playing to its end).
export function slipClip(start, dt, { duration, minLength }) {
  if (start.trimEnd >= duration - END_EPSILON) {
    const trimStart = clamp(start.trimStart + dt, 0, Math.max(0, duration - minLength));
    return { ...start, trimStart, trimEnd: duration };
  }
  const span = start.trimEnd - start.trimStart;
  const trimStart = clamp(start.trimStart + dt, 0, Math.max(0, duration - span));
  return { ...start, trimStart, trimEnd: trimStart + span };
}
