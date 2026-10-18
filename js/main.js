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
  // Load everything — including decoding the saved image — *before*
  // the canvas exists, so there's no moment where she could draw and
  // then have a late-arriving load wipe the stroke.
  let session = null;      // { project, frame, layer } once loaded
  let savedImage = null;
  let savedSettings = null;
  try {
    await initStorage();
    const { project, frames } = await openLastProject();
    const frame = frames[0];
    const layer = frame.layers.find((l) => l.id === frame.activeLayerId) ?? frame.layers[0];
    const blob = await loadLayerBitmap(layer.bitmapRef);
    if (blob) savedImage = await createImageBitmap(blob);
    session = { project, frame, layer };

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

  if (savedImage) {
    canvasApi.setImage(savedImage);
    savedImage.close?.();
  }

  // --- undo/redo (step 2b) ---
  //
  // One project-wide history, never saved. Entries are tagged with the
  // frame and layer they changed. Only one frame and one layer exist
  // until 2c; when they do, swapEntry must first switch to
  // entry.frameId (undo jumps to that frame) and write to
  // entry.layerId's surface — which may not be the active layer.
  const history = createHistory({
    onChange: () => ui.setHistoryState(history.canUndo, history.canRedo),
  });

  function swapEntry(entry) {
    const patch = canvasApi.swapRegion(entry.rect, entry.patch);
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

  canvasApi.onChange(({ rect, before }) => {
    history.push({
      type: 'pixels',
      frameId: session?.frame.id ?? null,
      layerId: session?.layer.id ?? null,
      rect,
      patch: before,
      bytes: before.data.byteLength,
    });
    autosaver?.schedule();
  });

  canvasApi.onGesture((name) => (name === 'undo' ? undo() : redo()));

  if (!session) {
    showNotice("Saving isn't working right now, so drawings won't be kept.");
    return;
  }

  autosaver = createAutosaver({
    save: async () => {
      const blob = await canvasApi.exportPNG();
      await saveLayerBitmap(session.project.id, session.layer.bitmapRef, blob);
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
