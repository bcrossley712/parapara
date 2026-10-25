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
