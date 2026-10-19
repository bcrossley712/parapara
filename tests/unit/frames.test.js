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
