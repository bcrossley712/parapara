// js/timeline/frames.js
//
// Owns: pure operations on the project's frame order (project.frames,
// an array of frame ids in timeline order). No DOM, no database —
// main.js applies these and saves through storage.js. Arrays are never
// mutated in place, so an undo entry can keep the "before".
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
