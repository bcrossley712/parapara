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
// the rest; anything no longer a ghost is closed. The coloring
// (tintGhost) is redone each draw: a frame's tint changes as she steps
// past it, and keeping colored copies too would double the memory.
//
// Knows nothing about the project: main.js passes the list (from
// timeline/onion.js ghostFrames plus each frame's cache blob).

import { makeCanvas, freeCanvas } from './render-frame.js';

// How a ghost is colored — one pass per ghost per draw, in tintGhost.
// The ghost becomes its tint but keeps its light and dark (after
// 8b-ii: a one-color tint made a filled frame one blob, its lines lost
// in the fill): each pixel's lightness L, screened with the tint, so
// dark lines become the full tint and light fills a pale one. Then
// fills fade while lines stay (8c — her report: on a colored-in frame
// the lines were still hard to make out over the fill): a pixel keeps
// its alpha while it's dark (L up to FADE_FROM) and loses up to
// GHOST_FILL_FADE of it as it gets lighter (all of that by FADE_TO).
// So a light fill becomes a faint wash and a dark one (black hair,
// navy) stays near a line's strength. GHOST_FILL_FADE is the one to
// tune on the iPad.
//
// Done in JS rather than with blend modes: 'saturation' and 'screen'
// over a see-through pixel mix in the fill's own color, so a faded
// fill would come out darker, not paler.
export const GHOST_FILL_FADE = 0.75;
const FADE_FROM = 0.15;
const FADE_TO = 0.6;

// '#rrggbb' → [r, g, b].
export function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Pure: colors RGBA `data` (unpremultiplied, as getImageData gives it)
// in place as above. `tint` is [r, g, b].
export function tintGhost(data, tint, fade = GHOST_FILL_FADE) {
  const [tr, tg, tb] = tint;
  const span = FADE_TO - FADE_FROM;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    // Lightness as canvas's 'saturation' with gray keeps it (luma).
    const light = (0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2]) / 255;
    // screen(L, T) = 1 - (1 - L)(1 - T) = T + L(255 - T)/255
    data[i] = tr + light * (255 - tr);
    data[i + 1] = tg + light * (255 - tg);
    data[i + 2] = tb + light * (255 - tb);
    const t = Math.min(1, Math.max(0, (light - FADE_FROM) / span));
    data[i + 3] = Math.round(a * (1 - fade * t));
  }
  return data;
}

// getContext(): the onion canvas's 2D context, created if needed.
// hide(): removes the onion canvas and frees it.
// canDraw(): false while drawing now would get in the way.
// log(event, fields): DEV ONLY (activity log) — 'onion-draw' after a
// draw, 'onion-failed' with the step that failed. Remove with the log.
export function createOnionView({ getContext, hide, canDraw = () => true, retryMs = 250, log = () => {} }) {
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
      log('onion-failed', { step: 'decode', ghosts: ghosts.length, error: String(err?.message ?? err) });
      return;
    }
    if (destroyed || gen !== generation) return;
    if (!canDraw()) {
      retry = setTimeout(() => { retry = null; if (gen === generation) draw(); }, retryMs);
      return;
    }
    // iOS can refuse a canvas's context under memory pressure (null).
    // Then nothing is drawn; the next show() tries again.
    const ctx = getContext();
    if (!ctx) {
      log('onion-failed', { step: 'canvas', ghosts: ghosts.length });
      return;
    }
    const { width, height } = ctx.canvas;
    ctx.canvas.style.opacity = String(opacity);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);
    // Coloring needs its own canvas (tintGhost, above); then it's laid
    // on the onion canvas at that ghost's strength.
    const scratch = makeCanvas(width, height);
    const sctx = scratch.getContext('2d');
    if (!sctx) {
      freeCanvas(scratch);
      log('onion-failed', { step: 'scratch', ghosts: ghosts.length });
      return;
    }
    try {
      ghosts.forEach((ghost, i) => {
        sctx.clearRect(0, 0, width, height);
        sctx.drawImage(bitmaps[i], 0, 0, width, height);
        const image = sctx.getImageData(0, 0, width, height);
        tintGhost(image.data, hexToRgb(ghost.tint));
        sctx.putImageData(image, 0, 0);
        ctx.globalAlpha = ghost.alpha;
        ctx.drawImage(scratch, 0, 0);
      });
    } catch (err) {
      log('onion-failed', { step: 'draw', ghosts: ghosts.length, error: String(err?.message ?? err) });
      return;
    } finally {
      ctx.globalAlpha = 1;
      freeCanvas(scratch);
    }
    drawnKey = key;
    log('onion-draw', { ghosts: ghosts.length, size: `${width}x${height}` });
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
