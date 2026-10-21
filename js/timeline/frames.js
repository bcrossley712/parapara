// js/timeline/frames.js
//
// Owns: pure operations on the project's frame order (project.frames,
// an array of frame ids in timeline order). No DOM, no database —
// main.js applies these and saves through storage.js. Arrays are never
// mutated in place, so an undo entry can keep the "before".
//
// Also the reference image's frame-wide rules (3b), which read frame
// records (frame.image) but never change them.
//
// Reorder and delete arrive with the full frame strip (step 4).

// Index for a new frame: directly after the current one (Flipaclip
// adds after the frame you're on), or at the end if there isn't one.
export function insertIndexAfter(frameIds, currentId) {
  const i = frameIds.indexOf(currentId);
  return i < 0 ? frameIds.length : i + 1;
}

export function insertFrameId(frameIds, frameId, index) {
  const at = Math.max(0, Math.min(index, frameIds.length));
  return [...frameIds.slice(0, at), frameId, ...frameIds.slice(at)];
}

// Returns { frameIds, index } — where the removed frame was, so it can
// be put back exactly. index is -1 if it wasn't there.
export function removeFrameId(frameIds, frameId) {
  const index = frameIds.indexOf(frameId);
  if (index < 0) return { frameIds, index };
  return { frameIds: [...frameIds.slice(0, index), ...frameIds.slice(index + 1)], index };
}

// Which frame to show after removing the one at `index`: the frame
// before it, or the new first frame.
export function frameAfterRemoval(remaining, index) {
  if (remaining.length === 0) return null;
  return remaining[Math.max(0, Math.min(index - 1, remaining.length - 1))];
}

// --- the reference image across frames (3b) ---

// Use on all frames: what copying `sourceId`'s image to every frame
// would change. Returns null if that frame has no image, else
// { image, before, replacesOther }:
//   image          the source's image record (photo + placement)
//   before         { [frameId]: its image now (null = none) } for every
//                  frame that would change — the undo entry keeps it
//   replacesOther  true if a frame has a *different* photo that would
//                  be replaced (worth a confirm; a blank frame or the
//                  same photo placed differently isn't)
// `same(a, b)`: whether two image records look the same (main.js's
// sameImage), so frames that already match are left out.
export function imageForAllFrames(frames, sourceId, same) {
  const source = frames.find((f) => f.id === sourceId);
  const image = source?.image?.blobRef ? source.image : null;
  if (!image) return null;
  const before = {};
  let replacesOther = false;
  for (const frame of frames) {
    const current = frame.image ?? null;
    if (frame.id === sourceId || same(current, image)) continue;
    before[frame.id] = current;
    if (current?.blobRef && current.blobRef !== image.blobRef) replacesOther = true;
  }
  return { image, before, replacesOther };
}

// The image a new frame added after `current` starts with: a copy of
// `current`'s image (photo + its placement) when every frame shows the
// same photo — it's acting as a background, including the one-frame
// case — else null, so a rotoscope sequence doesn't carry a stale
// photo forward. Placements may differ between frames; the photo is
// what counts.
export function inheritedImage(frames, current) {
  const ref = current?.image?.blobRef;
  if (!ref) return null;
  return frames.every((f) => f.image?.blobRef === ref) ? { ...current.image } : null;
}
