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
} from './timeline/frames.js';
import { createAutosaver } from './storage/autosave.js';
import { createHistory } from './storage/history.js';
import { renderThumbnail } from './canvas/thumbnail.js';
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
  const savers = storageWorks ? [settingsSaver.flush(), uiStateSaver.flush()] : [];
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
  return { project, frames, frame, images };
}

// --- gallery ---

async function showGallery() {
  setUiState({ screen: 'gallery' }, { now: true });

  // Cards: project records plus their stored thumbnails.
  let cards = [];
  try {
    const projects = await listProjects();
    cards = await Promise.all(projects.map(async (p) => ({
      id: p.id,
      name: p.name,
      frameCount: p.frames.length,
      thumbnail: await loadThumbnail(p.id).catch(() => null),
    })));
  } catch (err) {
    console.error('Parapara! could not list projects:', err);
    showNotice("Your animations couldn't be loaded.");
  }

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
  return renderThumbnail({ layers: project.layers, frame: first, canvasSize: project.canvas, read });
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
    appActions: { ...appActions, fillAllLayers: () => devFillAllLayers() },
    onGallery: canSave ? () => close() : null,
    onUndo: () => undo(),
    onRedo: () => redo(),
    layersPanelOpen: uiState.layersPanelOpen === true,
    layers: {
      onSelect: (id) => selectLayer(id),
      onAdd: () => addLayer(),
      onDelete: (id) => deleteLayer(id),
      onDuplicate: (id) => duplicateLayer(id),
      onRename: (id, name) => renameLayer(id, name),
      onToggleVisible: (id) => toggleLayerProp(id, 'visible'),
      onToggleLock: (id) => toggleLayerProp(id, 'locked'),
      onMove: (id, toIndex) => moveLayerTo(id, toIndex),
      onOpacityInput: (id, opacity) => canvasApi.setLayerProps(id, { opacity }),
      onOpacityCommit: (id, before, after) => commitOpacity(id, before, after),
      onOpenChange: (open) => setUiState({ layersPanelOpen: open }),
    },
    frames: {
      onSelect: (id) => selectFrame(id),
      onAdd: () => addFrame(),
      onDuplicate: () => duplicateFrame(),
    },
  });
  const canvasApi = ui.canvas;
  const panel = ui.layers;
  const strip = ui.frames;

  canvasApi.loadFrame({
    layers: project.layers,
    activeLayerId: project.activeLayerId,
    images: savedImages,
  });
  for (const image of savedImages.values()) image.close?.();
  savedImages.clear();
  project.activeLayerId = canvasApi.getActiveLayerId();
  // Settings may have been cleaned up by the canvas (bad saved values).
  toolSettings = canvasApi.getSettings();

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

    session.frame = next;
    project.currentFrameId = next.id;
    canvasApi.loadFrame({ layers: project.layers, activeLayerId: project.activeLayerId, images });
    for (const image of images.values()) image.close?.();

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
      default:
        throw new Error(`Unknown history entry type ${entry.type}`);
    }
  }

  // An undo/redo changes the saved drawing like any edit.
  function undo() {
    if (!canAct()) return;
    if (history.undo((e) => applyEntry(e, 'undo'))) autosaver?.schedule();
  }

  function redo() {
    if (!canAct()) return;
    if (history.redo((e) => applyEntry(e, 'redo'))) autosaver?.schedule();
  }

  canvasApi.onChange(({ rect, before, layerId }) => {
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
  // layer; she's moved onto it. Undoable (stands in for delete until
  // the full strip in step 4).
  function addFrame() {
    if (!canAct()) return;
    exclusive(async () => {
      const record = {
        frame: createFrame(project.id, project.layers),
        index: insertIndexAfter(project.frames, session.frame.id),
      };
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

  function deleteLayer(id) {
    if (!canAct() || project.layers.length <= 1) return;
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

  // Layer order, names, visibility, lock, opacity and the active layer.
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
    await Promise.all([autosaver.flush(), projectSaver.flush()]);
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
    await Promise.all([autosaver.flush(), projectSaver.flush()]);
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
    flushEditor = null;
    ui.destroy();
    showGallery();
  }
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
