// Parapara! — app entry point
//
// Glue between modules: loads the project from storage/, hands it to
// the canvas, wires autosave, and connects the updater (updater.js) to
// the update toast and the gear menu. Modules don't import each other's
// internals; this file moves data between them (see PROJECT_NOTES.md,
// scope-specific file structure). Screen routing (gallery <-> editor)
// lands here with step 2d; for now it opens straight into the editor.

import { initUI, showUpdatePrompt, showNotice } from './ui/ui.js';
import {
  initStorage,
  openLastProject,
  loadLayerBitmap,
  saveLayerBitmap,
  loadToolSettings,
  saveToolSettings,
  saveFrame,
  createLayer,
  ensureBitmapRefs,
} from './storage/storage.js';
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

startEditor();

async function startEditor() {
  // Load everything — including decoding every layer's saved image —
  // *before* the canvas exists, so there's no moment where she could
  // draw and then have a late-arriving load wipe the stroke.
  let session = null;      // { project, frame } once loaded
  let savedImages = new Map(); // layer id -> ImageBitmap
  let savedSettings = null;
  try {
    await initStorage();
    const { project, frames } = await openLastProject();
    // Which frame was open is remembered from pass 3 on; until then
    // there's only ever one.
    const frame = frames[0];
    // A frame should have a bitmap slot for every layer; fill any gap
    // (and save it) rather than failing to load.
    if (ensureBitmapRefs(frame, project.layers)) await saveFrame(frame);
    savedImages = await decodeFrameImages(project.layers, frame);
    session = { project, frame };

    // Tool settings are a nicety, not her work: if they fail to load,
    // start with defaults rather than turning saving off.
    try {
      savedSettings = await loadToolSettings();
    } catch (err) {
      console.warn('Parapara! could not load tool settings:', err);
    }
  } catch (err) {
    // Anything failing here — storage unavailable, or a saved image
    // that won't decode — means drawing still works but autosave stays
    // OFF. Saving a blank canvas over a drawing that merely failed to
    // load would destroy it.
    console.error('Parapara! could not load saved work:', err);
  }

  // Created below once we know storage works; until then (and if it
  // doesn't), changes simply aren't saved. Undo works either way — it's
  // in memory only.
  let settingsSaver = null;
  let autosaver = null;

  const ui = initUI(document.getElementById('app'), {
    settings: savedSettings,
    onSettingsChange: () => settingsSaver?.schedule(),
    appActions: {
      getVersionLabel: async () => formatVersion(await updater.getVersion()),
      checkForUpdate: () => updater.checkForUpdate(),
      applyUpdate: () => updater.applyUpdate(),
      freshReload: () => updater.freshReload(),
    },
    onUndo: () => undo(),
    onRedo: () => redo(),
  });
  const canvasApi = ui.canvas;

  if (session) {
    canvasApi.loadFrame({
      layers: session.project.layers,
      activeLayerId: session.project.activeLayerId,
      images: savedImages,
    });
  } else {
    // Saving is off, but she can still draw on one temporary layer.
    const layer = createLayer();
    canvasApi.loadFrame({ layers: [layer], activeLayerId: layer.id });
  }
  for (const image of savedImages.values()) image.close?.();
  savedImages.clear();

  // --- undo/redo (step 2b) ---
  //
  // One project-wide history, never saved. Entries are tagged with the
  // frame and layer they changed, and swapEntry writes to entry.layerId
  // — which may not be the active layer. Pass 3 (frame strip) adds the
  // jump: switch to entry.frameId first, loading it if needed.
  const history = createHistory({
    onChange: () => ui.setHistoryState(history.canUndo, history.canRedo),
  });

  // Layers with edits not yet saved. Autosave writes only these, so a
  // stroke on one layer doesn't re-encode all of them.
  const unsavedLayers = new Set();

  function markUnsaved(layerId) {
    unsavedLayers.add(layerId);
    autosaver?.schedule();
  }

  function swapEntry(entry) {
    const patch = canvasApi.swapRegion(entry.rect, entry.patch, entry.layerId);
    // Can't happen until layers can be deleted (pass 2 makes deletes
    // undoable, so their entries always have a layer to land on).
    if (!patch) throw new Error(`Undo entry for missing layer ${entry.layerId}`);
    unsavedLayers.add(entry.layerId);
    return { ...entry, patch, bytes: patch.data.byteLength };
  }

  // An undo/redo changes the saved drawing like any edit.
  function undo() {
    if (canvasApi.isBusy()) return;
    if (history.undo(swapEntry)) autosaver?.schedule();
  }

  function redo() {
    if (canvasApi.isBusy()) return;
    if (history.redo(swapEntry)) autosaver?.schedule();
  }

  canvasApi.onChange(({ rect, before, layerId }) => {
    history.push({
      type: 'pixels',
      frameId: session?.frame.id ?? null,
      layerId,
      rect,
      patch: before,
      bytes: before.data.byteLength,
    });
    markUnsaved(layerId);
  });

  canvasApi.onGesture((name) => (name === 'undo' ? undo() : redo()));

  if (!session) {
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
          await saveLayerBitmap(session.project.id, session.frame.bitmapRefs[layerId], blob);
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

  // Tool, color and brush sizes — app-wide, remembered across launches
  // (see storage.js). Same save-timing rules as the drawing. A failure
  // is only logged: losing a color choice isn't worth interrupting her.
  settingsSaver = createAutosaver({
    save: () => saveToolSettings(canvasApi.getSettings()),
    delayMs: 300,
    onError: (err) => console.warn('Parapara! saving tool settings failed:', err),
  });

  // iPadOS can close a backgrounded web app without warning, so save
  // the moment it's hidden rather than waiting out the debounce.
  // visibilitychange is the reliable signal on iOS; pagehide is a
  // backup for an actual unload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      autosaver.flush();
      settingsSaver.flush();
    }
  });
  window.addEventListener('pagehide', () => {
    autosaver.flush();
    settingsSaver.flush();
  });

  flushBeforeReload.push(() => autosaver.flush(), () => settingsSaver.flush());
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
