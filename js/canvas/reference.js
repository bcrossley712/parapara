// js/canvas/reference.js
//
// Owns: the reference image (step 3a) — a photo she traces over,
// drawn under every layer and never drawn on. Three parts:
//   - createReferenceView: the on-screen element inside the canvas
//     wrapper, placed with a CSS transform (moving it never redraws
//     pixels), plus drawing it into a 2D context for readVisible.
//   - drawReference: draws an image at a placement into any context —
//     shared by readVisible (canvas.js) and the gallery thumbnail.
//   - prepareImport: turns a picked file into the stored image
//     (downscaled, re-encoded) and its starting placement.
// Placement math lives in transform.js. Knows nothing about storage
// or the schema beyond { x, y, scale, rotation, opacity, flipX, flipY }.

import { placementMatrix, fitPlacement } from './transform.js';

// Imports are downscaled so the long side is at most this many times
// the canvas's long side. Her iPad runs near full, so storage and
// decoded memory win over sharpness when she enlarges a photo past
// the canvas size (see docs/DESIGN_NOTES.md, step 3 decisions).
export const MAX_IMPORT_FACTOR = 1;

// Everything is saved as JPEG at this quality unless it really has
// transparency (a character on no background), which stays PNG.
// Measured on a screenshot: a third of PNG's size at 0.8; 0.7 saves a
// little more, with edges only slightly softer at 3× zoom.
export const JPEG_QUALITY = 0.7;

// True if any pixel isn't fully opaque. Checked on the downscaled
// pixels, whatever the file type said — most PNGs (screenshots) have
// an alpha channel but use none of it.
function hasTransparency(ctx, width, height) {
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

// Draws `image` (anything drawImage takes, with width/height) at
// `placement` and its opacity, on top of what's in `ctx`.
// `unit`/`originX`/`originY`: see placementMatrix.
export function drawReference(ctx, image, placement, options = {}) {
  ctx.save();
  ctx.globalAlpha = placement.opacity;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(...placementMatrix(placement, image.width, image.height, options));
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

// The on-screen reference inside the canvas wrapper (`stack`). A
// holder sized in canvas pixels and scaled to the wrapper's CSS size
// (setDisplayWidth) lets the image's own transform be written in
// canvas pixels, the same units as the placement. The holder clips, so
// the image only shows on the page.
export function createReferenceView(stack, canvasW, canvasH) {
  const holder = document.createElement('div');
  holder.className = 'pp-reference';
  holder.style.width = `${canvasW}px`;
  holder.style.height = `${canvasH}px`;
  holder.style.transformOrigin = '0 0';
  stack.prepend(holder);

  // The image itself, copied into a canvas so callers can close their
  // ImageBitmap straight away.
  let surface = null;
  let key = null;       // which stored image is showing (its blobRef)
  let placement = null;
  let hidden = false;

  function applyStyle() {
    if (!surface) return;
    surface.style.visibility = hidden ? 'hidden' : '';
    if (!placement) return;
    surface.style.opacity = String(placement.opacity);
    const [a, b, c, d, e, f] = placementMatrix(placement, surface.width, surface.height);
    surface.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`;
  }

  function release() {
    if (!surface) return;
    surface.remove();
    // Free the backing store now, not at GC (iPad canvas memory).
    surface.width = 0;
    surface.height = 0;
    surface = null;
  }

  return {
    // The wrapper's CSS width changed (canvas.js fitStack).
    setDisplayWidth(cssWidth) {
      holder.style.transform = `scale(${cssWidth / canvasW})`;
    },

    // Shows `image` (decoded; null = none) keyed by `newKey`, at
    // `newPlacement`. Same key as now: the pixels are kept and only
    // the placement changes — frames sharing an image don't re-copy it.
    set(newKey, image, newPlacement) {
      if (!newKey || (!image && newKey !== key)) {
        release();
        key = null;
        placement = null;
        return;
      }
      if (newKey !== key) {
        release();
        surface = document.createElement('canvas');
        surface.className = 'pp-reference__image';
        surface.width = image.width;
        surface.height = image.height;
        surface.getContext('2d').drawImage(image, 0, 0);
        holder.appendChild(surface);
        key = newKey;
      }
      placement = { ...newPlacement };
      applyStyle();
    },

    setPlacement(next) {
      if (!surface) return;
      placement = { ...next };
      applyStyle();
    },

    setHidden(next) {
      hidden = next === true;
      applyStyle();
    },

    key: () => key,
    placement: () => (placement ? { ...placement } : null),
    size: () => (surface ? { width: surface.width, height: surface.height } : null),
    // True when it's on screen — what readVisible should include.
    isShowing: () => surface !== null && !hidden && placement !== null && placement.opacity > 0,

    // Draws it into `ctx` as she sees it, for the canvas region
    // starting at (originX, originY) canvas px.
    drawInto(ctx, originX = 0, originY = 0) {
      if (!surface || !placement) return;
      drawReference(ctx, surface, placement, { originX, originY });
    },

    destroy() {
      release();
      holder.remove();
    },
  };
}

// A picked file → { blob, width, height, placement }: decoded (EXIF
// orientation applied by the browser), downscaled to the import cap,
// re-encoded (JPEG, or PNG if transparent) — so every stored image is
// upright, bounded and small, whatever came in. Throws if the file isn't an image the browser can decode.
export async function prepareImport(file, canvasW, canvasH) {
  const bitmap = await createImageBitmap(file);
  try {
    const maxSide = MAX_IMPORT_FACTOR * Math.max(canvasW, canvasH);
    const factor = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * factor));
    const height = Math.max(1, Math.round(bitmap.height * factor));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const png = hasTransparency(ctx, width, height);
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, png ? 'image/png' : 'image/jpeg', png ? undefined : JPEG_QUALITY);
    });
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error('Image encoding failed');
    return { blob, width, height, placement: fitPlacement(width, height, canvasW, canvasH) };
  } finally {
    bitmap.close?.();
  }
}
