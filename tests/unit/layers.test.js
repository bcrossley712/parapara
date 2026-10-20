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

test('referencedBlobIds covers layer bitmaps, frame images, audio and the thumbnail', () => {
  const project = { id: 'p1', audioClips: [{ id: 'c', blobRef: 'audio1' }] };
  const frames = [
    { id: 'f1', bitmapRefs: { a: 'b1', b: 'b2' }, image: { blobRef: 'img1' } },
    { id: 'f2', bitmapRefs: { a: 'b3' }, image: null },
  ];
  assert.deepEqual(
    [...L.referencedBlobIds(project, frames)].sort(),
    ['audio1', 'b1', 'b2', 'b3', 'img1', 'thumb-p1']
  );
});

// --- copy frame / copy layer / duplicate project (2e) ---

const sampleProject = () => ({
  id: 'p1',
  name: 'Walk cycle',
  createdAt: 1,
  updatedAt: 2,
  layers: [layer('a'), layer('b')],
  activeLayerId: 'b',
  frames: ['f1', 'f2'],
  currentFrameId: 'f2',
  palette: ['#ff0000'],
  audioClips: [{ id: 'c', blobRef: 'audio1', trimStart: 0, trimEnd: 1 }],
});
const sampleFrames = () => [
  { id: 'f1', projectId: 'p1', bitmapRefs: { a: 'b1', b: 'b2' }, image: { blobRef: 'img1', x: 5 } },
  { id: 'f2', projectId: 'p1', bitmapRefs: { a: 'b3', b: 'b4' }, image: null },
];

test('mapBlobRefs rewrites every kind of ref and leaves the input alone', () => {
  const project = sampleProject();
  const frames = sampleFrames();
  const out = L.mapBlobRefs(project, frames, (ref) => `new-${ref}`);
  assert.deepEqual(out.frames[0].bitmapRefs, { a: 'new-b1', b: 'new-b2' });
  assert.deepEqual(out.frames[0].image, { blobRef: 'new-img1', x: 5 });
  assert.equal(out.frames[1].image, null);
  assert.equal(out.project.audioClips[0].blobRef, 'new-audio1');
  assert.deepEqual(frames, sampleFrames(), 'frames not mutated');
  assert.deepEqual(project, sampleProject(), 'project not mutated');
});

test('copyFrameRecord: new id and refs, pairs to copy, image shared, rest as-is', () => {
  const [frame] = sampleFrames();
  const { frame: copy, pairs } = L.copyFrameRecord(frame);
  assert.notEqual(copy.id, frame.id);
  assert.equal(copy.projectId, 'p1');
  assert.deepEqual(Object.keys(copy.bitmapRefs).sort(), ['a', 'b']);
  assert.notEqual(copy.bitmapRefs.a, 'b1');
  assert.deepEqual(pairs, [['b1', copy.bitmapRefs.a], ['b2', copy.bitmapRefs.b]]);
  assert.deepEqual(copy.image, frame.image, 'reference image is stored once and shared');
  assert.deepEqual(frame, sampleFrames()[0], 'source not mutated');
});

test('copyLayerRecord: "<name> copy", unlocked, same look, a slot on every frame', () => {
  const src = { id: 'b', name: 'Lines', visible: false, opacity: 0.4, locked: true };
  const frames = [...sampleFrames(), { id: 'f3', bitmapRefs: { a: 'b5' } }];
  const { layer: copy, refs, pairs } = L.copyLayerRecord(src, frames);
  assert.notEqual(copy.id, 'b');
  assert.equal(copy.name, 'Lines copy');
  assert.equal(copy.locked, false);
  assert.equal(copy.visible, false);
  assert.equal(copy.opacity, 0.4);
  assert.deepEqual(Object.keys(refs), ['f1', 'f2', 'f3']);
  assert.equal(new Set(Object.values(refs)).size, 3);
  // f3 had no slot for the source layer: blank, nothing to copy.
  assert.deepEqual(pairs, [['b2', refs.f1], ['b4', refs.f2]]);
});

test('copyProjectRecords remaps every frame and blob, thumbnail to thumb-<newId>', () => {
  const project = sampleProject();
  const frames = sampleFrames();
  const copy = L.copyProjectRecords(project, frames, { name: 'Walk cycle copy', now: 99 });
  const p = copy.project;

  assert.notEqual(p.id, 'p1');
  assert.equal(p.name, 'Walk cycle copy');
  assert.equal(p.createdAt, 99);
  assert.equal(p.updatedAt, 99);
  assert.deepEqual(p.layers, project.layers, 'layer ids kept');
  assert.equal(p.activeLayerId, 'b');
  assert.deepEqual(p.palette, ['#ff0000']);

  assert.deepEqual(p.frames, copy.frames.map((f) => f.id), 'timeline order kept');
  assert.equal(p.currentFrameId, copy.frames[1].id);
  for (const f of copy.frames) {
    assert.equal(f.projectId, p.id);
    assert.ok(!['f1', 'f2'].includes(f.id));
  }

  // Every old ref maps to a fresh one, and the copy references nothing
  // of the original's.
  const from = new Map(copy.pairs);
  assert.deepEqual([...from.keys()].sort(), [...L.referencedBlobIds(project, frames)].sort());
  assert.equal(from.get('thumb-p1'), `thumb-${p.id}`);
  const copyRefs = L.referencedBlobIds(p, copy.frames);
  assert.deepEqual([...copyRefs].sort(), [...from.values()].sort());
  for (const ref of copyRefs) assert.ok(!from.has(ref), `${ref} is shared with the original`);
});

test('copyProjectRecords drops timeline ids with no frame record', () => {
  const project = { ...sampleProject(), frames: ['f1', 'ghost', 'f2'], currentFrameId: 'ghost' };
  const copy = L.copyProjectRecords(project, sampleFrames(), { name: 'x' });
  assert.equal(copy.project.frames.length, 2);
  assert.equal(copy.project.currentFrameId, copy.project.frames[0]);
});

test('a copied layer\'s name stays within MAX_LAYER_NAME, however often it is copied', () => {
  let src = layer('a', 'x'.repeat(L.MAX_LAYER_NAME));
  for (let i = 0; i < 5; i++) {
    src = L.copyLayerRecord(src, []).layer;
    assert.ok(src.name.length <= L.MAX_LAYER_NAME, src.name);
    assert.ok(src.name.endsWith(' copy'));
  }
  assert.equal(L.copyLayerRecord(layer('a', 'Lines'), []).layer.name, 'Lines copy');
});

test('an image shared by several frames is copied once and stays shared (3a)', () => {
  const project = sampleProject();
  const frames = sampleFrames().map((f) => ({ ...f, image: { blobRef: 'img1', x: 1, y: 2, scale: 1, rotation: 0, opacity: 0.5 } }));
  const ids = L.referencedBlobIds(project, frames);
  assert.ok(ids.has('img1'), 'the sweep keeps a shared image');
  const copy = L.copyProjectRecords(project, frames, { name: 'x' });
  const imagePairs = copy.pairs.filter(([from]) => from === 'img1');
  assert.equal(imagePairs.length, 1, 'stored once in the copy too');
  const [, to] = imagePairs[0];
  for (const f of copy.frames) {
    assert.equal(f.image.blobRef, to);
    assert.equal(f.image.opacity, 0.5, 'placement kept');
  }
});
