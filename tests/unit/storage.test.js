// Unit tests for js/storage/storage.js, against an in-memory
// IndexedDB (fake-indexeddb). Each test gets a brand-new database.
//
// Run: npm run test:unit

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as storage from '../../js/storage/storage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simulates closing and reopening the app: drop the cached connection
// but keep the same database contents.
function relaunch() {
  storage._resetForTests();
}

beforeEach(() => {
  storage._resetForTests();
  globalThis.indexedDB = new IDBFactory();
});

test('first launch creates a project with one frame and one blank layer', async () => {
  await storage.initStorage();
  const { project, frames } = await storage.openLastProject();

  assert.equal(project.name, 'Untitled');
  assert.deepEqual(project.canvas, { width: 1920, height: 1080 });
  assert.equal(project.fps, 12);
  assert.deepEqual(project.audioClips, []);

  assert.equal(frames.length, 1);
  assert.deepEqual(project.frames, [frames[0].id]);
  assert.equal(frames[0].projectId, project.id);
  assert.equal(frames[0].image, null);
  assert.equal(frames[0].undoStack, undefined, 'undo is never persisted');

  // Layers live on the project, shared by every frame.
  assert.equal(project.layers.length, 1);
  const layer = project.layers[0];
  assert.equal(project.activeLayerId, layer.id);
  assert.deepEqual(
    { name: layer.name, visible: layer.visible, opacity: layer.opacity, locked: layer.locked },
    { name: 'Layer 1', visible: true, opacity: 1, locked: false }
  );
  assert.equal(frames[0].layers, undefined, 'frames hold no layer list of their own');
  const ref = frames[0].bitmapRefs[layer.id];
  assert.ok(ref, 'frame has a bitmap slot for the layer');
  assert.equal(await storage.loadLayerBitmap(ref), null, 'blank layer has no blob');
});

test('relaunch reopens the same project instead of creating a new one', async () => {
  const first = await storage.openLastProject();
  relaunch();
  const second = await storage.openLastProject();

  assert.equal(second.project.id, first.project.id);
  assert.equal(second.frames[0].id, first.frames[0].id);
  assert.deepEqual(second.project.layers, first.project.layers);
  assert.deepEqual(second.frames[0].bitmapRefs, first.frames[0].bitmapRefs);
});

test('layer bitmap round-trips byte-for-byte and bumps updatedAt', async () => {
  const { project, frames } = await storage.openLastProject();
  const ref = frames[0].bitmapRefs[project.activeLayerId];
  const bytes = new Uint8Array(5000).map((_, i) => (i * 37) % 256);

  await sleep(5); // so updatedAt can differ from createdAt
  await storage.saveLayerBitmap(project.id, ref, new Blob([bytes], { type: 'image/png' }));

  relaunch();
  const back = await storage.loadLayerBitmap(ref);
  assert.equal(back.type, 'image/png');
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes);

  const reloaded = await storage.loadProject(project.id);
  assert.ok(reloaded.project.updatedAt > project.updatedAt, 'updatedAt bumped');
});

test('saving again overwrites the previous bitmap', async () => {
  const { project, frames } = await storage.openLastProject();
  const ref = frames[0].bitmapRefs[project.activeLayerId];

  await storage.saveLayerBitmap(project.id, ref, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
  await storage.saveLayerBitmap(project.id, ref, new Blob([new Uint8Array([9, 9])], { type: 'image/png' }));

  const back = new Uint8Array(await (await storage.loadLayerBitmap(ref)).arrayBuffer());
  assert.deepEqual(back, new Uint8Array([9, 9]));
});

test('a last-project pointer to a missing project falls back to creating a new one', async () => {
  // Create the database, then point "last project" at an id that
  // doesn't exist (e.g. a project deleted elsewhere).
  await storage.initStorage();
  relaunch();
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: 'lastProjectId', value: 'gone' });
    tx.oncomplete = resolve;
  });
  db.close();

  const { project, frames } = await storage.openLastProject();
  assert.notEqual(project.id, 'gone');
  assert.equal(frames.length, 1);
});

test('createFrame gives every project layer its own blank bitmap slot', () => {
  const layers = [storage.createLayer('sketch'), storage.createLayer('line')];
  const a = storage.createFrame('p1', layers);
  const b = storage.createFrame('p1', layers);

  assert.equal(a.projectId, 'p1');
  assert.deepEqual(Object.keys(a.bitmapRefs).sort(), layers.map((l) => l.id).sort());
  for (const layer of layers) {
    assert.notEqual(a.bitmapRefs[layer.id], b.bitmapRefs[layer.id], 'blank bitmap, not shared');
  }
  assert.equal(a.image, null);
});

test('ensureBitmapRefs fills only the gaps', () => {
  const layers = [storage.createLayer('a'), storage.createLayer('b')];
  const frame = storage.createFrame('p1', [layers[0]]);
  const keep = frame.bitmapRefs[layers[0].id];

  assert.equal(storage.ensureBitmapRefs(frame, layers), true);
  assert.equal(frame.bitmapRefs[layers[0].id], keep, 'existing ref untouched');
  assert.ok(frame.bitmapRefs[layers[1].id]);
  assert.equal(storage.ensureBitmapRefs(frame, layers), false, 'nothing left to fill');
});

// A version-1 frame, as 2a/2b saved it.
function v1Frame(projectId, layers, activeIndex = 0) {
  const full = layers.map((props) => ({
    id: storage.newId(), bitmapRef: storage.newId(),
    name: 'Layer 1', visible: true, opacity: 1, locked: false, ...props,
  }));
  return { id: storage.newId(), projectId, layers: full, activeLayerId: full[activeIndex].id, image: null };
}

test('migrateToSharedLayers keeps layer ids, properties and bitmaps', () => {
  const frame = v1Frame('p1', [{ name: 'sketch', opacity: 0.4 }, { name: 'line', locked: true }], 1);
  const project = { id: 'p1', frames: [frame.id], fps: 12 };

  const out = storage.migrateToSharedLayers(project, [frame]);

  assert.deepEqual(out.project.layers, [
    { id: frame.layers[0].id, name: 'sketch', visible: true, opacity: 0.4, locked: false },
    { id: frame.layers[1].id, name: 'line', visible: true, opacity: 1, locked: true },
  ]);
  assert.equal(out.project.activeLayerId, frame.layers[1].id);
  assert.equal(out.project.fps, 12, 'other fields kept');
  assert.deepEqual(out.frames[0].bitmapRefs, {
    [frame.layers[0].id]: frame.layers[0].bitmapRef,
    [frame.layers[1].id]: frame.layers[1].bitmapRef,
  });
  assert.equal(out.frames[0].layers, undefined);
  assert.equal(out.frames[0].activeLayerId, undefined);
});

test('migrateToSharedLayers matches other frames by position and drops nothing', () => {
  const f1 = v1Frame('p1', [{ name: 'a' }]);
  const f2 = v1Frame('p1', [{ name: 'a2' }, { name: 'extra' }]);
  const out = storage.migrateToSharedLayers({ id: 'p1', frames: [f1.id, f2.id] }, [f1, f2]);

  assert.deepEqual(out.project.layers.map((l) => l.name), ['a', 'extra']);
  const [a, extra] = out.project.layers;
  assert.equal(out.frames[1].bitmapRefs[a.id], f2.layers[0].bitmapRef);
  assert.equal(out.frames[1].bitmapRefs[extra.id], f2.layers[1].bitmapRef, 'extra layer kept');
  assert.ok(out.frames[0].bitmapRefs[extra.id], 'shorter frame gets a blank slot');
});

test('migrateToSharedLayers leaves an already-migrated project alone', () => {
  const project = storage.createProjectRecord();
  const frames = [storage.createFrame(project.id, project.layers)];
  const out = storage.migrateToSharedLayers(project, frames);
  assert.equal(out.project, project);
  assert.equal(out.frames, frames);
});

test('opening a version-1 database migrates it and keeps the drawing', async () => {
  // Build a version-1 database by hand, as 2a/2b left it.
  const frame = v1Frame('p1', [{ name: 'Layer 1' }]);
  const project = {
    id: 'p1', name: 'Untitled', createdAt: 1, updatedAt: 1,
    canvas: { width: 1920, height: 1080 }, fps: 12, frames: [frame.id], audioClips: [],
  };
  const bytes = new Uint8Array([7, 7, 7]);
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      db.createObjectStore('frames', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      db.createObjectStore('blobs', { keyPath: 'id' }).createIndex('projectId', 'projectId');
      db.createObjectStore('meta', { keyPath: 'key' });
      const tx = req.transaction;
      tx.objectStore('projects').put(project);
      tx.objectStore('frames').put(frame);
      tx.objectStore('blobs').put({ id: frame.layers[0].bitmapRef, projectId: 'p1', type: 'image/png', buffer: bytes.buffer });
      tx.objectStore('meta').put({ key: 'lastProjectId', value: 'p1' });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });

  const loaded = await storage.openLastProject();
  assert.equal(loaded.project.id, 'p1', 'same project, not a new one');
  assert.equal(loaded.project.layers[0].id, frame.layers[0].id);
  const ref = loaded.frames[0].bitmapRefs[loaded.project.activeLayerId];
  assert.equal(ref, frame.layers[0].bitmapRef);
  const back = await storage.loadLayerBitmap(ref);
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes);
});

test('saveFrame and saveProject persist structural changes', async () => {
  const { project, frames } = await storage.openLastProject();
  const frame2 = storage.createFrame(project.id, project.layers);

  await storage.saveFrame(frame2);
  await storage.saveProject({ ...project, frames: [...project.frames, frame2.id] });

  relaunch();
  const loaded = await storage.openLastProject();
  assert.deepEqual(loaded.frames.map((f) => f.id), [frames[0].id, frame2.id]);
});

test('saveProjectAndFrames writes the project and frames together', async () => {
  const { project, frames } = await storage.openLastProject();
  const extra = storage.createLayer('Layer 2');
  const updatedProject = { ...project, layers: [...project.layers, extra] };
  const updatedFrame = { ...frames[0], bitmapRefs: { ...frames[0].bitmapRefs, [extra.id]: 'new-ref' } };

  await storage.saveProjectAndFrames(updatedProject, [updatedFrame]);
  relaunch();
  const loaded = await storage.openLastProject();
  assert.deepEqual(loaded.project.layers.map((l) => l.name), ['Layer 1', 'Layer 2']);
  assert.equal(loaded.frames[0].bitmapRefs[extra.id], 'new-ref');
});

test('deleteUnreferencedBlobs removes only this project\'s unreferenced blobs', async () => {
  const { project, frames } = await storage.openLastProject();
  const keep = frames[0].bitmapRefs[project.activeLayerId];
  const png = () => new Blob([new Uint8Array([1])], { type: 'image/png' });
  await storage.saveLayerBitmap(project.id, keep, png());
  await storage.saveLayerBitmap(project.id, 'orphan', png());
  await storage.saveLayerBitmap('other-project', 'not-mine', png());

  const deleted = await storage.deleteUnreferencedBlobs(project.id, new Set([keep]));
  assert.equal(deleted, 1);
  assert.ok(await storage.loadLayerBitmap(keep));
  assert.equal(await storage.loadLayerBitmap('orphan'), null);
  assert.ok(await storage.loadLayerBitmap('not-mine'), 'other projects untouched');
});

test('UI state round-trips, and is null before anything is saved', async () => {
  await storage.initStorage();
  assert.equal(await storage.loadUiState(), null);
  await storage.saveUiState({ layersPanelOpen: true });
  relaunch();
  assert.deepEqual(await storage.loadUiState(), { layersPanelOpen: true });
});

test('saveProjectAndFrames deletes removed frame records', async () => {
  const { project, frames } = await storage.openLastProject();
  const frame2 = storage.createFrame(project.id, project.layers);
  await storage.saveProjectAndFrames({ ...project, frames: [frames[0].id, frame2.id] }, [...frames, frame2]);
  await storage.saveProjectAndFrames({ ...project, frames: [frames[0].id] }, frames, [frame2.id]);

  const remaining = await new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onsuccess = () => {
      const r = req.result.transaction('frames').objectStore('frames').getAllKeys();
      r.onsuccess = () => { req.result.close(); resolve(r.result); };
      r.onerror = () => reject(r.error);
    };
  });
  assert.deepEqual(remaining, [frames[0].id]);
});
