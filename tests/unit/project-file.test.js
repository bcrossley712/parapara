// Unit tests for js/storage/zip.js and js/storage/project-file.js
// (step 7a): the zip container, packing a project into one file and
// opening it again as a new project — through a real (fake) IndexedDB
// for the storage half.
//
// Run: npm run test:unit

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeZip, readZip, crc32, ZipError } from '../../js/storage/zip.js';
import * as PF from '../../js/storage/project-file.js';
import * as storage from '../../js/storage/storage.js';
import * as L from '../../js/storage/layers.js';

beforeEach(() => {
  storage._resetForTests();
  globalThis.indexedDB = new IDBFactory();
});

const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
const bytes = (...values) => new Uint8Array(values);

// --- zip ---

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(enc('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('a zip round-trips its entries, names in UTF-8', async () => {
  const zip = makeZip([
    { name: 'a.txt', data: enc('hello') },
    { name: 'blobs/ぱら.bin', data: bytes(0, 1, 2, 255) },
    { name: 'empty', data: new Uint8Array(0) },
  ]);
  assert.equal(zip.type, 'application/zip');
  const read = await readZip(zip);
  assert.deepEqual(read.names, ['a.txt', 'blobs/ぱら.bin', 'empty']);
  assert.equal(dec(await read.read('a.txt')), 'hello');
  assert.deepEqual(await read.read('blobs/ぱら.bin'), bytes(0, 1, 2, 255));
  assert.equal((await read.read('empty')).length, 0);
  assert.equal(read.has('nope'), false);
  await assert.rejects(read.read('nope'), ZipError);
});

test('a zip refuses duplicate names', () => {
  assert.throws(() => makeZip([{ name: 'x', data: bytes(1) }, { name: 'x', data: bytes(2) }]));
});

test('reading refuses what isn’t a zip, a cut-short zip and a damaged entry', async () => {
  await assert.rejects(readZip(new Blob([enc('just some text, not a zip at all')])), ZipError);
  await assert.rejects(readZip(new Blob([])), ZipError);

  const whole = new Uint8Array(await makeZip([{ name: 'a', data: enc('abcdef') }]).arrayBuffer());
  await assert.rejects(readZip(new Blob([whole.slice(0, whole.length - 30)])), ZipError);

  const damaged = whole.slice();
  damaged[30 + 1 + 2] ^= 0xff; // a byte of the entry's data: header (30) + name (1)
  const read = await readZip(new Blob([damaged]));
  await assert.rejects(read.read('a'), /Damaged/);
});

test('reading refuses a compressed entry instead of misreading it', async () => {
  const whole = new Uint8Array(await makeZip([{ name: 'a', data: enc('abc') }]).arrayBuffer());
  const view = new DataView(whole.buffer);
  const central = view.getUint32(whole.length - 22 + 16, true);
  view.setUint16(central + 10, 8, true); // method: deflate
  await assert.rejects(readZip(new Blob([whole])), /Compressed/);
});

// --- project file ---

async function makeSaved() {
  await storage.initStorage();
  const { project, frames } = await storage.createProject('Walk cycle');
  const layer = project.layers[0];
  const ref = frames[0].bitmapRefs[layer.id];
  await storage.saveLayerBitmap(project.id, ref, new Blob([bytes(137, 80, 78, 71, 1)], { type: 'image/png' }));
  await storage.saveThumbnail(project.id, new Blob([bytes(137, 80, 78, 71, 2)], { type: 'image/png' }));
  await storage.saveImageBlob(project.id, 'photo-1', new Blob([bytes(255, 216, 3)], { type: 'image/jpeg' }));
  await storage.saveAudioBlob(project.id, 'sound-1', new Blob([bytes(0, 0, 0, 24, 4)], { type: 'audio/mp4' }));
  // A second frame with a blank layer (never drawn on) and the photo.
  const second = { ...storage.createFrame(project.id, project.layers), image: { blobRef: 'photo-1', x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.5 } };
  const full = {
    ...project,
    frames: [...project.frames, second.id],
    fps: 6,
    currentFrameId: second.id,
    audioClips: [{ id: 'clip', kind: 'music', blobRef: 'sound-1', trimStart: 0, trimEnd: 1, offset: 0 }],
  };
  await storage.saveProjectAndFrames(full, [frames[0], second]);
  // Garbage the sweep would delete: not in the file.
  await storage.saveLayerBitmap(project.id, 'orphan', new Blob([bytes(9)], { type: 'image/png' }));
  return storage.loadProject(project.id);
}

async function packSaved(loaded) {
  const blobs = await storage.loadBlobs(PF.projectFileBlobIds(loaded.project, loaded.frames));
  return PF.packProject({ ...loaded, blobs, app: 'test', now: new Date(2026, 9, 31, 12) });
}

test('a packed project lists exactly the blobs it uses, manifest first', async () => {
  const loaded = await makeSaved();
  const file = await packSaved(loaded);
  const zip = await readZip(file);
  assert.equal(zip.names[0], 'project.json');
  const manifest = JSON.parse(dec(await zip.read('project.json')));
  assert.equal(manifest.format, 'parapara-project');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.app, 'test');
  assert.equal(manifest.project.name, 'Walk cycle');
  assert.deepEqual(manifest.frames.map((f) => f.id), loaded.project.frames, 'frames in timeline order');
  const types = manifest.blobs.map((b) => b.type).sort();
  // Layer PNG, thumbnail PNG, photo, sound — no orphan, no blank layer.
  assert.deepEqual(types, ['audio/mp4', 'image/jpeg', 'image/png', 'image/png']);
  assert.ok(!manifest.blobs.some((b) => b.id === 'orphan'));
  assert.equal(zip.names.length, 1 + 4);
  assert.ok(manifest.blobs.some((b) => b.path.endsWith('.jpg')));
  assert.ok(manifest.blobs.some((b) => b.path.endsWith('.m4a')));
});

test('opening a file makes a new project with new ids and every blob, byte for byte', async () => {
  const loaded = await makeSaved();
  const file = await packSaved(loaded);
  const opened = await PF.unpackProject(file, { now: 5000 });
  await storage.saveImportedProject(opened);

  const back = await storage.loadProject(opened.project.id);
  assert.notEqual(back.project.id, loaded.project.id);
  assert.equal(back.project.name, 'Walk cycle', 'same name, as Procreate imports');
  assert.equal(back.project.updatedAt, 5000);
  assert.equal(back.project.createdAt, loaded.project.createdAt);
  assert.equal(back.project.fps, 6);
  assert.equal(back.frames.length, 2);
  assert.deepEqual(back.project.layers, loaded.project.layers, 'layer ids are kept');
  assert.equal(back.project.currentFrameId, back.project.frames[1], 'still on the frame she was on');
  for (const frame of back.frames) {
    assert.equal(frame.projectId, back.project.id);
    assert.ok(!loaded.project.frames.includes(frame.id));
  }

  const layerId = loaded.project.layers[0].id;
  const drawn = await storage.loadLayerBitmap(back.frames[0].bitmapRefs[layerId]);
  assert.deepEqual(new Uint8Array(await drawn.arrayBuffer()), bytes(137, 80, 78, 71, 1));
  assert.equal(drawn.type, 'image/png');
  assert.equal(await storage.loadLayerBitmap(back.frames[1].bitmapRefs[layerId]), null, 'blank stays blank');
  const photo = await storage.loadLayerBitmap(back.frames[1].image.blobRef);
  assert.notEqual(back.frames[1].image.blobRef, 'photo-1');
  assert.equal(photo.type, 'image/jpeg');
  const sound = await storage.loadLayerBitmap(back.project.audioClips[0].blobRef);
  assert.deepEqual(new Uint8Array(await sound.arrayBuffer()), bytes(0, 0, 0, 24, 4));
  assert.equal(sound.type, 'audio/mp4');
  const thumb = await storage.loadThumbnail(back.project.id);
  assert.deepEqual(new Uint8Array(await thumb.arrayBuffer()), bytes(137, 80, 78, 71, 2));

  // The sweep keeps every one of them, and the original is untouched.
  const kept = L.referencedBlobIds(back.project, back.frames);
  assert.equal(await storage.deleteUnreferencedBlobs(back.project.id, kept), 0);
  assert.ok(await storage.loadLayerBitmap('photo-1'));
  assert.equal((await storage.listProjects()).length, 2);
});

test('buildProject with keepIds (restore, 7b) brings the project back as itself', async () => {
  const loaded = await makeSaved();
  const ids = PF.projectFileBlobIds(loaded.project, loaded.frames);
  const stored = await storage.loadBlobs(ids);
  const manifest = {
    project: loaded.project,
    frames: loaded.frames,
    blobs: ids.filter((id) => stored.has(id)).map((id) => ({ id, type: stored.get(id).type, name: `n-${id}` })),
  };
  const read = async (entry) => new Uint8Array(stored.get(entry.id).buffer);
  const built = await PF.buildProject(manifest, read, { keepIds: true, where: 'name', now: 5 });
  assert.deepEqual(built.project, loaded.project, 'ids, name and times unchanged');
  assert.deepEqual(built.frames.map((f) => f.id), loaded.frames.map((f) => f.id));
  assert.deepEqual(built.blobs.map((b) => b.id).sort(), [...stored.keys()].sort());

  // Saved on a fresh device, it loads exactly as it was.
  storage._resetForTests();
  globalThis.indexedDB = new IDBFactory();
  await storage.saveImportedProject(built);
  const back = await storage.loadProject(loaded.project.id);
  assert.deepEqual(back.project, loaded.project);

  // A source that lacks a blob leaves it blank; a bad shape is damaged.
  const partial = await PF.buildProject(manifest, async (e) => (e.type === 'audio/mp4' ? null : read(e)), { keepIds: true, where: 'name' });
  assert.equal(partial.blobs.length, built.blobs.length - 1);
  await assert.rejects(PF.buildProject({ ...manifest, blobs: [{ id: 'x', type: 'image/png' }] }, read, { keepIds: true, where: 'name' }), { code: 'damaged' });
});

test('opening the same file twice makes two projects', async () => {
  const file = await packSaved(await makeSaved());
  const a = await PF.unpackProject(file);
  const b = await PF.unpackProject(file);
  assert.notEqual(a.project.id, b.project.id);
  assert.ok(a.blobs.every((x) => !b.blobs.some((y) => y.id === x.id)));
});

function zipWithManifest(manifest, extra = []) {
  return makeZip([{ name: 'project.json', data: enc(JSON.stringify(manifest)) }, ...extra]);
}

async function manifestOf(file) {
  return JSON.parse(dec(await (await readZip(file)).read('project.json')));
}

test('opening refuses other files: not a zip, a zip without a manifest, another format', async () => {
  const code = (c) => (err) => err instanceof PF.ProjectFileError && err.code === c;
  await assert.rejects(PF.unpackProject(new Blob([enc('hello')])), code('not-project'));
  await assert.rejects(PF.unpackProject(makeZip([{ name: 'x.txt', data: enc('x') }])), code('not-project'));
  await assert.rejects(PF.unpackProject(zipWithManifest({ format: 'something-else' })), code('not-project'));
  await assert.rejects(
    PF.unpackProject(makeZip([{ name: 'project.json', data: enc('{not json') }])), code('damaged'),
  );
});

test('a file from a newer Parapara! says so', async () => {
  const manifest = await manifestOf(await packSaved(await makeSaved()));
  await assert.rejects(
    PF.unpackProject(zipWithManifest({ ...manifest, version: 2 })),
    (err) => err.code === 'newer' && /newer/.test(err.message),
  );
});

test('a manifest without the parts a project needs is damaged, not saved', async () => {
  const manifest = await manifestOf(await packSaved(await makeSaved()));
  const broken = [
    { ...manifest, project: { ...manifest.project, layers: [] } },
    { ...manifest, project: { ...manifest.project, canvas: { width: 0, height: 1080 } } },
    { ...manifest, project: { ...manifest.project, frames: ['missing'] } },
    { ...manifest, frames: [{ id: 'x' }] },
    { ...manifest, blobs: [{ id: 'a' }] },
    { ...manifest, project: null },
  ];
  for (const m of broken) {
    await assert.rejects(PF.unpackProject(zipWithManifest(m)), (err) => err.code === 'damaged');
  }
});

test('a listed blob whose bytes are missing or damaged makes the file damaged', async () => {
  const file = await packSaved(await makeSaved());
  const manifest = await manifestOf(file);
  await assert.rejects(PF.unpackProject(zipWithManifest(manifest)), (err) => err.code === 'damaged');
});

test('a blank or overlong name is tidied on opening', async () => {
  const manifest = await manifestOf(await packSaved(await makeSaved()));
  const zip = await readZip(await packSaved(await storage.loadProject(manifest.project.id)));
  const extra = await Promise.all(manifest.blobs.map(async (b) => ({ name: b.path, data: await zip.read(b.path) })));
  const blank = await PF.unpackProject(zipWithManifest({ ...manifest, project: { ...manifest.project, name: '  ' } }, extra));
  assert.equal(blank.project.name, 'Untitled');
  const long = await PF.unpackProject(zipWithManifest({ ...manifest, project: { ...manifest.project, name: 'a'.repeat(200) } }, extra));
  assert.equal(long.project.name.length, storage.MAX_PROJECT_NAME);
});
