// Parapara! — app entry point
//
// Glue between modules: loads the project from storage/, hands it to
// the canvas, wires autosave, undo and the layers panel, and connects
// the updater (updater.js) to the update toast and the gear menu.
// Modules don't import each other's internals; this file moves data
// between them (see PROJECT_NOTES.md, scope-specific file structure).
// Screen routing (gallery <-> editor) lands here with step 2d; for now
// it opens straight into the editor.

import { initUI, showUpdatePrompt, showNotice } from './ui/ui.js';
import {
  initStorage,
  openLastProject,
  loadLayerBitmap,
  saveLayerBitmap,
  loadToolSettings,
  saveToolSettings,
  loadUiState,
  saveUiState,
  saveFrame,
  saveProject,
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
} from './storage/layers.js';
import { createAutosaver } from './storage/autosave.js';
import { createHistory } from './storage/history.js';
import { initUpdater, formatVersion } from './updater.js';

// Save functions to run before any reload the app causes itself
// (applying an update, Fresh reload), so a stroke made seconds earlier
// isn't lost. startEditor() adds to this once saving is set up.
const flushBeforeReload = [];

const updater = initUpdater({
  onUpdateReady: () => showUpdatePrompt(() => updater.applyUpdate()),
  beforeReload: () => Promise.all(flushBeforeReload.map((flush) => flush())),
});

// Colors for the developer "Fill all layers" memory test.
const DEV_FILL_COLORS = ['#e05a47', '#f2a65a', '#e8d15a', '#7cc46b', '#4fb3c9', '#5a7be0', '#a065d6', '#d65aa8'];

startEditor();

async function startEditor() {
  // Load everything — including decoding every layer's saved image —
  // *before* the canvas exists, so there's no moment where she could
  // draw and then have a late-arriving load wipe the stroke.
  //
  // session: { project, frames (all, timeline order), frame (open) }.
  // canSave is false if loading failed: she can still draw (on an
  // in-memory project) but nothing is written, so a drawing that merely
  // failed to load is never overwritten.
  let session = null;
  let canSave = false;
  let savedImages = new Map(); // layer id -> ImageBitmap
  let savedSettings = null;
  let savedUiState = null;
  try {
    await initStorage();
    const { project, frames } = await openLastProject();
    // Which frame was open is remembered once the frame strip exists;
    // until then there's only ever one.
    const frame = frames[0];
    // A frame should have a bitmap slot for every layer; fill any gap
    // (and save it) rather than failing to load.
    if (ensureBitmapRefs(frame, project.layers)) await saveFrame(frame);
    savedImages = await decodeFrameImages(project.layers, frame);
    session = { project, frames, frame };
    canSave = true;

    // Pixels of layers removed last session (kept so undo could bring
    // them back) are garbage now — undo history isn't saved. Not
    // awaited: nothing here waits on it, and it only touches blobs
    // nothing references.
    deleteUnreferencedBlobs(project.id, referencedBlobIds(project, frames))
      .catch((err) => console.warn('Parapara! blob cleanup failed:', err));
  } catch (err) {
    console.error('Parapara! could not load saved work:', err);
    const project = createProjectRecord();
    const frame = createFrame(project.id, project.layers);
    project.frames = [frame.id];
    session = { project, frames: [frame], frame };
  }

  // Tool settings and panel state are niceties, not her work: if they
  // fail to load, start with defaults rather than turning saving off.
  if (canSave) {
    try {
      savedSettings = await loadToolSettings();
    } catch (err) {
      console.warn('Parapara! could not load tool settings:', err);
    }
    try {
      savedUiState = await loadUiState();
    } catch (err) {
      console.warn('Parapara! could not load UI state:', err);
    }
  }

  const project = session.project;

  // Created below once we know storage works; until then (and if it
  // doesn't), changes simply aren't saved. Undo works either way — it's
  // in memory only.
  let settingsSaver = null;
  let autosaver = null;
  let projectSaver = null;
  let uiStateSaver = null;

  const ui = initUI(document.getElementById('app'), {
    settings: savedSettings,
    onSettingsChange: () => settingsSaver?.schedule(),
    appActions: {
      getVersionLabel: async () => formatVersion(await updater.getVersion()),
      checkForUpdate: () => updater.checkForUpdate(),
      applyUpdate: () => updater.applyUpdate(),
      freshReload: () => updater.freshReload(),
      fillAllLayers: () => devFillAllLayers(),
    },
    onUndo: () => undo(),
    onRedo: () => redo(),
    layersPanelOpen: savedUiState?.layersPanelOpen === true,
    layers: {
      onSelect: (id) => selectLayer(id),
      onAdd: () => addLayer(),
      onDelete: (id) => deleteLayer(id),
      onRename: (id, name) => renameLayer(id, name),
      onToggleVisible: (id) => toggleLayerProp(id, 'visible'),
      onToggleLock: (id) => toggleLayerProp(id, 'locked'),
      onMove: (id, toIndex) => moveLayerTo(id, toIndex),
      onOpacityInput: (id, opacity) => canvasApi.setLayerProps(id, { opacity }),
      onOpacityCommit: (id, before, after) => commitOpacity(id, before, after),
      onOpenChange: () => uiStateSaver?.schedule(),
    },
  });
  const canvasApi = ui.canvas;
  const panel = ui.layers;

  canvasApi.loadFrame({
    layers: project.layers,
    activeLayerId: project.activeLayerId,
    images: savedImages,
  });
  for (const image of savedImages.values()) image.close?.();
  savedImages.clear();
  project.activeLayerId = canvasApi.getActiveLayerId();

  // --- async work guard ---
  //
  // Adding, removing or bringing back a layer touches storage, so it's
  // async. While one runs, undo/redo and panel actions are ignored and
  // the canvas takes no new touches — nothing can land on a layer
  // that's mid-change. One at a time, in order.
  let busy = false;

  function refreshPanel() {
    panel.render({
      layers: project.layers,
      activeLayerId: project.activeLayerId,
      maxLayers: MAX_LAYERS,
      busy,
    });
  }

  function exclusive(task) {
    if (busy) return Promise.resolve();
    busy = true;
    canvasApi.setInputBlocked(true);
    refreshPanel();
    return Promise.resolve()
      .then(task)
      .catch((err) => {
        console.error('Parapara! layer change failed:', err);
        showNotice("That layer change didn't work.");
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
    autosaver?.schedule();
  }

  // Layer added or removed: the project and every frame's bitmap slots
  // change together, saved in one transaction.
  async function persistStructure() {
    if (canSave) await saveProjectAndFrames(project, session.frames);
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
  // Adding and deleting are the same two operations run in opposite
  // directions: detach (pixels stay in storage under the frames' old
  // refs, which the record keeps) and attach (put the layer and refs
  // back, reload its pixels). So undo history never holds a removed
  // layer's pixels in memory — except when they couldn't be saved
  // first (record.blob). The frame strip adds the jump to
  // entry.frameId.
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
    if (!blob && canSave && refs[session.frame.id]) {
      blob = await loadLayerBitmap(refs[session.frame.id]);
    }
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
    canvasApi.syncLayers(project.layers);
    scheduleProjectSave();
    refreshPanel();
  }

  function applyLayerChanges(layerId, changes) {
    project.layers = updateLayer(project.layers, layerId, changes);
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
        return swapPixels(entry);
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
    showNotice(reason === 'locked'
      ? 'This layer is locked. Unlock it in Layers to draw on it.'
      : 'This layer is hidden. Show it in Layers to draw on it.');
  });

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
      showNotice(`A project can have up to ${MAX_LAYERS} layers.`);
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

  // Tool, color and brush sizes — app-wide, remembered across launches
  // (see storage.js). Same save-timing rules as the drawing. A failure
  // is only logged: losing a color choice isn't worth interrupting her.
  settingsSaver = createAutosaver({
    save: () => saveToolSettings(canvasApi.getSettings()),
    delayMs: 300,
    onError: (err) => console.warn('Parapara! saving tool settings failed:', err),
  });

  // Whether the layers panel is open — same idea as tool settings.
  uiStateSaver = createAutosaver({
    save: () => saveUiState({ layersPanelOpen: panel.isOpen }),
    delayMs: 300,
    onError: (err) => console.warn('Parapara! saving UI state failed:', err),
  });

  const flushAll = () => Promise.all(
    [autosaver, projectSaver, settingsSaver, uiStateSaver].map((saver) => saver.flush())
  );

  // iPadOS can close a backgrounded web app without warning, so save
  // the moment it's hidden rather than waiting out the debounce.
  // visibilitychange is the reliable signal on iOS; pagehide is a
  // backup for an actual unload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  window.addEventListener('pagehide', () => flushAll());

  flushBeforeReload.push(flushAll);
}

// Decodes a frame's saved layer bitmaps: a Map of layer id ->
// ImageBitmap, with blank layers left out. A bitmap that won't decode
// throws — the caller treats that like any failed load (saving off).
async function decodeFrameImages(layers, frame) {
  const images = new Map();
  for (const layer of layers) {
    const blob = await loadLayerBitmap(frame.bitmapRefs[layer.id]);
    if (blob) images.set(layer.id, await createImageBitmap(blob));
  }
  return images;
}
