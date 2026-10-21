// js/canvas/frame-tiles.js
//
// Owns: the frame strip's picture thumbnails (step 4a-ii). Each tile is
// what she'd see on that frame — white paper, the frame's reference
// image unless Hide images is on (that's how she sees which frames have
// one; there's no separate marker), then its layers. The layers come
// already flattened at tile size from the frame cache (main.js passes
// them in with setLayers); this file adds the paper and the photo, so
// moving or hiding a photo redraws tiles without re-flattening a frame.
//
// A tile is redrawn only when something it shows changed (its layers,
// its frame's image record, Hide images); a stale tile stays up until
// its replacement is drawn, so nothing flickers blank. Frames sharing a
// photo share one small decoded copy of it.
//
// Knows nothing about storage or the strip's DOM: `read` supplies the
// photo, `onTile(frameId, canvas | null)` hands each tile's canvas out.

import { drawFlattened, makeCanvas, freeCanvas } from './render-frame.js';
import { sanitizePlacement } from './transform.js';

// Small decoded copies of photos kept at once (most animations use one).
const MAX_PHOTOS = 3;

// canvasSize: { width, height } of the project canvas.
// tileSize: { width, height } of a tile in device pixels.
export function createFrameTiles({ canvasSize, tileSize, read, onTile }) {
  const tiles = new Map();  // frameId -> { canvas, layers, layersVersion, drawnKey }
  const photos = new Map(); // blobRef -> Promise<{ image, size } | null>, oldest first
  let frames = new Map();   // frameId -> frame record (last sync)
  let hidden = false;
  let destroyed = false;

  // Photos are copied down to a few times the tile's scale — enough for
  // a photo she's enlarged — instead of keeping each at full size.
  const photoScale = Math.min(1, (4 * tileSize.width) / canvasSize.width);

  function photo(ref) {
    if (photos.has(ref)) {
      const cached = photos.get(ref);
      photos.delete(ref); // most recently used goes last
      photos.set(ref, cached);
      return cached;
    }
    const loading = (async () => {
      try {
        const blob = await read(ref);
        if (!blob) return null;
        const full = await createImageBitmap(blob);
        const size = { width: full.width, height: full.height };
        const image = makeCanvas(full.width * photoScale, full.height * photoScale);
        const ctx = image.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(full, 0, 0, image.width, image.height);
        full.close?.();
        return { image, size };
      } catch (err) {
        console.warn('Parapara! could not load a frame image for its tile:', err);
        return null; // skipped, like everywhere else a photo won't load
      }
    })();
    photos.set(ref, loading);
    while (photos.size > MAX_PHOTOS) {
      const [oldest] = photos.keys();
      const evicted = photos.get(oldest);
      photos.delete(oldest);
      evicted.then((p) => p && freeCanvas(p.image));
    }
    return loading;
  }

  // What the tile shows: its layers, plus the photo and its placement.
  function keyFor(id, tile) {
    const image = hidden ? null : frames.get(id)?.image;
    return `${tile.layersVersion}|${image?.blobRef ? JSON.stringify(image) : ''}`;
  }

  async function draw(id) {
    const tile = tiles.get(id);
    if (!tile?.layers) return;
    const key = keyFor(id, tile);
    if (key === tile.drawnKey || key === tile.wantedKey) return;
    tile.wantedKey = key;
    const record = hidden ? null : frames.get(id)?.image;
    let reference = null;
    if (record?.blobRef) {
      const loaded = await photo(record.blobRef);
      if (loaded) {
        const placement = sanitizePlacement(record, loaded.size.width, loaded.size.height, canvasSize.width, canvasSize.height);
        reference = { image: loaded.image, placement, size: loaded.size };
      }
    }
    // Something newer was asked for while the photo loaded.
    if (destroyed || tiles.get(id) !== tile || tile.wantedKey !== key) return;
    const isNew = !tile.canvas;
    if (isNew) tile.canvas = makeCanvas(tileSize.width, tileSize.height);
    drawFlattened(tile.canvas.getContext('2d'), {
      flattened: tile.layers, canvasSize, background: '#ffffff', reference,
    });
    tile.drawnKey = key;
    tile.wantedKey = null;
    if (isNew) onTile(id, tile.canvas);
  }

  function remove(id) {
    const tile = tiles.get(id);
    if (!tile) return;
    tiles.delete(id);
    onTile(id, null);
    freeCanvas(tile.canvas);
  }

  return {
    // A frame's layers, flattened at tile size (the cache's value). The
    // canvas stays the caller's; it's read whenever the tile is drawn.
    setLayers(frameId, layers) {
      if (destroyed) return;
      let tile = tiles.get(frameId);
      if (!tile) {
        tile = { canvas: null, layers: null, layersVersion: 0, drawnKey: null, wantedKey: null };
        tiles.set(frameId, tile);
      }
      tile.layers = layers;
      tile.layersVersion++;
      draw(frameId);
    },

    // The frame records (for their images) and Hide images, after any
    // change. Tiles whose picture changed are redrawn; tiles of frames
    // no longer in the timeline are dropped.
    sync(frameRecords, { hidden: nextHidden }) {
      if (destroyed) return;
      frames = new Map(frameRecords.map((f) => [f.id, f]));
      hidden = nextHidden;
      for (const id of [...tiles.keys()]) {
        if (!frames.has(id)) remove(id);
        else draw(id);
      }
    },

    destroy() {
      destroyed = true;
      for (const id of [...tiles.keys()]) remove(id);
      for (const loading of photos.values()) loading.then((p) => p && freeCanvas(p.image));
      photos.clear();
    },
  };
}
