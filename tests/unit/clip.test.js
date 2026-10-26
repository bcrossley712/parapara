// Unit tests for js/audio/clip.js — saved-clip clean-up, import
// limits, and where the clip lands in the animation's time (step 5).
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CLIP_SECONDS,
  MAX_IMPORT_BYTES,
  sanitizeAudioClips,
  newClip,
  checkImportSize,
  animationSeconds,
  timeAtFrame,
  clipPlacement,
  sameClips,
  minClipSeconds,
  clipVisibleEnd,
  moveClip,
  trimClipStart,
  trimClipEnd,
  slipClip,
  CLIP_KINDS,
  clipOfKind,
  withClip,
  recordedClip,
  takeGain,
  clipGain,
  MAX_TAKE_GAIN,
  TAKE_TARGET_PEAK,
} from '../../js/audio/clip.js';

const good = { id: 'c1', blobRef: 'a1', trimStart: 0, trimEnd: 4, offset: 0 };

test('sanitizeAudioClips: missing or not an array gives none', () => {
  assert.deepEqual(sanitizeAudioClips(undefined), []);
  assert.deepEqual(sanitizeAudioClips(null), []);
  assert.deepEqual(sanitizeAudioClips({}), []);
});

test('sanitizeAudioClips: a good clip is kept, as Music when it has no kind (5a/5b)', () => {
  assert.deepEqual(sanitizeAudioClips([good]), [{ ...good, kind: 'music' }]);
  assert.deepEqual(sanitizeAudioClips([{ ...good, kind: 'odd' }]), [{ ...good, kind: 'music' }]);
});

test('sanitizeAudioClips: a missing or bad offset becomes 0', () => {
  const { offset, ...noOffset } = good;
  assert.equal(sanitizeAudioClips([noOffset])[0].offset, 0);
  assert.equal(sanitizeAudioClips([{ ...good, offset: -1 }])[0].offset, 0);
  assert.equal(sanitizeAudioClips([{ ...good, offset: 'x' }])[0].offset, 0);
  assert.equal(sanitizeAudioClips([{ ...good, offset: 2.5 }])[0].offset, 2.5);
});

test('sanitizeAudioClips: unusable clips are dropped, not the project', () => {
  assert.deepEqual(sanitizeAudioClips([{ ...good, blobRef: '' }]), []);
  assert.deepEqual(sanitizeAudioClips([{ ...good, id: 3 }]), []);
  assert.deepEqual(sanitizeAudioClips([{ ...good, trimEnd: 0 }]), []);
  assert.deepEqual(sanitizeAudioClips([{ ...good, trimStart: NaN }]), []);
  assert.deepEqual(sanitizeAudioClips([null, 'x', { ...good, trimEnd: -2 }]), []);
});

test('sanitizeAudioClips: one clip of each kind at most; the first usable one wins', () => {
  const second = { ...good, id: 'c2', blobRef: 'a2' };
  assert.deepEqual(sanitizeAudioClips([{ bad: true }, good, second]), [{ ...good, kind: 'music' }]);
});

test('sanitizeAudioClips: a Music and a Voice clip are both kept, Music first', () => {
  const voice = { ...good, id: 'v', blobRef: 'av', kind: 'voice' };
  const out = sanitizeAudioClips([voice, good, { ...voice, id: 'v2' }]);
  assert.deepEqual(out.map((c) => c.id), ['c1', 'v']);
  assert.deepEqual(out.map((c) => c.kind), CLIP_KINDS);
});

test('clipOfKind and withClip set one row and leave the other alone', () => {
  const music = { ...good, kind: 'music' };
  const voice = { ...good, id: 'v', kind: 'voice' };
  assert.equal(clipOfKind([music, voice], 'voice'), voice);
  assert.equal(clipOfKind([music], 'voice'), null);
  assert.equal(clipOfKind([good], 'music'), good); // no kind = Music
  assert.deepEqual(withClip([music], 'voice', voice), [music, voice]);
  assert.deepEqual(withClip([voice], 'music', music), [music, voice]);
  assert.deepEqual(withClip([music, voice], 'voice', null), [music]);
  const newVoice = { ...voice, id: 'v2' };
  assert.deepEqual(withClip([music, voice], 'voice', newVoice), [music, newVoice]);
});

test('recordedClip: the lead-in and mic delay are cut, placed where the take began', () => {
  assert.deepEqual(
    recordedClip({ id: 'r', blobRef: 'b', duration: 5, leadIn: 0.4, offset: 0.5, micDelay: 0.1 }),
    { id: 'r', kind: 'voice', blobRef: 'b', trimStart: 0.5, trimEnd: 5, offset: 0.5 },
  );
});

test('recordedClip: nothing usable left gives null', () => {
  assert.equal(recordedClip({ id: 'r', blobRef: 'b', duration: 0.3, leadIn: 0.3, offset: 0, micDelay: 0 }), null);
  assert.equal(recordedClip({ id: 'r', blobRef: 'b', duration: 0.5, leadIn: 0.45, offset: 0, minLength: 1 / 12, micDelay: 0 }), null);
  assert.equal(recordedClip({ id: 'r', blobRef: 'b', duration: 0, leadIn: 0, offset: 0 }), null);
});

test('recordedClip: a take longer than the cap keeps the cap', () => {
  const clip = recordedClip({ id: 'r', blobRef: 'b', duration: MAX_CLIP_SECONDS + 10, leadIn: 1, offset: 0, micDelay: 0 });
  assert.equal(clip.trimEnd - clip.trimStart, MAX_CLIP_SECONDS);
});

test('sanitizeAudioClips: a trim longer than the cap is cut to it', () => {
  const [clip] = sanitizeAudioClips([{ ...good, trimStart: 10, trimEnd: 10 + MAX_CLIP_SECONDS + 50 }]);
  assert.equal(clip.trimEnd, 10 + MAX_CLIP_SECONDS);
});

test('newClip: the whole file, from the start, up to the cap', () => {
  assert.deepEqual(newClip({ id: 'c', blobRef: 'b', duration: 12.5 }), {
    clip: { id: 'c', kind: 'music', blobRef: 'b', trimStart: 0, trimEnd: 12.5, offset: 0 },
    clipped: false,
  });
  const long = newClip({ id: 'c', blobRef: 'b', duration: 240 });
  assert.equal(long.clip.trimEnd, MAX_CLIP_SECONDS);
  assert.equal(long.clipped, true);
});

test('checkImportSize', () => {
  assert.equal(checkImportSize(0), 'empty');
  assert.equal(checkImportSize(1000), 'ok');
  assert.equal(checkImportSize(MAX_IMPORT_BYTES), 'ok');
  assert.equal(checkImportSize(MAX_IMPORT_BYTES + 1), 'too-big');
});

test('animationSeconds and timeAtFrame', () => {
  assert.equal(animationSeconds(24, 12), 2);
  assert.equal(animationSeconds(0, 12), 0);
  assert.equal(animationSeconds(24, 0), 0);
  assert.equal(timeAtFrame(6, 12), 0.5);
  assert.equal(timeAtFrame(0, 12), 0);
});

test('clipPlacement: a short clip plays whole, from its offset', () => {
  assert.deepEqual(clipPlacement({ ...good, trimStart: 1, trimEnd: 3 }, 10), { from: 1, to: 3, at: 0 });
  assert.deepEqual(clipPlacement({ ...good, offset: 2 }, 10), { from: 0, to: 4, at: 2 });
});

test('clipPlacement: the animation length wins — the rest is cut', () => {
  // 4 s of sound in a 2 s animation: only the first 2 s play.
  assert.deepEqual(clipPlacement(good, 2), { from: 0, to: 2, at: 0 });
  // Starting at 1.5 s of a 2 s animation: half a second plays.
  assert.deepEqual(clipPlacement({ ...good, offset: 1.5 }, 2), { from: 0, to: 0.5, at: 1.5 });
});

test('clipPlacement: nothing plays when it starts at or after the end', () => {
  assert.equal(clipPlacement({ ...good, offset: 2 }, 2), null);
  assert.equal(clipPlacement(good, 0), null);
  assert.equal(clipPlacement(null, 5), null);
});

test('sameClips', () => {
  assert.equal(sameClips([], undefined), true);
  assert.equal(sameClips([good], [{ ...good }]), true);
  assert.equal(sameClips([good], []), false);
  assert.equal(sameClips([good], [{ ...good, trimEnd: 3 }]), false);
  const { offset, ...noOffset } = good;
  assert.equal(sameClips([good], [noOffset]), true);
});

// --- 5b: editing in the sound panel ---

// A 10 s clip of a 60 s file, starting 2 s in, in a 4 s animation at
// 12 fps (one frame = 1/12 s).
const fps = 12;
const minLength = minClipSeconds(fps);
const length = 4;
const duration = 60;
const clip = { id: 'c1', blobRef: 'a1', trimStart: 5, trimEnd: 15, offset: 2 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('minClipSeconds is one frame', () => {
  near(minClipSeconds(12), 1 / 12);
  assert.equal(minClipSeconds(0), 0);
});

test('clipVisibleEnd: its own end, or the animation\'s', () => {
  assert.equal(clipVisibleEnd(clip, length), 4);
  assert.equal(clipVisibleEnd({ ...clip, trimEnd: 6 }, length), 3);
});

test('moveClip: later moves only the offset, never past one frame before the end', () => {
  assert.deepEqual(moveClip(clip, 1, { minLength, length }), { ...clip, offset: 3 });
  near(moveClip(clip, 10, { minLength, length }).offset, length - minLength);
});

test('moveClip: earlier than frame 1 slides the sound\'s start under it', () => {
  const moved = moveClip(clip, -3, { minLength, length });
  assert.equal(moved.offset, 0);
  assert.equal(moved.trimStart, 6); // 1 s past frame 1
  assert.equal(moved.trimEnd, 15); // the end stays put in the file
  // ...never past one frame before its end.
  near(moveClip(clip, -100, { minLength, length }).trimStart, 15 - minLength);
});

test('moveClip: moving back within one drag gives the start back', () => {
  assert.deepEqual(moveClip(clip, 0, { minLength, length }), clip);
});

test('trimClipStart: the rest stays where it is in time', () => {
  const later = trimClipStart(clip, 0.5, { minLength, length });
  assert.equal(later.trimStart, 5.5);
  assert.equal(later.offset, 2.5);
  assert.equal(later.trimEnd, 15);
});

test('trimClipStart: earlier is limited by frame 1 and by the file\'s start', () => {
  assert.deepEqual(trimClipStart(clip, -5, { minLength, length }), { ...clip, trimStart: 3, offset: 0 });
  const early = { ...clip, trimStart: 1 };
  assert.deepEqual(trimClipStart(early, -5, { minLength, length }), { ...early, trimStart: 0, offset: 1 });
});

test('trimClipStart: later stops a frame before the animation\'s end when the clip runs past it', () => {
  const t = trimClipStart(clip, 10, { minLength, length });
  near(t.offset, length - minLength);
});

test('trimClipStart: later stops a frame before the clip\'s own end', () => {
  const short = { ...clip, trimEnd: 6 }; // 1 s long, ends at 3 s
  near(trimClipStart(short, 10, { minLength, length }).trimStart, 6 - minLength);
});

test('trimClipEnd: pulling it in trims the end', () => {
  // Visible end is the animation's end (4 s); pull back 1 s.
  const t = trimClipEnd(clip, -1, { duration, minLength, length });
  assert.equal(t.trimEnd, 6); // plays 1 s, from 2 s to 3 s
  near(trimClipEnd(clip, -10, { duration, minLength, length }).trimEnd, 5 + minLength);
});

test('trimClipEnd: back at the animation\'s end keeps a long end, or plays to the file\'s end', () => {
  assert.equal(trimClipEnd(clip, 3, { duration, minLength, length }).trimEnd, 15);
  const short = { ...clip, trimEnd: 6 };
  assert.equal(trimClipEnd(short, 1, { duration, minLength, length }).trimEnd, duration);
  assert.equal(trimClipEnd(short, 0.5, { duration, minLength, length }).trimEnd, 6.5);
});

test('slipClip: picks a later part of the song, same length, same place', () => {
  const s = slipClip(clip, 20, { duration, minLength });
  assert.deepEqual(s, { ...clip, trimStart: 25, trimEnd: 35 });
  assert.deepEqual(slipClip(clip, 100, { duration, minLength }), { ...clip, trimStart: 50, trimEnd: 60 });
  assert.deepEqual(slipClip(clip, -100, { duration, minLength }), { ...clip, trimStart: 0, trimEnd: 10 });
});

test('slipClip: an end at the file\'s end stays there', () => {
  const whole = { ...clip, trimStart: 30, trimEnd: duration };
  assert.deepEqual(slipClip(whole, -20, { duration, minLength }), { ...whole, trimStart: 10 });
  near(slipClip(whole, 100, { duration, minLength }).trimStart, duration - minLength);
});

test('takeGain lifts a quiet take to the target, capped, never down', () => {
  assert.equal(takeGain(TAKE_TARGET_PEAK / 2), 2);
  assert.equal(takeGain(0.001), MAX_TAKE_GAIN);
  assert.equal(takeGain(0.95), 1);
  assert.equal(takeGain(0), 1);
  assert.equal(takeGain(NaN), 1);
});

test('a recorded clip keeps its gain; 1 is left out; sanitize keeps a good one', () => {
  const clip = recordedClip({ id: 'r', blobRef: 'b', duration: 5, leadIn: 0, offset: 0, micDelay: 0, gain: 3.5 });
  assert.equal(clip.gain, 3.5);
  assert.equal('gain' in recordedClip({ id: 'r', blobRef: 'b', duration: 5, leadIn: 0, offset: 0, micDelay: 0 }), false);
  assert.equal(sanitizeAudioClips([{ ...good, kind: 'voice', gain: 3.5 }])[0].gain, 3.5);
  assert.equal('gain' in sanitizeAudioClips([{ ...good, gain: 'x' }])[0], false);
  assert.equal('gain' in sanitizeAudioClips([{ ...good, gain: 99 }])[0], false);
  assert.equal(clipGain({}), 1);
  assert.equal(clipGain(clip), 3.5);
});

test('sameClips notices a gain change', () => {
  assert.equal(sameClips([{ ...good, gain: 2 }], [{ ...good }]), false);
  assert.equal(sameClips([{ ...good, gain: 1 }], [{ ...good }]), true);
});
