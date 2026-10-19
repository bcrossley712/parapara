// js/storage/layers.js
//
// Owns: pure operations on the project's shared layer list and the
// frames' bitmap slots (see PROJECT_NOTES.md "Schema"). No DOM, no
// database — main.js applies these to its in-memory records, then
// saves them through storage.js and shows them through canvas.js.
// Arrays are never mutated in place: each function returns new ones,
// so an undo entry can hold onto the "before" safely.

import { newId, thumbnailBlobId } from './storage.js';

// Most layers a project can have. Each is ~8 MB of canvas memory on
// the iPad (see DESIGN_NOTES "Layers and undo"); the one place to
// change it.
export const MAX_LAYERS = 8;

// "Layer N", one past the highest N already in use (Procreate and
// Sketchbook number new layers the same way). Renamed layers don't
// count.
export function nextLayerName(layers) {
  let highest = 0;
  for (const layer of layers) {
    const match = /^Layer (\d+)$/.exec(layer.name ?? '');
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `Layer ${Math.max(highest, layers.length) + 1}`;
}

// Where a new layer goes: directly above the active one (index 0 is
// the bottom), or on top if there's no active layer.
export function insertIndexAbove(layers, activeLayerId) {
  const i = layers.findIndex((l) => l.id === activeLayerId);
  return i < 0 ? layers.length : i + 1;
}

export function insertLayer(layers, layer, index) {
  const at = Math.max(0, Math.min(index, layers.length));
  return [...layers.slice(0, at), layer, ...layers.slice(at)];
}

// Returns { layers, layer, index } — the removed layer and where it
// was, so it can be put back exactly.
export function removeLayer(layers, layerId) {
  const index = layers.findIndex((l) => l.id === layerId);
  if (index < 0) return { layers, layer: null, index: -1 };
  return {
    layers: [...layers.slice(0, index), ...layers.slice(index + 1)],
    layer: layers[index],
    index,
  };
}

// Which layer to make active after removing the one at `index`: the
// layer that was below it (Procreate does the same), or the new bottom
// layer if it was the bottom one.
export function activeAfterRemoval(remaining, index) {
  if (remaining.length === 0) return null;
  return remaining[Math.max(0, Math.min(index - 1, remaining.length - 1))].id;
}

// Moves a layer to `toIndex` (its index after the move; 0 = bottom).
export function moveLayer(layers, layerId, toIndex) {
  const { layers: rest, layer } = removeLayer(layers, layerId);
  if (!layer) return layers;
  return insertLayer(rest, layer, toIndex);
}

export function updateLayer(layers, layerId, changes) {
  return layers.map((l) => (l.id === layerId ? { ...l, ...changes } : l));
}

// Takes `layerId`'s bitmap slot out of every frame. Returns
// { frames, refs } where refs is { [frameId]: bitmapRef } — kept in
// the undo entry so the slots (and the pixels still stored under them)
// can be put back.
export function detachLayerRefs(frames, layerId) {
  const refs = {};
  const out = frames.map((frame) => {
    if (!(layerId in frame.bitmapRefs)) return frame;
    const { [layerId]: ref, ...rest } = frame.bitmapRefs;
    refs[frame.id] = ref;
    return { ...frame, bitmapRefs: rest };
  });
  return { frames: out, refs };
}

// The reverse: gives every frame a slot for `layerId`, reusing `refs`
// where they exist and making a fresh (blank) one otherwise — e.g. a
// frame added after the layer was removed.
export function attachLayerRefs(frames, layerId, refs = {}) {
  return frames.map((frame) => ({
    ...frame,
    bitmapRefs: { ...frame.bitmapRefs, [layerId]: refs[frame.id] ?? newId() },
  }));
}

// THE list of where a project and its frames point at blobs. Returns
// copies of project and frames with every blob ref replaced by
// fn(ref) (records without refs come back as-is). Both the launch
// sweep (referencedBlobIds) and duplicating a project
// (copyProjectRecords) walk refs through here, so a new kind of blob
// reference — step 3 images, step 5 audio — is added in this one
// place, or the sweep deletes it and a duplicate shares it.
// The thumbnail isn't a field (its id is derived), so it isn't here.
export function mapBlobRefs(project, frames, fn) {
  const outFrames = frames.map((frame) => {
    const bitmapRefs = {};
    for (const [layerId, ref] of Object.entries(frame.bitmapRefs ?? {})) bitmapRefs[layerId] = fn(ref);
    const image = frame.image?.blobRef ? { ...frame.image, blobRef: fn(frame.image.blobRef) } : frame.image;
    return { ...frame, bitmapRefs, image };
  });
  const outProject = {
    ...project,
    audioClips: (project.audioClips ?? []).map((clip) => (
      clip.blobRef ? { ...clip, blobRef: fn(clip.blobRef) } : clip
    )),
  };
  return { project: outProject, frames: outFrames };
}

// Every blob id the project still uses. Anything else in the blob
// store for this project is garbage (e.g. a deleted layer's pixels
// once its undo entry is gone). Includes the gallery thumbnail (2d).
// Anything not listed is deleted at the next launch — see mapBlobRefs.
export function referencedBlobIds(project, frames) {
  const ids = new Set([thumbnailBlobId(project.id)]);
  mapBlobRefs(project, frames, (ref) => {
    ids.add(ref);
    return ref;
  });
  return ids;
}

// Copy frame: the whole frame record with a new id and a new bitmapRef
// per layer (the pixels get copied to those). Every other field comes
// along as-is — step 3's frame.image keeps pointing at the same
// stored image, which is stored once and shared, as in Flipaclip's
// duplicate frame. Returns { frame, pairs } with pairs = [[fromRef,
// toRef], ...] for the pixel copy.
export function copyFrameRecord(frame) {
  const pairs = [];
  const bitmapRefs = {};
  for (const [layerId, ref] of Object.entries(frame.bitmapRefs ?? {})) {
    bitmapRefs[layerId] = newId();
    pairs.push([ref, bitmapRefs[layerId]]);
  }
  return { frame: { ...frame, id: newId(), bitmapRefs }, pairs };
}

// Copy layer: a new layer just like `layer` (opacity, visibility),
// named "<name> copy" and unlocked — a locked copy is rarely wanted.
// Returns { layer, refs, pairs }: refs = { [frameId]: newRef } for the
// copy's slot on every frame, pairs = [[fromRef, toRef], ...] for the
// pixel copy (frames without a slot for `layer` get a blank one).
export function copyLayerRecord(layer, frames) {
  const copy = { ...layer, id: newId(), name: `${layer.name} copy`, locked: false };
  const refs = {};
  const pairs = [];
  for (const frame of frames) {
    refs[frame.id] = newId();
    const from = frame.bitmapRefs?.[layer.id];
    if (from) pairs.push([from, refs[frame.id]]);
  }
  return { layer: copy, refs, pairs };
}

// Duplicate project: new ids for the project, every frame and every
// blob it references (thumbnail included, at thumb-<newId>), with
// every reference remapped. Layer ids stay — they're only keys within
// a project. Frame ids in project.frames that have no record are
// dropped. Returns { project, frames, pairs } with pairs = [[fromBlob,
// toBlob], ...] to copy.
export function copyProjectRecords(project, frames, { name, now = Date.now() } = {}) {
  const id = newId();
  const frameIds = new Map(frames.map((f) => [f.id, newId()]));
  const blobIds = new Map();
  for (const ref of referencedBlobIds(project, frames)) {
    blobIds.set(ref, ref === thumbnailBlobId(project.id) ? thumbnailBlobId(id) : newId());
  }
  const mapped = mapBlobRefs(project, frames, (ref) => blobIds.get(ref));
  const order = project.frames.filter((fid) => frameIds.has(fid)).map((fid) => frameIds.get(fid));
  const outProject = {
    ...mapped.project,
    id,
    name: name ?? project.name,
    createdAt: now,
    updatedAt: now,
    frames: order,
    currentFrameId: frameIds.get(project.currentFrameId) ?? order[0],
  };
  const outFrames = mapped.frames.map((f) => ({ ...f, id: frameIds.get(f.id), projectId: id }));
  return { project: outProject, frames: outFrames, pairs: [...blobIds] };
}
