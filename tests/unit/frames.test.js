// Unit tests for js/timeline/frames.js — pure frame-order operations.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as F from '../../js/timeline/frames.js';

test('a new frame goes right after the current one, or at the end', () => {
  assert.equal(F.insertIndexAfter(['a', 'b', 'c'], 'a'), 1);
  assert.equal(F.insertIndexAfter(['a', 'b', 'c'], 'c'), 3);
  assert.equal(F.insertIndexAfter(['a', 'b', 'c'], 'zzz'), 3);
});

test('insert and remove are exact inverses, without mutating the input', () => {
  const ids = ['a', 'b', 'c'];
  const removed = F.removeFrameId(ids, 'b');
  assert.deepEqual(removed, { frameIds: ['a', 'c'], index: 1 });
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.deepEqual(F.insertFrameId(removed.frameIds, 'b', removed.index), ids);
  assert.deepEqual(F.removeFrameId(ids, 'zzz'), { frameIds: ids, index: -1 });
  assert.deepEqual(F.insertFrameId(ids, 'd', 99), ['a', 'b', 'c', 'd']);
});

test('after removing a frame, the one before it is shown (or the new first)', () => {
  assert.equal(F.frameAfterRemoval(['a', 'c'], 1), 'a');
  assert.equal(F.frameAfterRemoval(['b', 'c'], 0), 'b');
  assert.equal(F.frameAfterRemoval(['a', 'b'], 2), 'b');
  assert.equal(F.frameAfterRemoval([], 0), null);
});

// --- the reference image across frames (3b) ---

const img = (blobRef, x = 0) => ({ blobRef, x, y: 0, scale: 1, rotation: 0, opacity: 0.5 });
const sameImg = (a, b) => (a === null || b === null ? a === b : a.blobRef === b.blobRef && a.x === b.x);

test('use on all frames lists only the frames that would change', () => {
  const frames = [
    { id: 'a', image: img('p') },
    { id: 'b', image: null },
    { id: 'c', image: img('p') },        // already the same
    { id: 'd', image: img('p', 50) },    // same photo, placed elsewhere
  ];
  const found = F.imageForAllFrames(frames, 'a', sameImg);
  assert.deepEqual(found.image, img('p'));
  assert.deepEqual(found.before, { b: null, d: img('p', 50) });
  // Blank frames and a re-placed copy of the same photo aren't worth a confirm.
  assert.equal(found.replacesOther, false);
});

test('use on all frames flags a different photo on another frame', () => {
  const frames = [{ id: 'a', image: img('p') }, { id: 'b', image: img('q') }, { id: 'c' }];
  const found = F.imageForAllFrames(frames, 'a', sameImg);
  assert.equal(found.replacesOther, true);
  assert.deepEqual(found.before, { b: img('q'), c: null });
});

test('use on all frames needs an image on the source frame', () => {
  assert.equal(F.imageForAllFrames([{ id: 'a', image: null }, { id: 'b', image: img('p') }], 'a', sameImg), null);
  assert.equal(F.imageForAllFrames([{ id: 'a', image: img('p') }], 'zzz', sameImg), null);
});

test('a new frame inherits the photo only when every frame shares it', () => {
  const a = { id: 'a', image: img('p', 10) };
  // One frame with a photo counts as shared (a background to start).
  assert.deepEqual(F.inheritedImage([a], a), img('p', 10));
  // Same photo everywhere, placed differently: the current frame's placement.
  const b = { id: 'b', image: img('p', 99) };
  assert.deepEqual(F.inheritedImage([a, b], b), img('p', 99));
  // A copy, not the same object (frames keep their own placement).
  assert.notEqual(F.inheritedImage([a], a), a.image);
  // A rotoscope (different photos) or a frame without one: nothing.
  assert.equal(F.inheritedImage([a, { id: 'c', image: img('q') }], a), null);
  assert.equal(F.inheritedImage([a, { id: 'c', image: null }], a), null);
  assert.equal(F.inheritedImage([{ id: 'c', image: null }], { id: 'c', image: null }), null);
});
