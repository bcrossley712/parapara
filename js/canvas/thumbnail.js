// js/canvas/thumbnail.js
//
// Owns: drawing a frame's gallery thumbnail — its visible layers
// composited at their opacity over white paper, as she'd see it on the
// canvas, scaled down to a small PNG. Works from the saved layer
// bitmaps (not the live canvases), so it can draw any project, open or
// not. Knows nothing about storage: the caller passes `read`.
// The frame's reference image (3a) is drawn first, under the layers,
// unless images are hidden — the thumbnail shows what she sees.

import { drawReference } from './reference.js';
import { sanitizePlacement } from './transform.js';

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
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';

  if (frame.image?.blobRef && !referenceHidden) {
    const blob = await read(frame.image.blobRef);
    if (blob) {
      const image = await createImageBitmap(blob);
      const placement = sanitizePlacement(frame.image, image.width, image.height, canvasSize.width, canvasSize.height);
      drawReference(ctx, image, placement, { unit: width / canvasSize.width });
      image.close?.();
    }
  }

  // One layer decoded at a time, closed straight after drawing, so a
  // full-size bitmap per layer is never held at once.
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const blob = await read(frame.bitmapRefs?.[layer.id]);
    if (!blob) continue;
    const image = await createImageBitmap(blob);
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(image, 0, 0, width, height);
    image.close?.();
  }
  ctx.globalAlpha = 1;

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  // Free the canvas memory now rather than whenever iOS gets to it.
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error('Thumbnail encoding failed');
  return blob;
}
