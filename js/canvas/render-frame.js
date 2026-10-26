// js/canvas/render-frame.js
//
// Owns: the one compositing rule for "a frame, flattened" (step 4a-ii):
// visible layers bottom-up at their opacity, over an optional
// background and the frame's reference image. Everything that shows a
// frame outside the live canvas goes through here — the gallery
// thumbnail (thumbnail.js), the flattened-frame cache and the frame
// strip's tiles, and later onion skin (4c) and export (step 6) — so
// they can't drift apart. (readVisible in canvas.js samples the live
// canvas for fill/eyedropper and follows the same rule.)
//
// The cache holds layers only (transparent, no reference image), so
// Hide images and image edits never invalidate it; drawFlattened adds
// the paper and the photo back when a cached frame is shown.
//
// Knows nothing about storage: callers pass `read` or `layerSource`.

import { drawReference } from './reference.js';
import { sanitizePlacement } from './transform.js';

// Draws a frame into `ctx`, scaled to fill its canvas.
//   layers: the project's layer list (index 0 = bottom).
//   frame: the frame record (its bitmapRefs).
//   canvasSize: { width, height } of the project canvas.
//   Layer pixels come from one of:
//     read(bitmapRef): Promise<Blob | null> — saved bitmaps (null =
//       blank); each is decoded, drawn and closed in turn, so one
//       full-size layer is in memory at a time.
//     layerSource(layerId): a drawable or null — the open frame's live
//       layer canvases. Then nothing awaits, so the whole frame is
//       drawn synchronously, before any stroke can land.
//   background: a CSS color to fill first, or null for transparent.
//   reference: { image, placement, size? } from loadReference, or null.
export async function renderFrame(ctx, { layers, frame, canvasSize, read, layerSource, background = null, reference = null }) {
  const { width, height } = ctx.canvas;
  prepare(ctx);
  drawUnderlay(ctx, { canvasSize, background, reference });
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    let image = null;
    let owned = false;
    if (layerSource) {
      image = layerSource(layer.id);
    } else {
      const blob = await read(frame.bitmapRefs?.[layer.id]);
      if (blob) {
        image = await createImageBitmap(blob);
        owned = true;
      }
    }
    if (!image) continue;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(image, 0, 0, width, height);
    if (owned) image.close?.();
  }
  ctx.globalAlpha = 1;
}

// Draws an already-flattened frame (a cache entry's layers, any size)
// over `background` and `reference`, scaled to fill ctx's canvas.
export function drawFlattened(ctx, { flattened, canvasSize, background = null, reference = null }) {
  prepare(ctx);
  drawUnderlay(ctx, { canvasSize, background, reference });
  if (flattened) ctx.drawImage(flattened, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

// The frame's reference image, decoded and placed, ready for
// renderFrame / drawFlattened: { image, placement }, or null when the
// frame has none, or it's missing or won't decode — an image she
// traces over is skipped, never a failure (PROJECT_NOTES.md). The
// caller closes `image` when done.
export async function loadReference(frame, read, canvasSize) {
  const ref = frame.image?.blobRef;
  if (!ref) return null;
  try {
    const blob = await read(ref);
    if (!blob) return null;
    const image = await createImageBitmap(blob);
    const placement = sanitizePlacement(frame.image, image.width, image.height, canvasSize.width, canvasSize.height);
    return { image, placement };
  } catch (err) {
    console.warn('Parapara! could not draw a frame image:', err);
    return null;
  }
}

function prepare(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

function drawUnderlay(ctx, { canvasSize, background, reference }) {
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  if (reference) {
    // `size`: the photo's full size, when `image` is a smaller copy.
    drawReference(ctx, reference.image, reference.placement, {
      unit: ctx.canvas.width / canvasSize.width,
      size: reference.size,
    });
  }
}

// A canvas of the given size, and freeing one now rather than whenever
// iOS gets to it (iPad Safari counts canvas memory hard).
export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  liveCanvases += 1; // DEV ONLY
  return canvas;
}

export function freeCanvas(canvas) {
  if (!canvas) return;
  if (canvas.width > 0) liveCanvases -= 1; // DEV ONLY
  canvas.width = 0;
  canvas.height = 0;
}

// DEV ONLY (activity log): canvases made here and not yet freed, app-wide
// — whether closing a project leaves any behind. Remove with the log.
let liveCanvases = 0;
export const liveCanvasCount = () => liveCanvases;

export function encodePNG(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}
