// js/storage/project-file.js
//
// Owns: a whole project as one file (step 7a) — packing a project
// (record, frames, and every blob it uses: layer PNGs, photos, the
// sound file, the thumbnail) into a `.parapara` file, and unpacking
// one into a new project. The gallery's Save as file / Import use it
// now; step 7b's backup reuses the same manifest (project + frames +
// blob list) but uploads the pieces one by one, so only what changed
// goes up.
//
// The file is a plain zip with every entry stored (zip.js):
//   project.json   — the manifest: { format, version, savedAt, app,
//                    project, frames, blobs: [{ id, type, path }] }
//   blobs/<n>.<ext> — each blob's bytes, exactly as stored
// A zip so the file is ordinary and inspectable; `.parapara` so it
// reads as hers. Pure: no IndexedDB, no DOM — main.js loads and saves
// (storage.js), this only converts. Unit-tested in Node.
//
// Opening a file never overwrites anything: every id is new
// (copyProjectRecords, the same remapping Duplicate uses), so opening
// the same file twice makes two projects, like Procreate's import.
// Restore (7b push 2) shares buildProject with keepIds instead: the
// backup's project comes back as itself.

import { makeZip, readZip, ZipError } from './zip.js';
import { copyProjectRecords, referencedBlobIds } from './layers.js';
import { MAX_PROJECT_NAME } from './storage.js';

export const PROJECT_FILE_FORMAT = 'parapara-project';
// Bump when an older Parapara! couldn't read what's written; schema
// fields added additively don't need it (opening sanitizes them).
export const PROJECT_FILE_VERSION = 1;
export const PROJECT_FILE_EXTENSION = 'parapara';
export const PROJECT_FILE_TYPE = 'application/zip';
const MANIFEST = 'project.json';
const MAX_CANVAS_SIDE = 8192;
const FALLBACK_NAME = 'Untitled';

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aiff': 'aif',
  'audio/x-aiff': 'aif',
  'audio/x-caf': 'caf',
};

// code: 'not-project' (not a Parapara! file at all), 'newer' (made by
// a newer Parapara!), 'damaged' (ours, but broken or cut short).
export class ProjectFileError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProjectFileError';
    this.code = code;
  }
}

// The blob ids a project file carries: everything the project uses,
// thumbnail included. main.js loads these from storage for packProject.
export function projectFileBlobIds(project, frames) {
  return [...referencedBlobIds(project, frames)];
}

// blobs: Map id -> { type, buffer: ArrayBuffer | Uint8Array }; ids the
// project uses but the map lacks are blank layers (never saved) or a
// missing thumbnail, and are simply left out. Frames are written in
// timeline order. Returns a Blob of the file.
export function packProject({ project, frames, blobs, app = '', now = new Date() }) {
  const entries = [];
  const list = [];
  let n = 0;
  for (const id of projectFileBlobIds(project, frames)) {
    const blob = blobs.get(id);
    if (!blob) continue;
    const ext = EXTENSIONS[blob.type] ?? 'bin';
    const path = `blobs/${++n}.${ext}`;
    list.push({ id, type: blob.type, path });
    const data = blob.buffer instanceof Uint8Array ? blob.buffer : new Uint8Array(blob.buffer);
    entries.push({ name: path, data });
  }
  const byId = new Map(frames.map((f) => [f.id, f]));
  const ordered = project.frames.map((id) => byId.get(id)).filter(Boolean);
  const manifest = {
    format: PROJECT_FILE_FORMAT,
    version: PROJECT_FILE_VERSION,
    savedAt: now.getTime(),
    app,
    project,
    frames: ordered,
    blobs: list,
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  // The manifest first, so a person unzipping it sees it at the top.
  return makeZip([{ name: MANIFEST, data: json }, ...entries], { type: PROJECT_FILE_TYPE, now });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length > 0;
const isSide = (v) => Number.isInteger(v) && v > 0 && v <= MAX_CANVAS_SIDE;

// Throws ProjectFileError('damaged') unless the manifest's project and
// frames are shaped enough to be saved and opened. Field values the
// editor already sanitizes on open (fps, onion skin, palette, sound
// clips…) are left to it. `where` is the blob entries' locator field:
// 'path' in a project file, 'name' in a backup manifest (7b).
function checkShape(manifest, where = 'path') {
  const { project, frames, blobs } = manifest;
  const bad = (what) => new ProjectFileError('damaged', `This file is damaged (${what}).`);
  if (!isObject(project) || !Array.isArray(frames) || !Array.isArray(blobs)) throw bad('parts missing');
  if (!isObject(project.canvas) || !isSide(project.canvas.width) || !isSide(project.canvas.height)) {
    throw bad('canvas size');
  }
  if (!Array.isArray(project.layers) || project.layers.length === 0
    || !project.layers.every((l) => isObject(l) && isId(l.id))) throw bad('layers');
  if (!Array.isArray(project.frames) || !project.frames.every(isId)) throw bad('frame list');
  for (const frame of frames) {
    if (!isObject(frame) || !isId(frame.id) || !isObject(frame.bitmapRefs)
      || !Object.values(frame.bitmapRefs).every(isId)) throw bad('frames');
    if (frame.image != null && !(isObject(frame.image) && isId(frame.image.blobRef))) throw bad('frames');
  }
  if (project.audioClips != null && !Array.isArray(project.audioClips)) throw bad('sound');
  for (const b of blobs) {
    if (!isObject(b) || !isId(b.id) || typeof b.type !== 'string' || !isId(b[where])) throw bad('file list');
  }
  const known = new Set(frames.map((f) => f.id));
  if (!project.frames.some((id) => known.has(id))) throw bad('no frames');
}

function cleanName(name) {
  const text = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  return (text || FALLBACK_NAME).slice(0, MAX_PROJECT_NAME);
}

// Opens a project file (a File or Blob). Returns { project, frames,
// blobs: [{ id, type, buffer: ArrayBuffer }] } with every id new and
// ready to save in one go (storage.saveImportedProject). Same name as
// the file's project; createdAt kept, updatedAt now (so it's first in
// the gallery). Throws ProjectFileError.
export async function unpackProject(file, { now = Date.now() } = {}) {
  let zip;
  try {
    zip = await readZip(file);
  } catch (err) {
    if (err instanceof ZipError) throw new ProjectFileError('not-project', "This isn't a Parapara! file.", { cause: err });
    throw err;
  }
  if (!zip.has(MANIFEST)) throw new ProjectFileError('not-project', "This isn't a Parapara! file.");

  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await zip.read(MANIFEST)));
  } catch (err) {
    throw new ProjectFileError('damaged', 'This file is damaged.', { cause: err });
  }
  if (!isObject(manifest) || manifest.format !== PROJECT_FILE_FORMAT) {
    throw new ProjectFileError('not-project', "This isn't a Parapara! file.");
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    throw new ProjectFileError('damaged', 'This file is damaged (version).');
  }
  if (manifest.version > PROJECT_FILE_VERSION) {
    throw new ProjectFileError('newer', 'This file was made by a newer Parapara!. Update the app, then try again.');
  }
  return buildProject(manifest, async (entry) => {
    try {
      return await zip.read(entry.path);
    } catch (err) {
      if (err instanceof ZipError) throw new ProjectFileError('damaged', 'This file is damaged.', { cause: err });
      throw err;
    }
  }, { now });
}

// Shared by Import (7a) and restore (7b push 2): a checked manifest
// ({ project, frames, blobs: [{ id, type, … }] }) plus `readBlob(entry)`
// (bytes, or null when the source lacks it) → { project, frames, blobs }
// ready for storage.saveImportedProject.
//   keepIds false (Import): every id new, name cleaned, updatedAt now.
//   keepIds true (restore): ids, name and times exactly as saved, so
//   the backup sees the same project and nothing is uploaded again.
// Only blobs the project uses come along; a listed blob it doesn't use
// is skipped, a used one the source lacks stays blank (like a layer
// never drawn on). Throws ProjectFileError('damaged') on a bad shape.
export async function buildProject(manifest, readBlob, { now = Date.now(), keepIds = false, where = 'path' } = {}) {
  checkShape(manifest, where);
  let copy;
  if (keepIds) {
    if (!isId(manifest.project.id)) throw new ProjectFileError('damaged', 'This file is damaged (project id).');
    const project = { ...manifest.project, name: cleanName(manifest.project.name) };
    const known = new Set(project.frames);
    const frames = manifest.frames.filter((f) => known.has(f.id)).map((f) => ({ ...f, projectId: project.id }));
    const present = new Set(frames.map((f) => f.id));
    if (!project.frames.every((id) => present.has(id))) {
      project.frames = project.frames.filter((id) => present.has(id));
      if (!present.has(project.currentFrameId)) project.currentFrameId = project.frames[0];
    }
    const pairs = [...referencedBlobIds(project, frames)].map((id) => [id, id]);
    copy = { project, frames, pairs };
  } else {
    const source = { ...manifest.project, name: cleanName(manifest.project.name) };
    copy = copyProjectRecords(source, manifest.frames, { now });
    copy.project.createdAt = Number.isFinite(source.createdAt) ? source.createdAt : now;
  }

  const listed = new Map(manifest.blobs.map((b) => [b.id, b]));
  const blobs = [];
  for (const [from, to] of copy.pairs) {
    const entry = listed.get(from);
    if (!entry) continue;
    const data = await readBlob(entry);
    if (!data) continue;
    const buffer = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.slice().buffer;
    blobs.push({ id: to, type: entry.type || 'application/octet-stream', buffer });
  }
  return { project: copy.project, frames: copy.frames, blobs };
}
