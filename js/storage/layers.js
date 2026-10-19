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

// Every blob id the project still uses. Anything else in the blob
// store for this project is garbage (e.g. a deleted layer's pixels
// once its undo entry is gone). Includes the gallery thumbnail (2d).
// Images (step 3) and audio (step 5) add their refs here when they
// land — anything not listed is deleted at the next launch.
export function referencedBlobIds(project, frames) {
  const ids = new Set([thumbnailBlobId(project.id)]);
  for (const frame of frames) {
    for (const ref of Object.values(frame.bitmapRefs ?? {})) ids.add(ref);
    if (frame.image?.blobRef) ids.add(frame.image.blobRef);
  }
  for (const clip of project.audioClips ?? []) {
    if (clip.blobRef) ids.add(clip.blobRef);
  }
  return ids;
}
