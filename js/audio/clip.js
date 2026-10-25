// js/audio/clip.js
//
// Owns: the pure rules for the project's sound (step 5) — what a saved
// clip record may look like, the import limits, and where the clip
// lands in the animation's time. No DOM, no Web Audio: unit-tested in
// tests/unit/clip.test.js. The audio engine (audio.js) and main.js
// apply these.
//
// The rules (PROJECT_NOTES.md, step 5):
//   - One clip per project, in `project.audioClips` (an array so a
//     second clip later isn't a restructure). Times are in seconds.
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

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// A saved `audioClips` made safe. Anything that isn't a usable clip is
// dropped (a bad clip shouldn't fail the project); a missing or bad
// `offset` becomes 0. One clip at most for now.
export function sanitizeAudioClips(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const clip of value) {
    if (!clip || typeof clip !== 'object') continue;
    if (typeof clip.id !== 'string' || !clip.id) continue;
    if (typeof clip.blobRef !== 'string' || !clip.blobRef) continue;
    if (!isTime(clip.trimStart) || !isTime(clip.trimEnd) || clip.trimEnd <= clip.trimStart) continue;
    out.push({
      id: clip.id,
      blobRef: clip.blobRef,
      trimStart: clip.trimStart,
      trimEnd: Math.min(clip.trimEnd, clip.trimStart + MAX_CLIP_SECONDS),
      offset: isTime(clip.offset) ? clip.offset : 0,
    });
    if (out.length === 1) break;
  }
  return out;
}

// A new clip for a freshly imported or recorded file `duration`
// seconds long: the whole file (up to the cap), from the animation's
// start. `clipped` says the file was longer than the cap.
export function newClip({ id, blobRef, duration }) {
  const length = Math.min(duration, MAX_CLIP_SECONDS);
  return {
    clip: { id, blobRef, trimStart: 0, trimEnd: length, offset: 0 },
    clipped: duration > MAX_CLIP_SECONDS,
  };
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
    && c.trimStart === y[i].trimStart && c.trimEnd === y[i].trimEnd
    && (c.offset ?? 0) === (y[i].offset ?? 0));
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
