// js/canvas/thumbnail.js
//
// Owns: drawing a frame's gallery thumbnail — its visible layers
// composited at their opacity over white paper, as she'd see it on the
// canvas, scaled down to a small PNG. Works from the saved layer
// bitmaps (not the live canvases), so it can draw any project, open or
// not. Knows nothing about storage: the caller passes `read`.
// The frame's reference image (3a) is drawn first, under the layers,
// unless images are hidden — the thumbnail shows what she sees.
// The compositing itself is render-frame.js's (4a-ii), shared with
// the frame strip's tiles and the playback cache.

import { renderFrame, loadReference, makeCanvas, freeCanvas, encodePNG } from './render-frame.js';

// Small enough to keep storage and decoding cheap, big enough to look
// sharp on a gallery card at 2x.
export const THUMBNAIL_WIDTH = 480;

// layers: the project's layer list (index 0 = bottom).
// frame: the frame record to draw (its bitmapRefs and image).
// canvasSize: { width, height } of the project canvas, for the aspect.
// read(ref): Promise<Blob | null> — null means a blank layer (or a
//   missing image, which is skipped).
// referenceHidden: the project's Hide images setting.
// Returns a PNG Blob.
export async function renderThumbnail({ layers, frame, canvasSize, read, referenceHidden = false }) {
  const width = THUMBNAIL_WIDTH;
  const height = Math.max(1, Math.round(width * (canvasSize.height / canvasSize.width)));
  const canvas = makeCanvas(width, height);
  const reference = referenceHidden ? null : await loadReference(frame, read, canvasSize);
  try {
    await renderFrame(canvas.getContext('2d'), {
      layers, frame, canvasSize, read, background: '#ffffff', reference,
    });
    return await encodePNG(canvas);
  } finally {
    reference?.image.close?.();
    freeCanvas(canvas);
  }
}
