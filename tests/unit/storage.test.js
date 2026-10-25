// Unit tests for js/storage/storage.js, against an in-memory
// IndexedDB (fake-indexeddb). Each test gets a brand-new database.
//
// Run: npm run test:unit

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as storage from '../../js/storage/storage.js';
import * as L from '../../js/storage/layers.js';

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

test('createProject makes a project with one frame and one blank layer', async () => {
  await storage.initStorage();
  assert.equal(await storage.loadLastProject(), null, 'first launch: no last project');
  const { project, frames } = await storage.createProject();

  assert.equal(project.name, 'Untitled');
  assert.deepEqual(project.canvas, { width: 1920, height: 1080 });
  assert.equal(project.fps, 12);
  assert.equal(project.loop, true);
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

test('relaunch reopens the last project', async () => {
  const first = await storage.createProject();
  relaunch();
  const second = await storage.loadLastProject();

  assert.equal(second.project.id, first.project.id);
  assert.equal(second.frames[0].id, first.frames[0].id);
  assert.deepEqual(second.project.layers, first.project.layers);
  assert.deepEqual(second.frames[0].bitmapRefs, first.frames[0].bitmapRefs);
});

test('layer bitmap round-trips byte-for-byte and bumps updatedAt', async () => {
  const { project, frames } = await storage.createProject();
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
  const { project, frames } = await storage.createProject();
  const ref = frames[0].bitmapRefs[project.activeLayerId];

  await storage.saveLayerBitmap(project.id, ref, new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
  await storage.saveLayerBitmap(project.id, ref, new Blob([new Uint8Array([9, 9])], { type: 'image/png' }));

  const back = new Uint8Array(await (await storage.loadLayerBitmap(ref)).arrayBuffer());
  assert.deepEqual(back, new Uint8Array([9, 9]));
});

test('a last-project pointer to a missing project loads nothing', async () => {
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

  assert.equal(await storage.loadLastProject(), null);
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

  const loaded = await storage.loadLastProject();
  assert.equal(loaded.project.id, 'p1', 'same project, not a new one');
  assert.equal(loaded.project.layers[0].id, frame.layers[0].id);
  const ref = loaded.frames[0].bitmapRefs[loaded.project.activeLayerId];
  assert.equal(ref, frame.layers[0].bitmapRef);
  const back = await storage.loadLayerBitmap(ref);
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes);
});

test('saveFrame and saveProject persist structural changes', async () => {
  const { project, frames } = await storage.createProject();
  const frame2 = storage.createFrame(project.id, project.layers);

  await storage.saveFrame(frame2);
  await storage.saveProject({ ...project, frames: [...project.frames, frame2.id] });

  relaunch();
  const loaded = await storage.loadLastProject();
  assert.deepEqual(loaded.frames.map((f) => f.id), [frames[0].id, frame2.id]);
});

test('saveProjectAndFrames writes the project and frames together', async () => {
  const { project, frames } = await storage.createProject();
  const extra = storage.createLayer('Layer 2');
  const updatedProject = { ...project, layers: [...project.layers, extra] };
  const updatedFrame = { ...frames[0], bitmapRefs: { ...frames[0].bitmapRefs, [extra.id]: 'new-ref' } };

  await storage.saveProjectAndFrames(updatedProject, [updatedFrame]);
  relaunch();
  const loaded = await storage.loadLastProject();
  assert.deepEqual(loaded.project.layers.map((l) => l.name), ['Layer 1', 'Layer 2']);
  assert.equal(loaded.frames[0].bitmapRefs[extra.id], 'new-ref');
});

test('deleteUnreferencedBlobs removes only this project\'s unreferenced blobs', async () => {
  const { project, frames } = await storage.createProject();
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
  const { project, frames } = await storage.createProject();
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

// --- gallery (2d) ---

const png = (...bytes) => new Blob([new Uint8Array(bytes)], { type: 'image/png' });

function allKeys(storeName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('parapara');
    req.onsuccess = () => {
      const r = req.result.transaction(storeName).objectStore(storeName).getAllKeys();
      r.onsuccess = () => { req.result.close(); resolve(r.result); };
      r.onerror = () => reject(r.error);
    };
    req.onerror = () => reject(req.error);
  });
}

test('nextProjectName counts past the highest "Animation N", ignoring renamed ones', () => {
  assert.equal(storage.nextProjectName([]), 'Animation 1');
  assert.equal(storage.nextProjectName(['Untitled']), 'Animation 1');
  assert.equal(storage.nextProjectName(['Animation 1', 'Animation 3', 'My cat']), 'Animation 4');
  assert.equal(storage.nextProjectName(['Animation 2x', 'animation 5']), 'Animation 1');
});

test('listProjects returns every project, most recently changed first', async () => {
  const a = await storage.createProject('A');
  await sleep(5);
  const b = await storage.createProject('B');
  await sleep(5);
  // Drawing on A makes it the most recent.
  await storage.saveLayerBitmap(a.project.id, a.frames[0].bitmapRefs[a.project.activeLayerId], png(1));

  const list = await storage.listProjects();
  assert.deepEqual(list.map((p) => p.name), ['A', 'B']);
  assert.ok(list.every((p) => Array.isArray(p.frames)));
  assert.ok(b.project.id);
});

test('renameProject changes the name but not updatedAt', async () => {
  const { project } = await storage.createProject('Old');
  await sleep(5);
  await storage.renameProject(project.id, 'New');
  const { project: back } = await storage.loadProject(project.id);
  assert.equal(back.name, 'New');
  assert.equal(back.updatedAt, project.updatedAt);
});

test('deleteProject removes the project, its frames and blobs, and nothing else', async () => {
  const keep = await storage.createProject('Keep');
  const gone = await storage.createProject('Gone');
  const goneFrame2 = storage.createFrame(gone.project.id, gone.project.layers);
  await storage.saveProjectAndFrames(
    { ...gone.project, frames: [...gone.project.frames, goneFrame2.id] },
    [...gone.frames, goneFrame2]
  );
  const keepRef = keep.frames[0].bitmapRefs[keep.project.activeLayerId];
  const goneRef = gone.frames[0].bitmapRefs[gone.project.activeLayerId];
  await storage.saveLayerBitmap(keep.project.id, keepRef, png(1));
  await storage.saveLayerBitmap(gone.project.id, goneRef, png(2));
  await storage.saveThumbnail(keep.project.id, png(3));
  await storage.saveThumbnail(gone.project.id, png(4));

  // "Gone" was created last, so it's the last-opened project.
  await storage.deleteProject(gone.project.id);

  assert.equal(await storage.loadProject(gone.project.id), null);
  assert.deepEqual(await allKeys('frames'), [keep.frames[0].id]);
  assert.deepEqual(
    (await allKeys('blobs')).sort(),
    [keepRef, storage.thumbnailBlobId(keep.project.id)].sort()
  );
  assert.equal(await storage.loadLastProject(), null, 'pointer to the deleted project cleared');
  assert.ok(await storage.loadProject(keep.project.id));
});

test('deleteProject leaves the last-project pointer alone when it points elsewhere', async () => {
  const other = await storage.createProject('Other');
  const open = await storage.createProject('Open');
  await storage.deleteProject(other.project.id);
  const last = await storage.loadLastProject();
  assert.equal(last.project.id, open.project.id);
});

test('thumbnails round-trip, don\'t bump updatedAt, and survive the launch sweep', async () => {
  const { project, frames } = await storage.createProject();
  assert.equal(await storage.loadThumbnail(project.id), null, 'none until drawn');

  await sleep(5);
  await storage.saveThumbnail(project.id, png(9, 8, 7));
  const back = await storage.loadThumbnail(project.id);
  assert.equal(back.type, 'image/png');
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), new Uint8Array([9, 8, 7]));
  assert.equal((await storage.loadProject(project.id)).project.updatedAt, project.updatedAt);

  const { referencedBlobIds } = await import('../../js/storage/layers.js');
  const deleted = await storage.deleteUnreferencedBlobs(project.id, referencedBlobIds(project, frames));
  assert.equal(deleted, 0);
  assert.ok(await storage.loadThumbnail(project.id));
});

test('saveLastProjectId points relaunch at that project', async () => {
  const a = await storage.createProject('A');
  await storage.createProject('B');
  await storage.saveLastProjectId(a.project.id);
  relaunch();
  assert.equal((await storage.loadLastProject()).project.id, a.project.id);
});

// --- copying (2e) ---

test('copyBlobs copies pixels to new refs and skips blank sources', async () => {
  const { project, frames } = await storage.createProject('A');
  const ref = frames[0].bitmapRefs[project.activeLayerId];
  await storage.saveLayerBitmap(project.id, ref, png(7));
  await storage.copyBlobs(project.id, [[ref, 'copy-1'], ['never-saved', 'copy-2']]);

  const copied = await storage.loadLayerBitmap('copy-1');
  assert.deepEqual(new Uint8Array(await copied.arrayBuffer()), new Uint8Array(await png(7).arrayBuffer()));
  assert.equal(await storage.loadLayerBitmap('copy-2'), null, 'blank stays blank');
  assert.ok(await storage.loadLayerBitmap(ref), 'source kept');
  const removed = await storage.deleteUnreferencedBlobs(project.id, new Set([ref, 'copy-1']));
  assert.equal(removed, 0, 'copies belong to the same project');
});

test('a duplicated project opens with its own copies of every blob', async () => {
  const { project, frames } = await storage.createProject('Orig');
  const ref = frames[0].bitmapRefs[project.activeLayerId];
  await storage.saveLayerBitmap(project.id, ref, png(5));
  await storage.saveThumbnail(project.id, png(6));
  const loaded = await storage.loadProject(project.id);

  const copy = L.copyProjectRecords(loaded.project, loaded.frames, { name: 'Orig copy' });
  await storage.saveProjectCopy(copy);

  const reopened = await storage.loadProject(copy.project.id);
  assert.equal(reopened.project.name, 'Orig copy');
  assert.equal(reopened.frames.length, 1);
  const newRef = reopened.frames[0].bitmapRefs[project.activeLayerId];
  assert.notEqual(newRef, ref);
  assert.ok(await storage.loadLayerBitmap(newRef));
  assert.ok(await storage.loadThumbnail(copy.project.id));

  // Deleting the original leaves the copy whole.
  await storage.deleteProject(project.id);
  assert.ok(await storage.loadLayerBitmap(newRef));
  assert.ok(await storage.loadThumbnail(copy.project.id));
  assert.equal((await storage.listProjects()).length, 1);
});

test('copyName adds " copy", shortening the name to fit the limit', () => {
  assert.equal(storage.copyName('Walk cycle', 60), 'Walk cycle copy');
  const long = storage.copyName('a'.repeat(storage.MAX_PROJECT_NAME), storage.MAX_PROJECT_NAME);
  assert.equal(long.length, storage.MAX_PROJECT_NAME);
  assert.ok(long.endsWith(' copy'));
  // No dangling space where the cut lands after a word.
  assert.equal(storage.copyName('ab cd', 8), 'ab copy');
});

test('recent colors round-trip, and are null before anything is saved', async () => {
  await storage.initStorage();
  assert.equal(await storage.loadRecentColors(), null);
  await storage.saveRecentColors(['#ff0000', '#00ff00']);
  relaunch();
  assert.deepEqual(await storage.loadRecentColors(), ['#ff0000', '#00ff00']);
});

test('a new project starts with an empty palette', () => {
  assert.deepEqual(storage.createProjectRecord().palette, []);
});

// Step 5: the sound file is kept byte for byte with its type, and the
// launch sweep keeps it while a clip points at it.
test('a sound file round-trips with its type and survives the sweep while a clip uses it', async () => {
  await storage.initStorage();
  const { project, frames } = await storage.createProject();
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
  await storage.saveAudioBlob(project.id, 'sound-1', new Blob([bytes], { type: 'audio/mp4' }));
  const back = await storage.loadLayerBitmap('sound-1');
  assert.equal(back.type, 'audio/mp4');
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes);

  const withClip = { ...project, audioClips: [{ id: 'c', blobRef: 'sound-1', trimStart: 0, trimEnd: 1, offset: 0 }] };
  assert.equal(await storage.deleteUnreferencedBlobs(project.id, L.referencedBlobIds(withClip, frames)), 0);
  assert.notEqual(await storage.loadLayerBitmap('sound-1'), null);

  // Once no clip points at it (deleted, and the undo history is gone).
  const without = { ...project, audioClips: [] };
  assert.equal(await storage.deleteUnreferencedBlobs(project.id, L.referencedBlobIds(without, frames)), 1);
  assert.equal(await storage.loadLayerBitmap('sound-1'), null);
});

test('a sound file without a type is refused, not stored as a PNG', async () => {
  await storage.initStorage();
  const { project } = await storage.createProject();
  await assert.rejects(storage.saveAudioBlob(project.id, 'sound-2', new Blob([new Uint8Array([1])])));
  assert.equal(await storage.loadLayerBitmap('sound-2'), null);
});
