// js/canvas/onion-view.js
//
// Onion skin (step 4c): draws the ghosts — neighboring frames, tinted
// and faded — onto one full-size canvas that sits over the reference
// image and under every layer (canvas.js getOnionContext). Each ghost
// comes from the frame cache's flattened PNG (layers only, no photo,
// so ghosts never include a frame's photo).
//
// The ghost layer's overall opacity is CSS on that canvas, so the
// slider never redraws pixels. Redraws happen only when the ghosts
// themselves change (another frame, a ghost frame's cache entry
// replaced, a count or tint change). A draw waits while canDraw() is
// false (she's mid-stroke), so ghosts never land in the middle of one.
//
// Ghost frames' decoded pictures are kept while they're ghosts — up to
// six full-size bitmaps — so a tint or count change doesn't re-decode
// the rest; anything no longer a ghost is closed.
//
// Knows nothing about the project: main.js passes the list (from
// timeline/onion.js ghostFrames plus each frame's cache blob).

import { makeCanvas, freeCanvas } from './render-frame.js';

// getContext(): the onion canvas's 2D context, created if needed.
// hide(): removes the onion canvas and frees it.
// canDraw(): false while drawing now would get in the way.
export function createOnionView({ getContext, hide, canDraw = () => true, retryMs = 250 }) {
  const decoded = new Map(); // frameId -> { blob, bitmap }
  const blobKeys = new WeakMap();
  let nextBlobKey = 1;
  let wanted = null;   // the latest list asked for
  let drawnKey = null; // the list on screen now (null = hidden)
  let opacity = 0.4;
  let generation = 0;
  let retry = null;
  let destroyed = false;

  const blobKey = (blob) => {
    if (!blobKeys.has(blob)) blobKeys.set(blob, nextBlobKey++);
    return blobKeys.get(blob);
  };
  const keyOf = (ghosts) => ghosts
    .map((g) => `${g.id}:${blobKey(g.blob)}:${g.tint}:${g.alpha}`)
    .join('|');

  function clearRetry() {
    if (retry !== null) clearTimeout(retry);
    retry = null;
  }

  function releaseExcept(ids) {
    for (const [id, entry] of decoded) {
      if (ids.has(id)) continue;
      entry.bitmap.close?.();
      decoded.delete(id);
    }
  }

  // The ghost's decoded picture, or null if a newer draw started
  // while decoding (this one is dropped; only the newest draw stores).
  async function bitmapFor(ghost, gen) {
    const have = decoded.get(ghost.id);
    if (have && have.blob === ghost.blob) return have.bitmap;
    const bitmap = await createImageBitmap(ghost.blob);
    if (destroyed || gen !== generation) {
      bitmap.close?.();
      return null;
    }
    decoded.get(ghost.id)?.bitmap.close?.();
    decoded.set(ghost.id, { blob: ghost.blob, bitmap });
    return bitmap;
  }

  async function draw() {
    clearRetry();
    const gen = ++generation;
    const ghosts = wanted;
    if (!ghosts || ghosts.length === 0) {
      releaseExcept(new Set());
      if (drawnKey !== null) hide();
      drawnKey = null;
      return;
    }
    const key = keyOf(ghosts);
    if (key === drawnKey) return;
    let bitmaps;
    try {
      bitmaps = [];
      for (const ghost of ghosts) {
        const bitmap = await bitmapFor(ghost, gen);
        if (!bitmap) return; // asked for something else meanwhile
        bitmaps.push(bitmap);
      }
    } catch (err) {
      console.warn('Parapara! could not draw the onion skin:', err);
      return;
    }
    if (destroyed || gen !== generation) return;
    if (!canDraw()) {
      retry = setTimeout(() => { retry = null; if (gen === generation) draw(); }, retryMs);
      return;
    }
    const ctx = getContext();
    const { width, height } = ctx.canvas;
    ctx.canvas.style.opacity = String(opacity);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);
    // Tinting needs its own canvas: the ghost's lines turned to one
    // color (source-in keeps their shape and softness), then laid on
    // the onion canvas at that ghost's strength.
    const scratch = makeCanvas(width, height);
    const sctx = scratch.getContext('2d');
    try {
      ghosts.forEach((ghost, i) => {
        sctx.globalCompositeOperation = 'source-over';
        sctx.clearRect(0, 0, width, height);
        sctx.drawImage(bitmaps[i], 0, 0, width, height);
        sctx.globalCompositeOperation = 'source-in';
        sctx.fillStyle = ghost.tint;
        sctx.fillRect(0, 0, width, height);
        ctx.globalAlpha = ghost.alpha;
        ctx.drawImage(scratch, 0, 0);
      });
    } finally {
      ctx.globalAlpha = 1;
      freeCanvas(scratch);
    }
    drawnKey = key;
    releaseExcept(new Set(ghosts.map((g) => g.id)));
  }

  return {
    // The ghosts to show: [{ id, blob, tint, alpha }], farthest first
    // (ghosts without a picture yet are left out by the caller), or
    // null / [] for none. Cheap when nothing changed.
    show(ghosts) {
      if (destroyed) return;
      wanted = ghosts && ghosts.length > 0 ? ghosts : null;
      // Already on screen: just drop any draw still on its way.
      if (wanted ? keyOf(wanted) === drawnKey : drawnKey === null && decoded.size === 0) {
        generation++;
        clearRetry();
        return;
      }
      draw();
    },

    // The whole ghost layer's opacity (0–1); CSS only, no redraw.
    setOpacity(value) {
      opacity = value;
      if (drawnKey !== null) getContext().canvas.style.opacity = String(value);
    },

    destroy() {
      destroyed = true;
      generation++;
      clearRetry();
      releaseExcept(new Set());
      wanted = null;
      drawnKey = null;
    },
  };
}
