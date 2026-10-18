// Unit tests for js/storage/layers.js — pure layer-list operations.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as L from '../../js/storage/layers.js';

const layer = (id, name = id) => ({ id, name, visible: true, opacity: 1, locked: false });
const ids = (layers) => layers.map((l) => l.id);

test('nextLayerName counts up past the highest "Layer N" and the layer count', () => {
  assert.equal(L.nextLayerName([layer('a', 'Layer 1')]), 'Layer 2');
  assert.equal(L.nextLayerName([layer('a', 'Layer 1'), layer('b', 'Layer 5')]), 'Layer 6');
  assert.equal(L.nextLayerName([layer('a', 'sketch'), layer('b', 'lines')]), 'Layer 3');
  assert.equal(L.nextLayerName([]), 'Layer 1');
});

test('a new layer goes directly above the active one, or on top', () => {
  const layers = [layer('a'), layer('b'), layer('c')];
  assert.equal(L.insertIndexAbove(layers, 'a'), 1);
  assert.equal(L.insertIndexAbove(layers, 'c'), 3);
  assert.equal(L.insertIndexAbove(layers, 'missing'), 3);
});

test('insert and remove are exact inverses, without mutating the input', () => {
  const layers = [layer('a'), layer('b'), layer('c')];
  const removed = L.removeLayer(layers, 'b');
  assert.deepEqual(ids(removed.layers), ['a', 'c']);
  assert.equal(removed.index, 1);
  assert.deepEqual(ids(layers), ['a', 'b', 'c'], 'input untouched');

  const back = L.insertLayer(removed.layers, removed.layer, removed.index);
  assert.deepEqual(back, layers);

  assert.equal(L.removeLayer(layers, 'zzz').layer, null);
});

test('after removing a layer the one below becomes active (or the new bottom)', () => {
  const remaining = [layer('a'), layer('c')];
  assert.equal(L.activeAfterRemoval(remaining, 1), 'a'); // removed b, between a and c
  assert.equal(L.activeAfterRemoval(remaining, 0), 'a'); // removed the bottom
  assert.equal(L.activeAfterRemoval(remaining, 2), 'c'); // removed the top
  assert.equal(L.activeAfterRemoval([], 0), null);
});

test('moveLayer puts the layer at its new index', () => {
  const layers = [layer('a'), layer('b'), layer('c')];
  assert.deepEqual(ids(L.moveLayer(layers, 'a', 2)), ['b', 'c', 'a']);
  assert.deepEqual(ids(L.moveLayer(layers, 'c', 0)), ['c', 'a', 'b']);
  assert.deepEqual(ids(L.moveLayer(layers, 'b', 1)), ['a', 'b', 'c']);
  assert.equal(L.moveLayer(layers, 'zzz', 0), layers);
});

test('updateLayer changes one layer and returns new objects', () => {
  const layers = [layer('a'), layer('b')];
  const out = L.updateLayer(layers, 'b', { opacity: 0.3, name: 'line' });
  assert.equal(out[1].opacity, 0.3);
  assert.equal(out[1].name, 'line');
  assert.equal(out[0], layers[0]);
  assert.equal(layers[1].opacity, 1, 'input untouched');
});

test('detach and attach round-trip every frame\'s bitmap slot', () => {
  const frames = [
    { id: 'f1', bitmapRefs: { a: 'r1a', b: 'r1b' } },
    { id: 'f2', bitmapRefs: { a: 'r2a', b: 'r2b' } },
  ];
  const { frames: detached, refs } = L.detachLayerRefs(frames, 'b');
  assert.deepEqual(refs, { f1: 'r1b', f2: 'r2b' });
  assert.deepEqual(detached.map((f) => f.bitmapRefs), [{ a: 'r1a' }, { a: 'r2a' }]);
  assert.deepEqual(frames[0].bitmapRefs, { a: 'r1a', b: 'r1b' }, 'input untouched');

  const attached = L.attachLayerRefs(detached, 'b', refs);
  assert.deepEqual(attached.map((f) => f.bitmapRefs), frames.map((f) => f.bitmapRefs));
});

test('attach gives a frame without a saved ref a fresh blank one', () => {
  const frames = [{ id: 'f1', bitmapRefs: {} }, { id: 'f2', bitmapRefs: {} }];
  const out = L.attachLayerRefs(frames, 'n', { f1: 'kept' });
  assert.equal(out[0].bitmapRefs.n, 'kept');
  assert.ok(out[1].bitmapRefs.n && out[1].bitmapRefs.n !== 'kept');
});

test('referencedBlobIds covers layer bitmaps, frame images and audio', () => {
  const project = { audioClips: [{ id: 'c', blobRef: 'audio1' }] };
  const frames = [
    { id: 'f1', bitmapRefs: { a: 'b1', b: 'b2' }, image: { blobRef: 'img1' } },
    { id: 'f2', bitmapRefs: { a: 'b3' }, image: null },
  ];
  assert.deepEqual(
    [...L.referencedBlobIds(project, frames)].sort(),
    ['audio1', 'b1', 'b2', 'b3', 'img1']
  );
});
