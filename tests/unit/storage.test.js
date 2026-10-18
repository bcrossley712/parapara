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

  assert.equal(frames[0].layers.length, 1);
  const layer = frames[0].layers[0];
  assert.equal(frames[0].activeLayerId, layer.id);
  assert.equal(layer.name, 'Layer 1');
  assert.equal(await storage.loadLayerBitmap(layer.bitmapRef), null, 'blank layer has no blob');
});

test('relaunch reopens the same project instead of creating a new one', async () => {
  const first = await storage.openLastProject();
  relaunch();
  const second = await storage.openLastProject();

  assert.equal(second.project.id, first.project.id);
  assert.equal(second.frames[0].id, first.frames[0].id);
  assert.equal(second.frames[0].layers[0].bitmapRef, first.frames[0].layers[0].bitmapRef);
});

test('layer bitmap round-trips byte-for-byte and bumps updatedAt', async () => {
  const { project, frames } = await storage.openLastProject();
  const ref = frames[0].layers[0].bitmapRef;
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
  const ref = frames[0].layers[0].bitmapRef;

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

test('createFrame copies layer structure with fresh ids and keeps the active layer by position', () => {
  const prev = storage.createFrame('p1');
  prev.layers = [
    { ...storage.createLayer('sketch'), opacity: 0.4 },
    { ...storage.createLayer('line'), locked: true },
    { ...storage.createLayer('color'), visible: false },
  ];
  prev.activeLayerId = prev.layers[1].id;

  const next = storage.createFrame('p1', prev);

  assert.notEqual(next.id, prev.id);
  assert.equal(next.projectId, 'p1');
  assert.deepEqual(next.layers.map((l) => l.name), ['sketch', 'line', 'color']);
  assert.deepEqual(
    next.layers.map((l) => [l.opacity, l.locked, l.visible]),
    [[0.4, false, true], [1, true, true], [1, false, false]]
  );
  for (let i = 0; i < prev.layers.length; i++) {
    assert.notEqual(next.layers[i].id, prev.layers[i].id, 'fresh layer id');
    assert.notEqual(next.layers[i].bitmapRef, prev.layers[i].bitmapRef, 'blank bitmap, not shared');
  }
  assert.equal(next.activeLayerId, next.layers[1].id);
  assert.equal(next.image, null);
});

test('saveFrame and saveProject persist structural changes', async () => {
  const { project, frames } = await storage.openLastProject();
  const frame2 = storage.createFrame(project.id, frames[0]);

  await storage.saveFrame(frame2);
  await storage.saveProject({ ...project, frames: [...project.frames, frame2.id] });

  relaunch();
  const loaded = await storage.openLastProject();
  assert.deepEqual(loaded.frames.map((f) => f.id), [frames[0].id, frame2.id]);
});
