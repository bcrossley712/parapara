// Parapara! — app entry point
//
// Glue between modules, and screen routing: the gallery (ui/gallery.js)
// or one project open in the editor (ui/ui.js + canvas/), never both.
// Loads projects from storage/, hands them to the canvas, wires
// autosave, undo, the layers panel and frame strip, and connects the
// updater (updater.js) to the update toast and the gear menu. Modules
// don't import each other's internals; this file moves data between
// them (see PROJECT_NOTES.md, scope-specific file structure).
//
// Launch reopens wherever she left off: the gallery, or the editor on
// the last project (uiState.screen + lastProjectId), as Procreate and
// Sketchbook do.

import { initUI, showUpdatePrompt, showNotice, showBanner } from './ui/ui.js';
import { createGallery } from './ui/gallery.js';
import { showConfirm } from './ui/confirm-dialog.js';
// Developer only (step 4a-i), removed with the gear menu's Developer section.
import { runPlaybackSpeedTest, runFrameMemoryTest, reportInterruptedMemoryTest } from './timeline/dev-stress.js';
import {
  initStorage,
  loadLastProject,
  loadProject,
  saveLastProjectId,
  createProject,
  listProjects,
  renameProject,
  deleteProject,
  nextProjectName,
  copyName,
  MAX_PROJECT_NAME,
  saveThumbnail,
  loadThumbnail,
  loadLayerBitmap,
  saveLayerBitmap,
  loadToolSettings,
  saveToolSettings,
  loadUiState,
  saveUiState,
  loadRecentColors,
  saveRecentColors,
  saveFrame,
  saveProject,
  copyBlobs,
  saveProjectCopy,
  saveProjectAndFrames,
  deleteUnreferencedBlobs,
  createLayer,
  createFrame,
  createProjectRecord,
  ensureBitmapRefs,
  saveImageBlob,
  newId,
} from './storage/storage.js';
import {
  MAX_LAYERS,
  nextLayerName,
  insertIndexAbove,
  insertLayer,
  removeLayer,
  activeAfterRemoval,
  moveLayer,
  updateLayer,
  detachLayerRefs,
  attachLayerRefs,
  referencedBlobIds,
  copyFrameRecord,
  copyLayerRecord,
  copyProjectRecords,
} from './storage/layers.js';
import {
  insertIndexAfter,
  insertFrameId,
  removeFrameId,
  frameAfterRemoval,
  imageForAllFrames,
  inheritedImage,
} from './timeline/frames.js';
import {
  MAX_RECENTS,
  MAX_PALETTE,
  sanitizeColorList,
  addRecent,
  addToPalette,
  replaceInPalette,
  removeFromPalette,
} from './storage/colors.js';
import { createAutosaver } from './storage/autosave.js';
import { createHistory } from './storage/history.js';
import { renderThumbnail } from './canvas/thumbnail.js';
import { renderFrame, makeCanvas, freeCanvas, encodePNG } from './canvas/render-frame.js';
import { createFrameTiles } from './canvas/frame-tiles.js';
import { createFrameCache, layerSignature } from './timeline/frame-cache.js';
import { prepareImport } from './canvas/reference.js';
import { sanitizePlacement, samePlacement, flipPlacement } from './canvas/transform.js';
import { initUpdater, formatVersion } from './updater.js';

// Colors for the developer "Fill all layers" memory test.
const DEV_FILL_COLORS = ['#e05a47', '#f2a65a', '#e8d15a', '#7cc46b', '#4fb3c9', '#5a7be0', '#a065d6', '#d65aa8'];

const appRoot = document.getElementById('app');

// --- app-wide state (survives switching screens) ---

// Tool, color and brush sizes — app-wide, not per project, so they
// follow her from one animation into the next (see storage.js).
let toolSettings = null;
// { layersPanelOpen, screen: 'gallery' | 'editor' } — remembered
// across launches.
let uiState = {};
// The last colors she drew or filled with, newest first — app-wide
// (colors.js), shown in every project's color picker.
let recentColors = [];
// False if the database can't be opened at all; then there's no
// gallery, just an unsaved editor.
let storageWorks = false;

// The open editor's save-everything-now function, or null on the
// gallery. Runs before any reload the app causes itself (applying an
// update, Fresh reload) and when the app is hidden.
let flushEditor = null;

// Same save-timing rules as the drawing (autosave.js). Failures are
// only logged: losing a color choice or a panel state isn't worth
// interrupting her.
const settingsSaver = createAutosaver({
  save: () => saveToolSettings(toolSettings),
  delayMs: 300,
  onError: (err) => console.warn('Parapara! saving tool settings failed:', err),
});
const recentsSaver = createAutosaver({
  save: () => saveRecentColors([...recentColors]),
  delayMs: 300,
  onError: (err) => console.warn('Parapara! saving recent colors failed:', err),
});
const uiStateSaver = createAutosaver({
  save: () => saveUiState({ ...uiState }),
  delayMs: 300,
  onError: (err) => console.warn('Parapara! saving UI state failed:', err),
});

// `now`: save right away instead of debouncing — for switching
// screens, which is rare and should survive the app being closed
// straight after.
function setUiState(changes, { now = false } = {}) {
  Object.assign(uiState, changes);
  if (!storageWorks) return;
  uiStateSaver.schedule();
  if (now) uiStateSaver.flush();
}

function flushAll() {
  const savers = storageWorks ? [settingsSaver.flush(), uiStateSaver.flush(), recentsSaver.flush()] : [];
  return Promise.all([flushEditor?.(), ...savers]);
}

const updater = initUpdater({
  onUpdateReady: () => showUpdatePrompt(() => updater.applyUpdate()),
  beforeReload: () => flushAll(),
});

// Gear-menu actions shared by both screens.
const appActions = {
  getVersionLabel: async () => formatVersion(await updater.getVersion()),
  checkForUpdate: () => updater.checkForUpdate(),
  applyUpdate: () => updater.applyUpdate(),
  freshReload: () => updater.freshReload(),
};

// iPadOS can close a backgrounded web app without warning, so save
// the moment it's hidden rather than waiting out the debounce.
// visibilitychange is the reliable signal on iOS; pagehide is a
// backup for an actual unload.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAll();
});
window.addEventListener('pagehide', () => flushAll());

launch();
reportInterruptedMemoryTest(); // developer only, step 4a-i

async function launch() {
  try {
    await initStorage();
    storageWorks = true;
  } catch (err) {
    // No database at all: she can still draw (on an in-memory project)
    // but nothing is written.
    console.error('Parapara! could not open storage:', err);
    const project = createProjectRecord();
    const frame = createFrame(project.id, project.layers);
    project.frames = [frame.id];
    project.currentFrameId = frame.id;
    mountEditor({ project, frames: [frame], frame, images: new Map() }, { canSave: false });
    return;
  }

  // Niceties, not her work: if they fail to load, use defaults.
  try {
    toolSettings = await loadToolSettings();
  } catch (err) {
    console.warn('Parapara! could not load tool settings:', err);
  }
  try {
    recentColors = sanitizeColorList(await loadRecentColors(), MAX_RECENTS);
  } catch (err) {
    console.warn('Parapara! could not load recent colors:', err);
  }
  try {
    const saved = await loadUiState();
    uiState = {
      layersPanelOpen: saved?.layersPanelOpen === true,
      // Installs from before the gallery have no screen saved; they
      // were always in the editor.
      screen: saved?.screen === 'gallery' ? 'gallery' : 'editor',
    };
  } catch (err) {
    console.warn('Parapara! could not load UI state:', err);
    uiState = { layersPanelOpen: false, screen: 'editor' };
  }

  if (uiState.screen === 'editor') {
    try {
      const loaded = await loadLastProject();
      if (loaded) {
        mountEditor(await prepareSession(loaded), { canSave: true });
        return;
      }
    } catch (err) {
      console.error('Parapara! could not open the last project:', err);
      showNotice("Your last animation couldn't be opened.");
    }
  }
  showGallery();
}

// Everything the editor needs, loaded — including decoding every
// layer's saved image of the open frame — *before* the canvas exists,
// so there's no moment where she could draw and then have a
// late-arriving load wipe the stroke. Throws if anything fails; the
// caller stays where it was (saving a blank canvas over a drawing
// that merely failed to load would destroy it).
//
// Returns { project, frames (all, timeline order), frame (open), images }.
async function prepareSession({ project, frames }) {
  if (frames.length === 0) throw new Error(`Project ${project.id} has no frames`);
  // Reopen the frame she was on.
  const frame = frames.find((f) => f.id === project.currentFrameId) ?? frames[0];
  project.currentFrameId = frame.id;
  // A frame should have a bitmap slot for every layer; fill any gap
  // (and save it) rather than failing to load.
  if (ensureBitmapRefs(frame, project.layers)) await saveFrame(frame);
  const images = await decodeFrameImages(project.layers, frame, loadLayerBitmap);
  const reference = await decodeReference(frame, loadLayerBitmap, null);
  return { project, frames, frame, images, reference };
}

// --- gallery ---

// Cards for the gallery: project records plus their stored
// thumbnails. Never throws — a failure is reported and gives [].
async function loadGalleryCards() {
  try {
    const projects = await listProjects();
    return await Promise.all(projects.map(async (p) => ({
      id: p.id,
      name: p.name,
      frameCount: p.frames.length,
      thumbnail: await loadThumbnail(p.id).catch(() => null),
    })));
  } catch (err) {
    console.error('Parapara! could not list projects:', err);
    showNotice("Your animations couldn't be loaded.");
    return [];
  }
}

// `preloaded`: cards already loaded by the caller (leaving the editor
// loads them first, so the editor stays up until the gallery is ready
// — no empty moment between screens).
async function showGallery(preloaded = null) {
  let cards = preloaded ?? await loadGalleryCards();
  setUiState({ screen: 'gallery' }, { now: true });

  let closed = false;

  const gallery = createGallery(appRoot, {
    appActions,
    callbacks: {
      onOpen: (id) => open(() => loadProject(id)),
      onCreate: () => open(
        () => createProject(nextProjectName(cards.map((c) => c.name))),
        "Couldn't make a new animation. The iPad may be out of space."
      ),
      onRename: async (id, name) => {
        try {
          await renameProject(id, name);
          cards = cards.map((c) => (c.id === id ? { ...c, name } : c));
          gallery.render(cards);
        } catch (err) {
          console.error('Parapara! rename failed:', err);
          showNotice("That animation couldn't be renamed.");
        }
      },
      // A copy of the whole animation, "<name> copy", as a new card at
      // the front (it's the newest); she stays on the gallery, as in
      // Procreate.
      onDuplicate: async (id) => {
        gallery.setBusy(true);
        try {
          const loaded = await loadProject(id);
          if (!loaded) throw new Error('Project not found');
          const copy = copyProjectRecords(loaded.project, loaded.frames, {
            name: copyName(loaded.project.name, MAX_PROJECT_NAME),
          });
          await saveProjectCopy(copy);
          const card = {
            id: copy.project.id,
            name: copy.project.name,
            frameCount: copy.project.frames.length,
            thumbnail: await loadThumbnail(copy.project.id).catch(() => null),
          };
          cards = [card, ...cards];
          gallery.render(cards);
        } catch (err) {
          console.error('Parapara! duplicate failed:', err);
          showNotice("That animation couldn't be copied. The iPad may be out of space.");
        } finally {
          gallery.setBusy(false);
        }
      },
      onDelete: async (id) => {
        gallery.setBusy(true);
        try {
          await deleteProject(id);
          cards = cards.filter((c) => c.id !== id);
          gallery.render(cards);
        } catch (err) {
          console.error('Parapara! delete failed:', err);
          showNotice("That animation couldn't be deleted.");
        } finally {
          gallery.setBusy(false);
        }
      },
    },
  });
  gallery.render(cards);

  // Loads (or creates) a project and opens it. The gallery stays up
  // until the project has fully loaded, so a failure leaves her where
  // she was.
  async function open(load, failMessage = "That animation couldn't be opened.") {
    gallery.setBusy(true);
    let session;
    try {
      const loaded = await load();
      if (!loaded) throw new Error('Project not found');
      session = await prepareSession(loaded);
    } catch (err) {
      console.error('Parapara! could not open project:', err);
      showNotice(failMessage);
      gallery.setBusy(false);
      return;
    }
    closed = true;
    gallery.destroy();
    mountEditor(session, { canSave: true });
  }

  // Projects without a thumbnail yet (older ones, or never drawn on
  // since): draw them from frame 1's saved layers, one at a time, and
  // keep them. Only logged on failure — a blank card is harmless.
  for (const c of cards) {
    if (c.thumbnail) continue;
    try {
      const loaded = await loadProject(c.id);
      if (closed) return;
      if (!loaded) continue;
      const blob = await buildThumbnail(loaded.project, loaded.frames, loadLayerBitmap);
      if (!blob) continue;
      await saveThumbnail(c.id, blob);
      if (closed) return;
      c.thumbnail = blob;
      gallery.setThumbnail(c.id, blob);
    } catch (err) {
      console.warn('Parapara! could not draw a thumbnail:', err);
    }
  }
}

// Frame 1 of the project as a gallery thumbnail, or null if it has no
// frames. `read(bitmapRef)` supplies layer pixels.
function buildThumbnail(project, frames, read) {
  const first = frames.find((f) => f.id === project.frames[0]);
  if (!first) return null;
  return renderThumbnail({
    layers: project.layers,
    frame: first,
    canvasSize: project.canvas,
    read,
    referenceHidden: project.referenceHidden === true,
  });
}

// --- editor ---
//
// Mounts the editor on one project (a prepareSession() result). With
// canSave false nothing is written and there's no way back to a
// gallery. Leaving through the Gallery button saves everything, draws
// the thumbnail, then tears the editor down — undo history goes with
// it, as in Procreate and Flipaclip.
function mountEditor(session, { canSave }) {
  let savedImages = session.images;
  delete session.images;
  const savedReference = session.reference;
  delete session.reference;

  if (canSave) {
    saveLastProjectId(session.project.id)
      .catch((err) => console.warn('Parapara! could not remember the open project:', err));
    setUiState({ screen: 'editor' }, { now: true });

    // Pixels of layers removed last time (kept so undo could bring
    // them back) are garbage now — undo history isn't saved. Not
    // awaited: nothing here waits on it, and it only touches blobs
    // nothing references.
    deleteUnreferencedBlobs(session.project.id, referencedBlobIds(session.project, session.frames))
      .catch((err) => console.warn('Parapara! blob cleanup failed:', err));
  }

  const project = session.project;
  // Older projects have no palette; a bad saved one is cleaned up.
  project.palette = sanitizeColorList(project.palette, MAX_PALETTE);

  // Created below if saving works; otherwise changes simply aren't
  // saved. Undo works either way — it's in memory only.
  let autosaver = null;
  let projectSaver = null;

  // True when something that shows in frame 1's thumbnail changed
  // since the thumbnail was last drawn.
  let thumbnailStale = false;

  const ui = initUI(appRoot, {
    settings: toolSettings,
    onSettingsChange: () => {
      toolSettings = canvasApi.getSettings();
      if (canSave) settingsSaver.schedule();
    },
    appActions: {
      ...appActions,
      fillAllLayers: () => devFillAllLayers(),
      playbackSpeedTest: () => devPlaybackSpeedTest(),
      frameMemoryTest: () => devFrameMemoryTest(),
    },
    onGallery: canSave ? () => close() : null,
    onUndo: () => undo(),
    onRedo: () => redo(),
    layersPanelOpen: uiState.layersPanelOpen === true,
    layers: {
      onSelect: (id) => selectLayer(id),
      onAdd: () => addLayer(),
      onDelete: (id) => deleteLayer(id),
      onDuplicate: (id) => duplicateLayer(id),
      onClear: (id) => clearLayer(id),
      onRename: (id, name) => renameLayer(id, name),
      onToggleVisible: (id) => toggleLayerProp(id, 'visible'),
      onToggleLock: (id) => toggleLayerProp(id, 'locked'),
      onMove: (id, toIndex) => moveLayerTo(id, toIndex),
      onOpacityInput: (id, opacity) => canvasApi.setLayerProps(id, { opacity }),
      onOpacityCommit: (id, before, after) => commitOpacity(id, before, after),
      onOpenChange: (open) => setUiState({ layersPanelOpen: open }),
    },
    colors: {
      onPaletteAdd: (hex) => addPaletteColor(hex),
      onPaletteReplace: (index, hex) => setPalette(replaceInPalette(project.palette, index, hex)),
      onPaletteRemove: (index) => setPalette(removeFromPalette(project.palette, index)),
    },
    frames: {
      onSelect: (id) => selectFrame(id),
      onAdd: () => addFrame(),
      onDuplicate: () => duplicateFrame(),
    },
    images: {
      onImage: () => addOrAdjustImage(),
      onUseOnAllFrames: () => useImageOnAllFrames(),
      onToggleImages: () => toggleImages(),
    },
    reference: {
      onOpacityInput: (opacity) => {
        const placement = canvasApi.getReferencePlacement();
        if (placement) canvasApi.setReferencePlacement({ ...placement, opacity });
      },
      onFlip: (direction) => {
        const placement = canvasApi.getReferencePlacement();
        if (placement) canvasApi.setReferencePlacement(flipPlacement(placement, direction));
      },
      onReplace: () => pickImage(),
      onDelete: () => deleteImage(),
      onDone: () => finishAdjust(),
    },
  });
  const canvasApi = ui.canvas;
  const panel = ui.layers;
  const strip = ui.frames;
  ui.setRecentColors(recentColors);
  ui.setPalette(project.palette);

  // --- colors (2e) ---
  //
  // Palette edits aren't undoable (as in Procreate) — saved with the
  // project like a rename. Recents follow what she actually draws or
  // fills with, not every color she passes through in the picker.
  function setPalette(palette) {
    if (palette === project.palette) return;
    project.palette = palette;
    scheduleProjectSave();
    ui.setPalette(palette);
  }

  function addPaletteColor(hex) {
    const { palette, result } = addToPalette(project.palette, hex);
    if (result === 'full') {
      showBanner(`Your palette holds ${MAX_PALETTE} colors. Press and hold one to replace it.`);
    } else if (result === 'duplicate') {
      showBanner("That color's already in your palette.");
    } else {
      setPalette(palette);
    }
  }

  function noteColorUsed(hex) {
    const next = addRecent(recentColors, hex);
    if (next === recentColors) return;
    recentColors = next;
    ui.setRecentColors(recentColors);
    if (canSave) recentsSaver.schedule();
  }

  canvasApi.loadFrame({
    layers: project.layers,
    activeLayerId: project.activeLayerId,
    images: savedImages,
  });
  for (const image of savedImages.values()) image.close?.();
  savedImages.clear();
  canvasApi.setReferenceHidden(project.referenceHidden === true);
  applyReference(session.frame, savedReference);
  project.activeLayerId = canvasApi.getActiveLayerId();
  // Settings may have been cleaned up by the canvas (bad saved values).
  toolSettings = canvasApi.getSettings();

  // --- flattened frames: the cache and the strip's pictures (4a-ii) ---
  //
  // Every frame flattened — layers only, full size, PNG — for playback
  // (4b) and onion skin (4c), plus a tile-sized copy that frame-tiles.js
  // puts over paper and the frame's photo for the frame strip. Rebuilt
  // in the background, nearest the current frame first, whenever a
  // frame's pixels or the visible layers change; frame-cache.js has the
  // rules. Memory only: every open rebuilds it (revisit after 4b).
  const tileCss = strip.setAspect(project.canvas);
  const tileScale = Math.min(2, window.devicePixelRatio || 1);
  const tileSize = {
    width: Math.round(tileCss.width * tileScale),
    height: Math.round(tileCss.height * tileScale),
  };
  const frameTiles = createFrameTiles({
    canvasSize: project.canvas,
    tileSize,
    read: (ref) => readBitmap(ref),
    onTile: (id, canvas) => strip.setThumbnail(id, canvas),
  });
  const frameCache = createFrameCache({
    build: (id) => flattenFrame(id),
    // Not while she's mid-stroke, mid-change (closing counts: it sets
    // busy) or adjusting a photo, nor while the app is in the background.
    canWork: () => !busy && !adjust && !canvasApi.isBusy()
      && document.visibilityState === 'visible',
    onUpdate: (id, value) => frameTiles.setLayers(id, value.tile),
    dispose: (value) => freeCanvas(value.tile),
    onError: (err, id) => console.warn(`Parapara! could not flatten frame ${id}:`, err),
  });

  // One frame's cache value: { blob (full-size PNG of its layers), tile
  // (the same at tile size, a canvas) }. The open frame is drawn from
  // the live layer canvases — synchronously, so unsaved strokes count
  // and none can land halfway — every other frame from storage.
  async function flattenFrame(frameId) {
    const frame = session.frames.find((f) => f.id === frameId);
    if (!frame) throw new Error(`No frame ${frameId}`);
    const full = makeCanvas(project.canvas.width, project.canvas.height);
    let tile = null;
    try {
      const open = frameId === session.frame.id;
      await renderFrame(full.getContext('2d'), {
        layers: project.layers,
        frame,
        canvasSize: project.canvas,
        ...(open ? { layerSource: (id) => canvasApi.getLayerImage(id) } : { read: readBitmap }),
      });
      tile = makeCanvas(tileSize.width, tileSize.height);
      const tileCtx = tile.getContext('2d');
      tileCtx.imageSmoothingQuality = 'high';
      tileCtx.drawImage(full, 0, 0, tile.width, tile.height);
      const blob = await encodePNG(full);
      return { blob, tile };
    } catch (err) {
      freeCanvas(tile);
      throw err;
    } finally {
      freeCanvas(full);
    }
  }

  // --- async work guard ---
  //
  // Adding, removing or bringing back a layer or frame, and moving to
  // another frame, touch storage, so they're async. While one runs,
  // undo/redo, panel and strip actions are ignored and the canvas takes
  // no new touches — nothing can land on pixels that are mid-change.
  // One at a time, in order.
  let busy = false;

  function refreshPanel() {
    panel.render({
      layers: project.layers,
      activeLayerId: project.activeLayerId,
      maxLayers: MAX_LAYERS,
      busy,
    });
    strip.render({ frameIds: project.frames, currentId: session.frame.id, busy });
    ui.images.render({
      current: Boolean(session.frame.image?.blobRef),
      any: session.frames.some((f) => f.image?.blobRef),
      frameCount: session.frames.length,
      hidden: project.referenceHidden === true,
      busy,
    });
    // Whatever changed, the cache and tiles catch up (cheap when
    // nothing they depend on did).
    frameCache.setSignature(layerSignature(project.layers));
    frameCache.setFrames(project.frames, session.frame.id);
    frameTiles.sync(session.frames, { hidden: project.referenceHidden === true });
  }

  function exclusive(task) {
    if (busy) return Promise.resolve();
    busy = true;
    canvasApi.setInputBlocked(true);
    refreshPanel();
    return Promise.resolve()
      .then(task)
      .catch((err) => {
        console.error('Parapara! layer or frame change failed:', err);
        showNotice("That change didn't work.");
      })
      .finally(() => {
        busy = false;
        canvasApi.setInputBlocked(false);
        refreshPanel();
      });
  }

  function canAct() {
    return !busy && !canvasApi.isBusy();
  }

  // --- saving ---

  // Layers with edits not yet saved. Autosave writes only these, so a
  // stroke on one layer doesn't re-encode all of them.
  const unsavedLayers = new Set();

  function markUnsaved(layerId) {
    unsavedLayers.add(layerId);
    frameCache.touch(session.frame.id);
    if (session.frame.id === project.frames[0]) thumbnailStale = true;
    autosaver?.schedule();
  }

  // Layer or frame added or removed: the project and the frame records
  // change together, saved in one transaction.
  async function persistStructure(removedFrameIds = []) {
    thumbnailStale = true;
    if (canSave) await saveProjectAndFrames(project, session.frames, removedFrameIds);
  }

  // --- frames ---
  //
  // Only the open frame's layers are in memory. Leaving a frame saves
  // its unsaved layers first; the next frame's layers are read back from
  // storage into the same layer canvases. If a layer can't be saved (or
  // saving is off), its pixels are kept here instead, by bitmapRef, and
  // reloaded from here — then retried to storage once that frame is
  // open again.
  const heldBitmaps = new Map(); // bitmapRef -> PNG Blob

  async function readBitmap(ref) {
    if (heldBitmaps.has(ref)) return heldBitmaps.get(ref);
    return canSave ? loadLayerBitmap(ref) : null;
  }

  async function leaveFrame() {
    if (canSave) await autosaver.flush();
    for (const layerId of unsavedLayers) {
      heldBitmaps.set(session.frame.bitmapRefs[layerId], await canvasApi.exportPNG(layerId));
    }
    unsavedLayers.clear();
  }

  // Shows `frameId` (must be in the timeline). Call inside exclusive().
  async function showFrame(frameId) {
    if (frameId === session.frame.id) return;
    const next = session.frames.find((f) => f.id === frameId);
    if (!next) throw new Error(`No frame ${frameId}`);
    await leaveFrame();
    if (ensureBitmapRefs(next, project.layers) && canSave) await saveFrame(next);
    const images = await decodeFrameImages(project.layers, next, readBitmap);
    const reference = await decodeReference(next, readBitmap, canvasApi.getReferenceKey());

    session.frame = next;
    project.currentFrameId = next.id;
    canvasApi.loadFrame({ layers: project.layers, activeLayerId: project.activeLayerId, images });
    for (const image of images.values()) image.close?.();
    applyReference(next, reference);

    // Pixels that were held in memory go back to storage now.
    if (canSave) {
      for (const layer of project.layers) {
        const ref = next.bitmapRefs[layer.id];
        if (heldBitmaps.delete(ref)) markUnsaved(layer.id);
      }
    }
    scheduleProjectSave();
    panel.refreshThumbnails();
  }

  // Puts a frame (new, or taken out by undo) into the timeline at
  // record.index and shows it.
  async function insertFrame(record) {
    const { frame } = record;
    ensureBitmapRefs(frame, project.layers);
    project.frames = insertFrameId(project.frames, frame.id, record.index);
    const byId = new Map([...session.frames, frame].map((f) => [f.id, f]));
    session.frames = project.frames.map((id) => byId.get(id));
    await persistStructure();
    await showFrame(frame.id);
  }

  // Takes a frame out of the timeline (moving off it first if it's
  // open). Its pixels stay in storage under its refs, which the record
  // keeps, for undo; the launch sweep clears them once that's moot.
  async function takeOutFrame(record) {
    const id = record.frame.id;
    const { frameIds, index } = removeFrameId(project.frames, id);
    if (index < 0) throw new Error(`No frame ${id} to remove`);
    if (session.frame.id === id) await showFrame(frameAfterRemoval(frameIds, index));
    record.frame = session.frames.find((f) => f.id === id);
    record.index = index;
    project.frames = frameIds;
    session.frames = session.frames.filter((f) => f.id !== id);
    await persistStructure([id]);
  }

  // Reorder, rename, visibility, lock, opacity, active layer: only the
  // project record changes, so it's debounced like settings.
  function scheduleProjectSave() {
    projectSaver?.schedule();
  }

  // --- undo/redo (step 2b; layer entries added in 2c) ---
  //
  // One project-wide history, never saved. Entry types:
  //   'pixels'        { frameId, layerId, rect, patch, bytes }
  //   'layer-add'     { record }  record = { layer, index, refs, blob }
  //   'layer-delete'  { record }
  //   'layer-move'    { layerId, from, to }
  //   'layer-props'   { layerId, before, after }   (opacity)
  //   'frame-add'     { record }  record = { frame, index }
  //   'image'         { frameId, before, after }  (3a) frame.image
  //                   records (null = none); blobs stay in storage
  //   'image-all'     { frameId, before, after }  (3b) Use on all
  //                   frames: before = { [frameId]: image } for each
  //                   frame it changed, after = the image they got
  // Adding and deleting are the same two operations run in opposite
  // directions: detach (pixels stay in storage under the frames' old
  // refs, which the record keeps) and attach (put the layer and refs
  // back, reload its pixels). So undo history never holds a removed
  // layer's pixels in memory — except when they couldn't be saved
  // first (record.blob). An entry for another frame moves there first
  // (undo jumps to the frame), asynchronously.
  const history = createHistory({
    onChange: () => ui.setHistoryState(history.canUndo, history.canRedo),
  });

  // Takes a layer out of the project, the frames and the canvas.
  // Returns the record attach() needs to put it back.
  async function detach(layerId) {
    // Make sure storage has the layer's latest pixels — that's where
    // attach() reads them back from. If they can't be saved, keep a
    // copy with the record instead.
    if (canSave) await autosaver.flush();
    let blob = null;
    if (!canSave || unsavedLayers.has(layerId)) blob = await canvasApi.exportPNG(layerId);

    const { layers, layer, index } = removeLayer(project.layers, layerId);
    if (!layer) throw new Error(`No layer ${layerId} to remove`);
    const { frames, refs } = detachLayerRefs(session.frames, layerId);
    unsavedLayers.delete(layerId);

    project.layers = layers;
    setFrames(frames);
    if (project.activeLayerId === layerId || !layers.some((l) => l.id === project.activeLayerId)) {
      project.activeLayerId = activeAfterRemoval(layers, index);
    }
    canvasApi.syncLayers(layers);
    canvasApi.setActiveLayer(project.activeLayerId);
    await persistStructure();
    return { layer, index, refs, blob };
  }

  // Puts a detached (or brand-new) layer back where it was, with its
  // pixels, and makes it the active layer.
  async function attach(record) {
    const { layer, index, refs } = record;
    const frames = attachLayerRefs(session.frames, layer.id, refs);
    let blob = record.blob;
    if (!blob && refs[session.frame.id]) blob = await readBitmap(refs[session.frame.id]);
    const image = blob ? await createImageBitmap(blob) : null;

    project.layers = insertLayer(project.layers, layer, index);
    setFrames(frames);
    project.activeLayerId = layer.id;
    canvasApi.syncLayers(project.layers);
    canvasApi.setLayerImage(layer.id, image);
    image?.close?.();
    canvasApi.setActiveLayer(layer.id);
    // Pixels that came from the record were never saved under the
    // frame's ref; save them now.
    if (record.blob) {
      record.blob = null;
      markUnsaved(layer.id);
    }
    // Keep the refs this layer now has (fresh ones for a new layer), so
    // a later detach/attach round-trip reuses them.
    record.refs = Object.fromEntries(session.frames.map((f) => [f.id, f.bitmapRefs[layer.id]]));
    await persistStructure();
    panel.refreshThumbnail(layer.id);
  }

  function setFrames(frames) {
    session.frames = frames;
    session.frame = frames.find((f) => f.id === session.frame.id) ?? frames[0];
  }

  function swapPixels(entry) {
    const patch = canvasApi.swapRegion(entry.rect, entry.patch, entry.layerId);
    if (!patch) throw new Error(`Undo entry for missing layer ${entry.layerId}`);
    unsavedLayers.add(entry.layerId);
    if (session.frame.id === project.frames[0]) thumbnailStale = true;
    frameCache.touch(session.frame.id);
    panel.refreshThumbnail(entry.layerId);
    return { ...entry, patch, bytes: patch.data.byteLength };
  }

  function applyMove(layerId, toIndex) {
    project.layers = moveLayer(project.layers, layerId, toIndex);
    thumbnailStale = true;
    canvasApi.syncLayers(project.layers);
    scheduleProjectSave();
    refreshPanel();
  }

  function applyLayerChanges(layerId, changes) {
    project.layers = updateLayer(project.layers, layerId, changes);
    if ('visible' in changes || 'opacity' in changes) thumbnailStale = true;
    canvasApi.setLayerProps(layerId, changes);
    scheduleProjectSave();
    refreshPanel();
  }

  // Runs one entry in `direction` ('undo' | 'redo') and returns the
  // entry for the other stack. Layer add/remove finish asynchronously
  // under exclusive(); the entry moves stacks right away.
  function applyEntry(entry, direction) {
    const undoing = direction === 'undo';
    switch (entry.type) {
      case 'pixels':
        if (entry.frameId !== session.frame.id) {
          // Jump to that frame, then swap. The entry moves stacks now;
          // its patch is filled in once the frame is showing.
          exclusive(async () => {
            await showFrame(entry.frameId);
            Object.assign(entry, swapPixels(entry));
          });
          return entry;
        }
        return swapPixels(entry);
      case 'frame-add':
        exclusive(() => (undoing ? takeOutFrame(entry.record) : insertFrame(entry.record)));
        return entry;
      case 'layer-add':
      case 'layer-delete': {
        const remove = (entry.type === 'layer-add') === undoing;
        if (remove) {
          exclusive(async () => {
            Object.assign(entry.record, await detach(entry.record.layer.id));
          });
        } else {
          exclusive(() => attach(entry.record));
        }
        return entry;
      }
      case 'layer-move':
        applyMove(entry.layerId, undoing ? entry.from : entry.to);
        return entry;
      case 'layer-props':
        applyLayerChanges(entry.layerId, undoing ? entry.before : entry.after);
        return entry;
      case 'image':
        exclusive(() => setFrameImage(entry.frameId, undoing ? entry.before : entry.after));
        return entry;
      case 'image-all':
        exclusive(() => applyImageAll(entry, undoing));
        return entry;
      default:
        throw new Error(`Unknown history entry type ${entry.type}`);
    }
  }

  // An undo/redo changes the saved drawing like any edit.
  function undo() {
    if (!canAct() || adjust) return;
    if (history.undo((e) => applyEntry(e, 'undo'))) autosaver?.schedule();
  }

  function redo() {
    if (!canAct() || adjust) return;
    if (history.redo((e) => applyEntry(e, 'redo'))) autosaver?.schedule();
  }

  canvasApi.onChange(({ rect, before, layerId, tool }) => {
    if (tool === 'draw' || tool === 'fill') noteColorUsed(canvasApi.getSettings().color);
    history.push({
      type: 'pixels',
      frameId: session.frame.id,
      layerId,
      rect,
      patch: before,
      bytes: before.data.byteLength,
    });
    markUnsaved(layerId);
    panel.refreshThumbnail(layerId);
  });

  canvasApi.onGesture((name) => (name === 'undo' ? undo() : redo()));

  canvasApi.onBlocked((reason) => {
    showBanner(reason === 'locked'
      ? 'This layer is locked. Unlock it in Layers to draw on it.'
      : 'This layer is hidden. Show it in Layers to draw on it.');
  });

  // --- frame strip actions ---

  function selectFrame(id) {
    if (!canAct() || id === session.frame.id) return;
    exclusive(() => showFrame(id));
  }

  // A blank frame right after the current one, with a slot for every
  // layer; she's moved onto it. It keeps the reference image when
  // every frame shares one (inheritedImage). Undoable (stands in for delete until
  // the full strip in step 4).
  function addFrame() {
    if (!canAct()) return;
    exclusive(async () => {
      const frame = createFrame(project.id, project.layers);
      // A photo every frame shares is a background: the new frame gets
      // it too, placed as on the frame she's adding after (3b).
      frame.image = inheritedImage(session.frames, session.frame);
      const record = { frame, index: insertIndexAfter(project.frames, session.frame.id) };
      await insertFrame(record);
      history.push({ type: 'frame-add', record, bytes: 0 });
    });
  }

  // Copy frame: every layer's drawing on this frame, as a new frame
  // right after it; she's moved onto the copy (Flipaclip's duplicate
  // frame). The whole record is copied (copyFrameRecord), so fields
  // added later come along. Undoable like add frame.
  function duplicateFrame() {
    if (!canAct()) return;
    exclusive(async () => {
      const { frame, pairs } = copyFrameRecord(session.frame);
      await copyPixels(pairs);
      const record = { frame, index: insertIndexAfter(project.frames, session.frame.id) };
      await insertFrame(record);
      history.push({ type: 'frame-add', record, bytes: 0 });
    });
  }

  // Copies pixels from each `from` bitmapRef to its `to` ref (pairs
  // from copyFrameRecord / copyLayerRecord), before anything points at
  // the new refs. Reads what she sees: the open frame's unsaved layers
  // are saved first, and pixels that couldn't be saved (held in memory)
  // are copied in memory and saved once that frame is open again.
  async function copyPixels(pairs) {
    if (canSave) await autosaver.flush();
    const openRefs = new Map(Object.entries(session.frame.bitmapRefs).map(([id, ref]) => [ref, id]));
    const stored = [];
    for (const [from, to] of pairs) {
      const openLayer = openRefs.get(from);
      if (openLayer && (!canSave || unsavedLayers.has(openLayer))) {
        heldBitmaps.set(to, await canvasApi.exportPNG(openLayer));
      } else if (heldBitmaps.has(from)) {
        heldBitmaps.set(to, heldBitmaps.get(from));
      } else {
        stored.push([from, to]);
      }
    }
    if (canSave) await copyBlobs(project.id, stored);
  }

  // --- reference image (step 3a) ---
  //
  // Each frame may have one image she traces over (frame.image =
  // { blobRef, x, y, scale, rotation, opacity }); the blob is stored
  // once and may be shared by several frames (copy frame). The top
  // bar's Image menu adds or adjusts it; Hide images is project-wide view state
  // (project.referenceHidden), not undoable, like layer visibility.
  //
  // Adjust mode: the canvas moves the image live; nothing is written
  // until it ends (Done, Delete, or tapping any other control — see
  // ui.js), and then the whole session is one 'image' undo entry,
  // from the frame's image when adjusting began to what it is now.
  // A fresh import starts adjust mode with before = whatever the frame
  // had, so import + placing is one step.

  // { frameId, before } while adjusting, else null.
  let adjust = null;

  // Frame records changed outside a structure change (image edits),
  // saved in order; flush() and close() wait for them.
  let frameSaves = Promise.resolve();
  function saveFrameRecord(frame) {
    if (frame.id === project.frames[0]) thumbnailStale = true;
    if (!canSave) return;
    frameSaves = frameSaves
      .then(() => saveFrame(frame))
      .catch((err) => {
        console.error('Parapara! saving a frame failed:', err);
        showNotice("Your image change couldn't be saved. The iPad may be out of space.");
      });
  }

  function addOrAdjustImage() {
    if (!canAct() || adjust) return;
    const image = session.frame.image;
    if (image?.blobRef && canvasApi.getReferenceKey() === image.blobRef) {
      beginAdjust(image);
      return;
    }
    // No image yet (or it couldn't be shown): pick one. Must stay
    // inside the tap for iOS to open the picker.
    pickImage();
  }

  function pickImage() {
    ui.pickImage((file) => importImage(file));
  }

  // A picked file becomes this frame's image: stored first (before
  // anything points at it), shown, and adjust mode starts so she can
  // place it. If adjust mode was already on (Replace), it carries on
  // with the new image, and its `before` stays what it was.
  function importImage(file) {
    if (busy) return;
    exclusive(async () => {
      let prepared;
      try {
        prepared = await prepareImport(file, project.canvas.width, project.canvas.height);
      } catch (err) {
        console.warn('Parapara! could not read the picked image:', err);
        showNotice("That image couldn't be opened. Try a different photo.");
        return;
      }
      const blobRef = newId();
      if (canSave) {
        try {
          await saveImageBlob(project.id, blobRef, prepared.blob);
        } catch (err) {
          console.error('Parapara! saving an image failed:', err);
          showNotice("That image couldn't be added. The iPad may be out of space.");
          return;
        }
      } else {
        heldBitmaps.set(blobRef, prepared.blob);
      }
      const bitmap = await createImageBitmap(prepared.blob);
      canvasApi.setReference(blobRef, bitmap, prepared.placement);
      bitmap.close?.();
      if (adjust) ui.setAdjusting(true, prepared.placement.opacity);
      else beginAdjust(session.frame.image ?? null);
    });
  }

  function beginAdjust(before) {
    if (!canvasApi.getReferenceKey() || !canvasApi.setAdjusting(true)) return;
    adjust = { frameId: session.frame.id, before };
    // She can't place what she can't see.
    if (project.referenceHidden) setImagesHidden(false);
    ui.setAdjusting(true, canvasApi.getReferencePlacement().opacity);
    ui.setHistoryState(false, false);
  }

  // Ends adjust mode and records what changed, as one undo step.
  function finishAdjust() {
    if (!adjust) return;
    const { frameId, before } = adjust;
    adjust = null;
    canvasApi.setAdjusting(false);
    ui.setAdjusting(false);
    ui.setHistoryState(history.canUndo, history.canRedo);
    const key = canvasApi.getReferenceKey();
    const after = key ? { blobRef: key, ...canvasApi.getReferencePlacement() } : null;
    if (sameImage(before, after)) return;
    const frame = session.frames.find((f) => f.id === frameId);
    if (!frame) return;
    frame.image = after;
    saveFrameRecord(frame);
    history.push({ type: 'image', frameId, before, after, bytes: 0 });
    refreshPanel();
  }

  // Delete (adjust bar): the frame has no image once it's committed.
  // The blob stays in storage for undo; the sweep clears it later.
  function deleteImage() {
    if (!adjust) return;
    canvasApi.setReference(null);
    finishAdjust();
  }

  // Undo/redo of an 'image' entry: go to that frame and put `image`
  // back. Call inside exclusive().
  async function setFrameImage(frameId, image) {
    await showFrame(frameId);
    const frame = session.frame;
    frame.image = image;
    saveFrameRecord(frame);
    applyReference(frame, await decodeReference(frame, readBitmap, canvasApi.getReferenceKey()));
  }

  // Shows `frame`'s image from decodeReference's result.
  function applyReference(frame, decoded) {
    const image = frame.image;
    if (!image?.blobRef || !decoded) {
      canvasApi.setReference(null);
      return;
    }
    const size = decoded.bitmap ?? canvasApi.getReferenceSize();
    const placement = sanitizePlacement(image, size.width, size.height, project.canvas.width, project.canvas.height);
    canvasApi.setReference(image.blobRef, decoded.bitmap, placement);
    decoded.bitmap?.close?.();
  }

  // Use on all frames (3b, Image menu): this frame's image — photo and
  // placement — onto every frame, as one undo step. Each frame then
  // keeps its own copy of the placement, so nudging one later doesn't
  // move the rest. The photo is stored once and shared. If another
  // frame has a different photo, she confirms first: undo can bring it
  // back, but only until she closes the project.
  async function useImageOnAllFrames() {
    if (!canAct() || adjust) return;
    const frameId = session.frame.id;
    const plan = () => imageForAllFrames(session.frames, frameId, sameImage);
    let found = plan();
    if (!found || canvasApi.getReferenceKey() !== found.image.blobRef) return;
    if (Object.keys(found.before).length === 0) {
      showBanner('Every frame already has this image.');
      return;
    }
    if (found.replacesOther) {
      const yes = await showConfirm({
        title: 'Replace the other photos?',
        message: 'Some frames have a different photo. They will all get this one instead.',
        confirmLabel: 'Replace',
        cancelLabel: 'Cancel',
      });
      // Things may have moved on while the dialog was up.
      if (!yes || !canAct() || adjust || session.frame.id !== frameId) return;
      found = plan();
      if (!found || Object.keys(found.before).length === 0) return;
    }
    const entry = { type: 'image-all', frameId, before: found.before, after: { ...found.image }, bytes: 0 };
    exclusive(async () => {
      history.push(entry);
      await applyImageAll(entry, false);
      showBanner(`Image placed on all ${session.frames.length} frames.`);
    });
  }

  // Applies an 'image-all' entry (undoing: each frame gets its old
  // image back). The open frame is the one it was applied from, whose
  // image never changes, so nothing on screen needs redrawing. Call
  // inside exclusive().
  async function applyImageAll(entry, undoing) {
    await showFrame(entry.frameId);
    for (const frame of session.frames) {
      if (!(frame.id in entry.before)) continue;
      frame.image = undoing ? entry.before[frame.id] : { ...entry.after };
    }
    thumbnailStale = true;
    if (!canSave) return;
    try {
      await saveProjectAndFrames(project, session.frames);
    } catch (err) {
      console.error('Parapara! saving frames failed:', err);
      showNotice("Your image change couldn't be saved. The iPad may be out of space.");
    }
  }

  function toggleImages() {
    if (busy || adjust) return;
    setImagesHidden(!project.referenceHidden);
  }

  function setImagesHidden(hidden) {
    project.referenceHidden = hidden;
    canvasApi.setReferenceHidden(hidden);
    thumbnailStale = true;
    scheduleProjectSave();
    refreshPanel();
  }

  // --- layers panel actions ---

  function selectLayer(id) {
    if (!canAct()) return;
    if (!canvasApi.setActiveLayer(id)) return;
    project.activeLayerId = id;
    scheduleProjectSave();
    refreshPanel();
  }

  function addLayer() {
    if (!canAct()) return;
    if (project.layers.length >= MAX_LAYERS) {
      showBanner(`A project can have up to ${MAX_LAYERS} layers.`);
      return;
    }
    exclusive(async () => {
      const record = {
        layer: createLayer(nextLayerName(project.layers)),
        index: insertIndexAbove(project.layers, project.activeLayerId),
        refs: {},
        blob: null,
      };
      await attach(record);
      history.push({ type: 'layer-add', record, bytes: 0 });
    });
  }

  // Copy layer: the layer's drawing on every frame, as a new layer
  // directly above it, which becomes active (copyLayerRecord: "<name>
  // copy", unlocked). Counts toward the cap; undoable like add layer.
  // One blob copy per frame, so a long animation takes a moment.
  function duplicateLayer(id) {
    if (!canAct()) return;
    const source = project.layers.find((l) => l.id === id);
    if (!source) return;
    if (project.layers.length >= MAX_LAYERS) {
      showBanner(`A project can have up to ${MAX_LAYERS} layers.`);
      return;
    }
    exclusive(async () => {
      const { layer, refs, pairs } = copyLayerRecord(source, session.frames);
      await copyPixels(pairs);
      // The open frame's copy, if it's only in memory, goes in through
      // the record so attach() shows it and saves it.
      const openRef = refs[session.frame.id];
      const blob = heldBitmaps.get(openRef) ?? null;
      heldBitmaps.delete(openRef);
      const record = {
        layer,
        index: project.layers.findIndex((l) => l.id === id) + 1,
        refs,
        blob,
      };
      await attach(record);
      history.push({ type: 'layer-add', record, bytes: 0 });
    });
  }

  // Clear: the active layer's drawing on this frame only (Procreate's
  // and Sketchbook's Clear). Undoable like a stroke. A locked or hidden
  // layer is refused here with wording for clearing (the canvas would
  // refuse too, but its banner talks about drawing).
  function clearLayer(id) {
    if (!canAct() || id !== project.activeLayerId) return;
    const layer = project.layers.find((l) => l.id === id);
    if (layer?.locked) {
      showBanner('This layer is locked. Unlock it in Layers to clear it.');
      return;
    }
    if (layer && !layer.visible) {
      showBanner('This layer is hidden. Show it in Layers to clear it.');
      return;
    }
    canvasApi.clear();
  }

  // A locked layer can't be deleted (lock protects it, not just its
  // pixels) — the banner says why rather than a dead button.
  function deleteLayer(id) {
    if (!canAct() || project.layers.length <= 1) return;
    if (project.layers.find((l) => l.id === id)?.locked) {
      showBanner('This layer is locked. Unlock it in Layers to delete it.');
      return;
    }
    exclusive(async () => {
      const record = await detach(id);
      history.push({ type: 'layer-delete', record, bytes: record.blob?.size ?? 0 });
    });
  }

  function moveLayerTo(id, toIndex) {
    if (!canAct()) return;
    const from = project.layers.findIndex((l) => l.id === id);
    if (from < 0 || from === toIndex) return;
    applyMove(id, toIndex);
    history.push({ type: 'layer-move', layerId: id, from, to: toIndex, bytes: 0 });
  }

  function commitOpacity(id, before, after) {
    if (busy) {
      canvasApi.setLayerProps(id, { opacity: before });
      return;
    }
    applyLayerChanges(id, { opacity: after });
    history.push({
      type: 'layer-props', layerId: id, before: { opacity: before }, after: { opacity: after }, bytes: 0,
    });
  }

  // Visibility and lock aren't undoable — view state, as in Photoshop.
  function toggleLayerProp(id, prop) {
    if (busy) return;
    const layer = project.layers.find((l) => l.id === id);
    if (layer) applyLayerChanges(id, { [prop]: !layer[prop] });
  }

  function renameLayer(id, name) {
    if (busy) return;
    applyLayerChanges(id, { name });
  }

  // Developer memory test: layers up to the cap, each painted solid.
  function devFillAllLayers() {
    if (!canAct()) return;
    exclusive(async () => {
      while (project.layers.length < MAX_LAYERS) {
        const record = {
          layer: createLayer(nextLayerName(project.layers)),
          index: project.layers.length,
          refs: {},
          blob: null,
        };
        await attach(record);
        history.push({ type: 'layer-add', record, bytes: 0 });
      }
      project.layers.forEach((layer, i) => {
        canvasApi.devFillLayer(layer.id, DEV_FILL_COLORS[i % DEV_FILL_COLORS.length]);
      });
    });
  }

  // Developer playback measurements (step 4a-i). Synthetic frames in
  // memory only; the editor is blocked until the report is closed.
  function devPlaybackSpeedTest() {
    if (!canAct()) return;
    exclusive(() => runPlaybackSpeedTest({ canvasSize: project.canvas }));
  }

  // May get the page killed by iOS, so her work is saved first.
  function devFrameMemoryTest() {
    if (!canAct()) return;
    exclusive(async () => {
      if (canSave) await flush();
      await runFrameMemoryTest({ canvasSize: project.canvas, layerCount: project.layers.length });
    });
  }

  refreshPanel();

  if (!canSave) {
    showNotice("Saving isn't working right now, so drawings won't be kept.");
    return;
  }

  autosaver = createAutosaver({
    save: async () => {
      const layerIds = [...unsavedLayers];
      unsavedLayers.clear();
      try {
        for (const layerId of layerIds) {
          const blob = await canvasApi.exportPNG(layerId);
          await saveLayerBitmap(project.id, session.frame.bitmapRefs[layerId], blob);
        }
      } catch (err) {
        // Re-saving one that did land is harmless; losing one isn't.
        for (const layerId of layerIds) unsavedLayers.add(layerId);
        throw err;
      }
    },
    onError: (err) => {
      console.error('Parapara! autosave failed:', err);
      showNotice("Your drawing couldn't be saved. The iPad may be out of space.");
    },
  });

  // Layer order, names, visibility, lock, opacity, the active layer and
  // the palette.
  projectSaver = createAutosaver({
    save: () => saveProject(project),
    delayMs: 300,
    onError: (err) => {
      console.error('Parapara! saving the project failed:', err);
      showNotice("Your layer changes couldn't be saved. The iPad may be out of space.");
    },
  });

  // Saves everything now, then redraws the thumbnail if frame 1
  // changed. Thumbnail failures are only logged.
  async function flush() {
    finishAdjust();
    await Promise.all([autosaver.flush(), projectSaver.flush(), frameSaves]);
    await updateThumbnail();
  }

  async function updateThumbnail() {
    if (!thumbnailStale) return;
    thumbnailStale = false;
    try {
      const blob = await buildThumbnail(project, session.frames, readBitmap);
      if (blob) await saveThumbnail(project.id, blob);
    } catch (err) {
      thumbnailStale = true;
      console.warn('Parapara! could not save the thumbnail:', err);
    }
  }

  flushEditor = flush;

  // The Gallery button. Waits out nothing: a tap while a layer or
  // frame change or a stroke is in progress is ignored, like other
  // buttons. If some of her drawing couldn't be saved, she's asked
  // before it's dropped.
  let closing = false;
  async function close() {
    if (closing || !canAct()) return;
    closing = true;
    busy = true;
    canvasApi.setInputBlocked(true);
    refreshPanel();
    // Failures are reported by the savers' own onError (and left
    // marked unsaved), so check what's left rather than catching.
    await Promise.all([autosaver.flush(), projectSaver.flush(), frameSaves]);
    if (unsavedLayers.size > 0 || heldBitmaps.size > 0 || projectSaver.hasPendingWork) {
      const leave = await showConfirm({
        title: "Some of your drawing isn't saved",
        message: 'The iPad may be out of space. If you go to the gallery now, the unsaved part will be lost.',
        confirmLabel: 'Leave anyway',
        cancelLabel: 'Stay',
        danger: true,
      });
      if (!leave) {
        closing = false;
        busy = false;
        canvasApi.setInputBlocked(false);
        refreshPanel();
        if (autosaver.hasPendingWork) autosaver.schedule();
        if (projectSaver.hasPendingWork) projectSaver.schedule();
        return;
      }
    }
    await updateThumbnail();
    // The gallery's cards load while the editor is still showing, so
    // the swap is immediate — like opening a project, which loads
    // before the gallery goes.
    const cards = await loadGalleryCards();
    flushEditor = null;
    frameCache.destroy();
    frameTiles.destroy();
    ui.destroy();
    showGallery(cards);
  }
}

// The frame's reference image, ready for the canvas: { bitmap } with a
// decoded image, or { bitmap: null } when `currentKey` (the image the
// canvas already shows) is the same one — frames sharing an image
// don't decode it again. null when the frame has none, or it's
// missing or won't decode: an image she traces over isn't worth
// failing the frame for, and nothing ever saves over it.
async function decodeReference(frame, read, currentKey) {
  const ref = frame.image?.blobRef;
  if (!ref) return null;
  if (ref === currentKey) return { bitmap: null };
  try {
    const blob = await read(ref);
    return blob ? { bitmap: await createImageBitmap(blob) } : null;
  } catch (err) {
    console.warn('Parapara! could not load a frame image:', err);
    return null;
  }
}

// Same placement and same stored image (or both none).
function sameImage(a, b) {
  if (!a || !b) return !a && !b;
  return a.blobRef === b.blobRef && samePlacement(a, b);
}

// Decodes a frame's saved layer bitmaps: a Map of layer id ->
// ImageBitmap, with blank layers left out. A bitmap that won't decode
// throws — the caller treats that like any failed load.
async function decodeFrameImages(layers, frame, read) {
  const images = new Map();
  for (const layer of layers) {
    const blob = await read(frame.bitmapRefs[layer.id]);
    if (blob) images.set(layer.id, await createImageBitmap(blob));
  }
  return images;
}
