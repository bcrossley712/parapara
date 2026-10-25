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
} from '../../js/audio/clip.js';

const good = { id: 'c1', blobRef: 'a1', trimStart: 0, trimEnd: 4, offset: 0 };

test('sanitizeAudioClips: missing or not an array gives none', () => {
  assert.deepEqual(sanitizeAudioClips(undefined), []);
  assert.deepEqual(sanitizeAudioClips(null), []);
  assert.deepEqual(sanitizeAudioClips({}), []);
});

test('sanitizeAudioClips: a good clip is kept as is', () => {
  assert.deepEqual(sanitizeAudioClips([good]), [good]);
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

test('sanitizeAudioClips: one clip at most; the first usable one wins', () => {
  const second = { ...good, id: 'c2', blobRef: 'a2' };
  assert.deepEqual(sanitizeAudioClips([{ bad: true }, good, second]), [good]);
});

test('sanitizeAudioClips: a trim longer than the cap is cut to it', () => {
  const [clip] = sanitizeAudioClips([{ ...good, trimStart: 10, trimEnd: 10 + MAX_CLIP_SECONDS + 50 }]);
  assert.equal(clip.trimEnd, 10 + MAX_CLIP_SECONDS);
});

test('newClip: the whole file, from the start, up to the cap', () => {
  assert.deepEqual(newClip({ id: 'c', blobRef: 'b', duration: 12.5 }), {
    clip: { id: 'c', blobRef: 'b', trimStart: 0, trimEnd: 12.5, offset: 0 },
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
