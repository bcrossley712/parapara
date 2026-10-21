// Unit tests for js/timeline/onion.js — onion skin's saved settings
// and which frames show as ghosts.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeOnion, ghostFrames, DEFAULT_ONION, MAX_ONION_FRAMES,
  MIN_ONION_OPACITY, MAX_ONION_OPACITY, ONION_TINTS,
} from '../../js/timeline/onion.js';

const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const on = (changes = {}) => ({ ...DEFAULT_ONION, on: true, ...changes });
const summary = (ghosts) => ghosts.map((g) => `${g.id}${g.side === 'before' ? '-' : '+'}${g.distance}`);

test('missing settings are the defaults: off, 1 before, 1 after, red and green', () => {
  for (const saved of [undefined, null, 'x', 5, []]) {
    assert.deepEqual(sanitizeOnion(saved), { ...DEFAULT_ONION });
  }
  assert.equal(DEFAULT_ONION.on, false);
  assert.equal(DEFAULT_ONION.before, 1);
  assert.equal(DEFAULT_ONION.after, 1);
  assert.equal(DEFAULT_ONION.tintBefore, ONION_TINTS[0].hex);
  assert.equal(DEFAULT_ONION.tintAfter, ONION_TINTS[1].hex);
});

test('each bad field falls back on its own', () => {
  const clean = sanitizeOnion({
    on: true, before: 'two', after: 2, opacity: Number.NaN, tintBefore: '#123456', tintAfter: ONION_TINTS[2].hex,
  });
  assert.deepEqual(clean, {
    on: true,
    before: DEFAULT_ONION.before,
    after: 2,
    opacity: DEFAULT_ONION.opacity,
    tintBefore: DEFAULT_ONION.tintBefore,
    tintAfter: ONION_TINTS[2].hex,
  });
  // Only true turns it on.
  assert.equal(sanitizeOnion({ on: 'yes' }).on, false);
  // Not whole numbers aren't counts.
  assert.equal(sanitizeOnion({ before: 1.5 }).before, DEFAULT_ONION.before);
});

test('counts and opacity are clamped to their ranges', () => {
  const high = sanitizeOnion({ before: 99, after: 4, opacity: 5 });
  assert.equal(high.before, MAX_ONION_FRAMES);
  assert.equal(high.after, MAX_ONION_FRAMES);
  assert.equal(high.opacity, MAX_ONION_OPACITY);
  const low = sanitizeOnion({ before: -1, after: 0, opacity: 0 });
  assert.equal(low.before, 0);
  assert.equal(low.after, 0);
  assert.equal(low.opacity, MIN_ONION_OPACITY);
});

test('off shows no ghosts', () => {
  assert.deepEqual(ghostFrames(ids, 'c', DEFAULT_ONION), []);
  assert.deepEqual(ghostFrames(ids, 'c', undefined), []);
});

test('on: the frame before and the frame after, tinted by side', () => {
  const ghosts = ghostFrames(ids, 'c', on());
  assert.deepEqual(summary(ghosts), ['b-1', 'd+1']);
  assert.equal(ghosts[0].tint, DEFAULT_ONION.tintBefore);
  assert.equal(ghosts[1].tint, DEFAULT_ONION.tintAfter);
  assert.equal(ghosts[0].alpha, 1);
});

test('farthest first, each one further out fainter', () => {
  const ghosts = ghostFrames(ids, 'd', on({ before: 3, after: 2 }));
  assert.deepEqual(summary(ghosts), ['a-3', 'b-2', 'f+2', 'c-1', 'e+1']);
  const alphaAt = (d) => ghosts.find((g) => g.distance === d).alpha;
  assert.ok(alphaAt(1) > alphaAt(2));
  assert.ok(alphaAt(2) > alphaAt(3));
  assert.ok(alphaAt(3) > 0);
});

test('no wrap-around at either end', () => {
  assert.deepEqual(summary(ghostFrames(ids, 'a', on({ before: 3, after: 1 }))), ['b+1']);
  assert.deepEqual(summary(ghostFrames(ids, 'g', on({ before: 1, after: 3 }))), ['f-1']);
  assert.deepEqual(ghostFrames(['only'], 'only', on({ before: 3, after: 3 })), []);
});

test('zero on a side shows nothing on that side', () => {
  assert.deepEqual(summary(ghostFrames(ids, 'c', on({ before: 0, after: 2 }))), ['e+2', 'd+1']);
  assert.deepEqual(ghostFrames(ids, 'c', on({ before: 0, after: 0 })), []);
});

test('a frame that is not in the timeline has no ghosts', () => {
  assert.deepEqual(ghostFrames(ids, 'zzz', on()), []);
});
