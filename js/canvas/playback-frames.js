// js/canvas/playback-frames.js
//
// Owns: turning a frame into what playback shows (step 4b) — its
// flattened layers (the frame cache's PNG) decoded, plus its reference
// photo unless Hide images is on — and drawing that onto the playback
// canvas: white paper, the photo, then the layers, through
// drawFlattened like the tiles, so playback can't drift from them.
//
// Frames sharing a photo (the usual case: a background on every frame)
// share one decoded copy; it's counted per frame that uses it and
// closed once none does (a couple of unused ones are kept, so a photo
// isn't decoded again every time the decode ring passes it). Photos
// are full size here — playback shows the canvas at full size.
//
// Knows nothing about storage: `readLayers(frameId)` gives the cached
// PNG (or null for blank), `readPhoto(blobRef)` the stored photo.

import { drawFlattened } from './render-frame.js';
import { sanitizePlacement } from './transform.js';

// Decoded photos nothing is using that stay around for a while.
const SPARE_PHOTOS = 2;

export function createPlaybackFrames({ canvasSize, readLayers, readPhoto }) {
  const photos = new Map(); // blobRef -> { loading: Promise<ImageBitmap | null>, users }
  let destroyed = false;

  function closeWhenLoaded(entry) {
    entry.loading.then((image) => image?.close?.());
  }

  function acquire(ref) {
    let entry = photos.get(ref);
    if (!entry) {
      entry = {
        users: 0,
        loading: (async () => {
          try {
            const blob = await readPhoto(ref);
            return blob ? await createImageBitmap(blob) : null;
          } catch (err) {
            console.warn('Parapara! could not load a frame image for playback:', err);
            return null; // skipped, like everywhere else a photo won't load
          }
        })(),
      };
    }
    photos.delete(ref); // most recently used goes last
    photos.set(ref, entry);
    entry.users++;
    return entry.loading;
  }

  function releasePhoto(ref) {
    const entry = photos.get(ref);
    if (!entry) return;
    entry.users--;
    if (entry.users > 0) return;
    // Keep a few unused ones (oldest go first).
    const unused = [...photos].filter(([, e]) => e.users <= 0);
    while (unused.length > SPARE_PHOTOS) {
      const [oldRef, oldEntry] = unused.shift();
      photos.delete(oldRef);
      closeWhenLoaded(oldEntry);
    }
  }

  return {
    // One frame, ready to draw: { layers: ImageBitmap | null, photo:
    // { ref, image, placement } | null }. `hidden`: Hide images is on.
    async decode(frame, { hidden = false } = {}) {
      const blob = readLayers(frame.id);
      const layersLoading = blob ? createImageBitmap(blob) : Promise.resolve(null);
      const ref = hidden ? null : frame.image?.blobRef;
      let photo = null;
      if (ref) {
        const image = await acquire(ref);
        if (image && !destroyed) {
          const placement = sanitizePlacement(frame.image, image.width, image.height, canvasSize.width, canvasSize.height);
          photo = { ref, image, placement };
        } else {
          releasePhoto(ref);
        }
      }
      let layers;
      try {
        layers = await layersLoading;
      } catch (err) {
        if (photo) releasePhoto(ref);
        throw err;
      }
      if (destroyed) {
        layers?.close?.();
        return null;
      }
      return { layers, photo };
    },

    release(value) {
      if (!value) return;
      value.layers?.close?.();
      if (value.photo) releasePhoto(value.photo.ref);
    },

    // Draws a decoded frame (null = blank paper) to fill ctx's canvas.
    draw(ctx, value) {
      drawFlattened(ctx, {
        flattened: value?.layers ?? null,
        canvasSize,
        background: '#ffffff',
        reference: value?.photo ? { image: value.photo.image, placement: value.photo.placement } : null,
      });
    },

    destroy() {
      destroyed = true;
      for (const entry of photos.values()) closeWhenLoaded(entry);
      photos.clear();
    },
  };
}
