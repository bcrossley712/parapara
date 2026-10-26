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

import { initUI, showUpdatePrompt, showNotice as showNoticeToast, showBanner } from './ui/ui.js';
import { createGallery } from './ui/gallery.js';
import { showConfirm } from './ui/confirm-dialog.js';
// Developer only (step 4a-i), removed with the gear menu's Developer section.
import { runPlaybackSpeedTest, runFrameMemoryTest, reportInterruptedMemoryTest } from './timeline/dev-stress.js';
// Developer only (after 4b): the activity log, removed with the Developer section.
import { devLog } from './storage/dev-log.js';
import { showDevLog } from './ui/dev-log-view.js';
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
  saveAudioBlob,
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
  moveFrameId,
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
import { renderFrame, makeCanvas, freeCanvas, encodePNG, liveCanvasCount } from './canvas/render-frame.js';
import { createFrameTiles } from './canvas/frame-tiles.js';
import { createFrameCache, layerSignature } from './timeline/frame-cache.js';
import { createPlayback } from './timeline/playback.js';
import { sanitizeFps } from './timeline/clock.js';
import { createPlaybackFrames } from './canvas/playback-frames.js';
import { createOnionView } from './canvas/onion-view.js';
import { sanitizeOnion, ghostFrames } from './timeline/onion.js';
import { createAudio } from './audio/audio.js';
import {
  sanitizeAudioClips, newClip, checkImportSize, sameClips, MAX_CLIP_SECONDS,
  clipOfKind, withClip, recordedClip, timeAtFrame, minClipSeconds, COUNTDOWN_SECONDS,
  speechLoudness, loudnessGain, withVolume, sanitizeVolume, clipVolume, slipClip,
} from './audio/clip.js';
import { createRecorder, micError, micSettings } from './audio/recorder.js';
import { computePeaks } from './audio/peaks.js';
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
// { screen: 'gallery' | 'editor', hideHeadphonesTip }
// — remembered across launches. hideHeadphonesTip (5c): she chose
// "Don't show again" on the headphones popup.
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
// The open editor's canvas check (lost canvases, after 4c), or null.
let checkEditor = null;
// The open editor's "the app was hidden" hook (5c: ends a recording),
// or null.
let hideEditor = null;

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

// The activity log is written now and again once the saves settle —
// iOS may not wait for them.
function flushAll() {
  devLog.flush();
  const savers = storageWorks ? [settingsSaver.flush(), uiStateSaver.flush(), recentsSaver.flush()] : [];
  return Promise.all([flushEditor?.(), ...savers]).finally(() => devLog.flush());
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
  showActivityLog: () => showDevLog({ read: (last) => devLog.read(last), clear: () => devLog.clear() }),
};

// Problems she has to OK go in the activity log too (dev only).
function showNotice(message) {
  devLog.add('notice', message);
  showNoticeToast(message);
}

// iPadOS can close a backgrounded web app without warning, so save
// the moment it's hidden rather than waiting out the debounce.
// visibilitychange is the reliable signal on iOS; pagehide is a
// backup for an actual unload.
document.addEventListener('visibilitychange', () => {
  devLog.add('app', document.visibilityState);
  if (document.visibilityState === 'hidden') {
    hideEditor?.();
    flushAll();
  } else checkEditor?.();
});
window.addEventListener('pagehide', () => flushAll());

launch();
reportInterruptedMemoryTest(); // developer only, step 4a-i

async function launch() {
  devLog.add('launch');
  appActions.getVersionLabel().then((v) => devLog.add('version', v), () => {});
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
    // layersPanelOpen (2b–5c) is retired: the panel is a menu now (not
    // reopened at launch); an old saved value is ignored.
    uiState = {
      // Installs from before the gallery have no screen saved; they
      // were always in the editor.
      screen: saved?.screen === 'gallery' ? 'gallery' : 'editor',
      hideHeadphonesTip: saved?.hideHeadphonesTip === true,
    };
  } catch (err) {
    console.warn('Parapara! could not load UI state:', err);
    uiState = { screen: 'editor', hideHeadphonesTip: false };
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
  const sizes = new Map();
  const images = await decodeFrameImages(project.layers, frame, loadLayerBitmap, sizes);
  const reference = await decodeReference(frame, loadLayerBitmap, null);
  return { project, frames, frame, images, reference, sizes };
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
  // Playback settings (4b): fps 1–30; older projects have no loop
  // (missing = on).
  project.fps = sanitizeFps(project.fps);
  project.loop = project.loop !== false;
  // Onion skin (4c): older projects have none (missing = off, the
  // defaults); bad fields fall back one by one.
  project.onionSkin = sanitizeOnion(project.onionSkin);
  // Sound (step 5): older projects have none; an unusable clip record
  // is dropped (its file stays until the sweep), never a failed open.
  project.audioClips = sanitizeAudioClips(project.audioClips);

  // Activity log (dev only): a frame as "f3#1a2b" (its position, then
  // the end of its id, which never changes), a layer or blob id short.
  const tag = (frameId) => `f${project.frames.indexOf(frameId) + 1}#${String(frameId).slice(-4)}`;
  const short = (id) => String(id).slice(-4);
  devLog.add('open', {
    project: short(project.id), frames: project.frames.length, layers: project.layers.length,
    at: tag(session.frame.id), canSave,
    made: liveCanvasCount(), // before this project makes any: what earlier ones left
  });

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
      fillAllLayers: afterPlayback(() => devFillAllLayers()),
      playbackSpeedTest: afterPlayback(() => devPlaybackSpeedTest()),
      frameMemoryTest: afterPlayback(() => devFrameMemoryTest()),
      micDelayTest: () => devMicDelayTest(), // inside the tap: starts sound
    },
    // Anything that changes the project stops playback first and runs
    // once she's on the frame that was showing (afterPlayback, 4b).
    onGallery: canSave ? afterPlayback(() => close()) : null,
    onUndo: afterPlayback(() => undo()),
    onRedo: afterPlayback(() => redo()),
    layers: {
      onSelect: afterPlayback((id) => selectLayer(id)),
      onAdd: afterPlayback(() => addLayer()),
      onDelete: afterPlayback((id) => deleteLayer(id)),
      onDuplicate: afterPlayback((id) => duplicateLayer(id)),
      onCopy: afterPlayback(() => copyDrawing()),
      onPaste: afterPlayback(() => pasteDrawing()),
      onClear: afterPlayback((id) => clearLayer(id)),
      onRename: afterPlayback((id, name) => renameLayer(id, name)),
      onToggleVisible: afterPlayback((id) => toggleLayerProp(id, 'visible')),
      onToggleLock: afterPlayback((id) => toggleLayerProp(id, 'locked')),
      onMove: afterPlayback((id, toIndex) => moveLayerTo(id, toIndex)),
      onOpacityInput: (id, opacity) => {
        stopPlayback();
        canvasApi.setLayerProps(id, { opacity });
      },
      onOpacityCommit: afterPlayback((id, before, after) => commitOpacity(id, before, after)),
    },
    colors: {
      onPaletteAdd: (hex) => addPaletteColor(hex),
      onPaletteReplace: (index, hex) => setPalette(replaceInPalette(project.palette, index, hex)),
      onPaletteRemove: (index) => setPalette(removeFromPalette(project.palette, index)),
    },
    frames: {
      onSelect: (id) => selectFrame(id),
      onAdd: afterPlayback(() => addFrame()),
      onDuplicate: afterPlayback(() => duplicateFrame()),
      onDelete: afterPlayback(() => deleteFrame()),
      onMove: afterPlayback((id, to) => moveFrame(id, to)),
    },
    transport: {
      onPlay: () => togglePlay(),
      onPrev: () => stepFrame(-1),
      onNext: () => stepFrame(1),
      onLoop: () => setLoop(!project.loop),
      onFps: (fps) => setFps(fps),
    },
    // A setting, like fps: doesn't stop playback.
    onion: {
      onToggle: () => setOnion({ on: !project.onionSkin.on }),
      onChange: (changes) => setOnion(changes),
    },
    images: {
      // The photo picker must open inside the tap (iOS), so it can't
      // wait for playback to stop: this tap only stops it.
      onImage: () => {
        if (playback.active || landing) {
          stopPlayback();
          return;
        }
        addOrAdjustImage();
      },
      onUseOnAllFrames: afterPlayback(() => useImageOnAllFrames()),
      onToggleImages: afterPlayback(() => toggleImages()),
    },
    // The sound panel (5b). Play works with it open; opening it isn't
    // an edit, so the button doesn't stop playback.
    sound: {
      // Like Image: the file picker must open inside the tap (iOS), so
      // Import while playing only stops playback.
      onImport: () => {
        if (playback.active || landing) {
          stopPlayback();
          return;
        }
        if (!canAct() || adjust) return;
        ui.pickAudio((file) => importSound(file));
      },
      onDelete: afterPlayback((kind) => deleteSound(kind)),
      onChange: (kind, clip) => changeClip(kind, clip),
      // 5c: hold to record. Runs inside the press (iOS sound rules).
      onMicDown: () => onMicDown(),
      onMicUp: (detail) => onMicUp(detail),
      onPlayingTouch: () => stopPlayback(),
      onVolumeInput: (kind, volume) => audio.setVolume(kind, sanitizeVolume(volume, kind)),
      onVolumeCommit: (kind, volume) => commitVolume(kind, volume),
      onListen: (mode) => startListen(mode),
      onListenStop: () => finishListen('stop'),
      canRetimeMusic: () => canRetimeMusic('Now move the song.'),
      onOpenChange: (open) => {
        // What the panel remembers lasts one opening: a Voice recorded
        // before it was opened asks before it's replaced (and before the
        // song is moved under it), and the headphones tip shows again.
        voiceOkRef = null;
        musicRetimeOk = false;
        headphonesTipShown = false;
        if (!open) {
          interruptTake();
          finishListen('closed');
        }
        renderSound();
      },
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
      // Not while a picked photo is still being prepared (Replace): the
      // bar is disabled then, and an outside tap mustn't commit the old
      // photo either.
      onDone: () => {
        if (!busy) finishAdjust();
      },
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

  const openLoad = canvasApi.loadFrame({
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
    onUpdate: (id, value) => {
      frameTiles.setLayers(id, value.tile);
      updateOnion(); // a ghost frame's picture may be newer
    },
    dispose: (value) => freeCanvas(value.tile),
    onError: (err, id) => {
      devLog.add('flatten-failed', { frame: tag(id), error: String(err?.message ?? err) });
      console.warn(`Parapara! could not flatten frame ${id}:`, err);
    },
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

  // --- playback (4b) ---
  //
  // Play shows "Getting ready" until every frame is flattened (the
  // cache is hurried along), then plays from the frame she's on, at
  // the project's fps, looping unless she turned loop off. The picture
  // is drawn on its own canvas above the layers (canvas.js), from the
  // cache's PNGs plus each frame's photo (playback-frames.js);
  // timeline/playback.js runs the loop.
  //
  // While it plays she can't draw: a tap on the canvas stops it and is
  // swallowed whole. Anything that changes the project stops it first
  // and then acts (afterPlayback); tool, color, fps and loop picks
  // don't stop it. Stopping lands her on the frame that was showing —
  // a normal frame load — with the playing picture kept up until that
  // frame is on screen.
  const playbackFrames = createPlaybackFrames({
    canvasSize: project.canvas,
    readLayers: (id) => (frameCache.get(id) ?? frameCache.latest(id))?.blob ?? null,
    readPhoto: (ref) => readBitmap(ref),
  });
  let playStatus = { state: 'idle', ready: 0, total: 0 };
  // The move to the frame playback stopped on, while it runs.
  let landing = null;

  // Sound (step 5): the project's clip, decoded, and the audio clock
  // playback runs on when there is one (audio/audio.js). Decoding is
  // async; until it's done, Play shows "Getting ready".
  const audio = createAudio({
    // DEV ONLY (activity log): whether each run's sound really started.
    onEvent: (name, detail) => devLog.add(name, detail),
  });
  let soundLoading = null; // promise while any clip is being decoded
  // The current clips' decoded sound by blobRef (only theirs is kept),
  // and their waveforms' peaks (audio/peaks.js), worked out the first
  // time the panel shows a clip — never for a project whose panel
  // stays shut.
  const soundBuffers = new Map();
  const soundPeaks = new Map();
  const soundLoadingRefs = new Set();
  const soundFailed = new Set(); // files that wouldn't load; not retried
  // Recording (5c): the mic, the take in progress (see onMicDown), and
  // what the sound panel remembers while it's open.
  const recorder = createRecorder();
  let take = null;
  let micAllowed = false;      // the mic opened once this session
  let voiceOkRef = null;       // a Voice she may replace without asking
  let musicRetimeOk = false;   // she said the song may move under the Voice (this opening)
  // Listen / Set start (after 5c): { mode: 'listen' | 'set', startClip, raf }.
  let listen = null;
  let headphonesTipShown = false; // shown since the panel opened

  const playback = createPlayback({
    clock: audio.clock,
    decode: (id) => {
      const frame = session.frames.find((f) => f.id === id);
      return frame ? playbackFrames.decode(frame, { hidden: project.referenceHidden === true }) : null;
    },
    release: (value) => playbackFrames.release(value),
    show: (id, value) => {
      playbackFrames.draw(canvasApi.getPlaybackContext(), value);
      strip.setPlayhead(id);
      ui.sound.setPlayhead(project.frames.indexOf(id));
      noteTakeFrame();
    },
    pending: () => frameCache.pendingCount + (soundLoading ? 1 : 0),
    prepare: () => frameCache.rush(),
    onChange: (status) => {
      playStatus = status;
      // A recording's picture stopping (any way) ends the recording.
      if (status.state === 'idle' && take?.phase === 'recording') endTake('stopped');
      canvasApi.setPlaybackInput(status.state !== 'idle' || Boolean(take && take.phase !== 'finishing'));
      renderTransport();
      updateOnion();
    },
    onEnd: (id) => {
      devLog.add('end', { at: tag(id) });
      landOn(id);
    },
  });

  canvasApi.onPlaybackTap(() => {
    if (playback.active) devLog.add('tap-stop');
    interruptTake();
    stopPlayback();
  });

  function renderTransport() {
    const index = project.frames.indexOf(session.frame.id);
    ui.transport.render({
      playback: playStatus.state,
      ready: playStatus.ready,
      total: playStatus.total,
      fps: project.fps,
      loop: project.loop,
      canPrev: index > 0,
      canNext: index < project.frames.length - 1,
      busy: busy || Boolean(landing),
    });
    // The sound panel follows fps, frame count and playing too.
    renderSound();
  }

  function togglePlay() {
    if (take) {
      interruptTake(); // Play during a take only ends it
      return;
    }
    if (playback.active) {
      stopPlayback();
      return;
    }
    if (landing || !canAct() || adjust) return;
    if (project.frames.length < 2) {
      showBanner('Add another frame to play.');
      return;
    }
    const index = project.frames.indexOf(session.frame.id);
    // Without loop, playing from the last frame starts over.
    const startIndex = !project.loop && index === project.frames.length - 1 ? 0 : index;
    const sound = audio.hasSound ? 'on' : soundLoading ? 'loading' : 'off';
    devLog.add('play', { from: tag(project.frames[startIndex]), fps: project.fps, loop: project.loop, sound, ...(sound === 'off' ? {} : audio.debugState) });
    // iOS starts sound only from inside a tap: ask now, before getting
    // ready (the audio clock holds the first frame until it starts) —
    // even while the sound is still loading, since Play then waits for it.
    audio.unlock({ expectSound: Boolean(soundLoading) });
    playback.start({ ids: project.frames, startIndex, fps: project.fps, loop: project.loop });
  }

  // Stops playback (if it's on) and lands on `target` — by default the
  // frame that was showing; stopped while getting ready, she stays
  // where she was. Returns a promise for the landing.
  function stopPlayback(target) {
    if (!playback.active) return landing ?? Promise.resolve();
    const showing = playback.stop();
    devLog.add('stop', { showing: showing ? tag(showing) : null, target: target ? tag(target) : null });
    return landOn(target !== undefined ? target : showing);
  }

  function landOn(frameId) {
    const done = () => {
      strip.setPlayhead(null);
      ui.sound.setPlayhead(null);
      canvasApi.hidePlayback();
    };
    if (!frameId || frameId === session.frame.id || !project.frames.includes(frameId)) {
      done();
      return Promise.resolve();
    }
    devLog.add('land', { from: tag(session.frame.id), to: tag(frameId), busy });
    const move = exclusive(() => showFrame(frameId)).finally(() => {
      done();
      if (landing === move) landing = null;
      renderTransport();
      updateOnion();
    });
    landing = move;
    renderTransport();
    return move;
  }

  // Wraps an action so it stops playback first and runs once she's
  // landed (4b's "undo stops playback, then acts", for everything that
  // changes the project).
  function afterPlayback(action) {
    return (...args) => {
      interruptTake();
      if (playback.active) stopPlayback();
      if (landing) landing.then(() => action(...args));
      else action(...args);
    };
  }

  // Previous/next frame. While playing: stop and step from the frame
  // showing. No wrap-around.
  function stepFrame(delta) {
    if (take) {
      interruptTake();
      return;
    }
    const from = playback.active ? (playback.frameId ?? session.frame.id) : session.frame.id;
    const index = project.frames.indexOf(from) + delta;
    const target = project.frames[Math.max(0, Math.min(project.frames.length - 1, index))];
    if (playback.active) {
      stopPlayback(target);
      return;
    }
    if (landing) {
      landing.then(() => stepFrame(delta));
      return;
    }
    if (index < 0 || index >= project.frames.length) return;
    selectFrame(target);
  }

  // fps and loop are saved with the project and take effect at once,
  // even mid-play. Settings, not edits: not undoable.
  function setFps(fps) {
    const next = sanitizeFps(fps);
    if (next === project.fps) return;
    project.fps = next;
    playback.setFps(next);
    scheduleProjectSave();
    renderTransport();
  }

  function setLoop(loop) {
    project.loop = loop;
    playback.setLoop(loop);
    scheduleProjectSave();
    renderTransport();
  }

  // --- onion skin (4c) ---
  //
  // Ghosts of the frames around hers, from the frame cache's pictures
  // (layers only — never a frame's photo), tinted by side and fainter
  // further out (timeline/onion.js decides which; canvas/onion-view.js
  // draws them under her layers). Hidden while playing and while
  // landing. A ghost frame not flattened yet is left out until its
  // picture arrives; a stale one shows until it's rebuilt. Settings
  // are saved with the project, not undoable, and don't stop playback.
  const onionView = createOnionView({
    getContext: () => canvasApi.getOnionContext(),
    hide: () => canvasApi.hideOnion(),
    canDraw: () => !canvasApi.isBusy(),
  });
  onionView.setOpacity(project.onionSkin.opacity);
  ui.onion.render(project.onionSkin);

  function updateOnion() {
    if (playback.active || landing) {
      onionView.show(null);
      return;
    }
    const ghosts = [];
    for (const ghost of ghostFrames(project.frames, session.frame.id, project.onionSkin)) {
      const blob = (frameCache.get(ghost.id) ?? frameCache.latest(ghost.id))?.blob;
      if (blob) ghosts.push({ ...ghost, blob });
    }
    onionView.show(ghosts);
  }

  function setOnion(changes) {
    const next = sanitizeOnion({ ...project.onionSkin, ...changes });
    project.onionSkin = next;
    onionView.setOpacity(next.opacity);
    ui.onion.render(next);
    scheduleProjectSave();
    updateOnion();
  }

  // --- async work guard ---
  //
  // Adding, removing or bringing back a layer or frame, and moving to
  // another frame, touch storage, so they're async. While one runs,
  // undo/redo, panel and strip actions are ignored and the canvas takes
  // no new touches — nothing can land on pixels that are mid-change.
  // One at a time, in order.
  let busy = false;
  // Copy drawing's clipboard (4d; see copyDrawing below).
  let clipboard = null; // { rect, patch } from canvasApi.copyDrawing

  function refreshPanel() {
    panel.render({
      layers: project.layers,
      activeLayerId: project.activeLayerId,
      maxLayers: MAX_LAYERS,
      busy,
      canPaste: clipboard !== null,
    });
    strip.render({ frameIds: project.frames, currentId: session.frame.id, busy });
    ui.setAdjustBusy(busy);
    renderTransport();
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
    updateOnion();
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

  // Bytes last read or written per bitmapRef — only for the log, so a
  // save that shrinks a drawing stands out.
  const savedBytes = new Map(session.sizes ?? []);

  // --- canvases that lose their pixels (after 4c) ---
  //
  // iOS can empty a layer canvas without telling the page (seen on her
  // iPad). canvas.js notices on load (and swaps in a fresh canvas) and
  // before each save (checkLayer); here, a layer that failed the check
  // is reloaded from storage — the last save — onto a fresh canvas.
  // Strokes since that save are lost; her drawing isn't.
  let canvasTroubleShown = false; // one "reopen" notice until a clean load

  // DEV ONLY (activity log): what else was going on when the guard
  // fired, to test the memory theory. `canvases` is full-size canvases
  // in the page / all canvases in the page; offscreen ones (the
  // committed copy, flattening scratch) can't be counted from here.
  function guardContext() {
    const all = document.querySelectorAll('canvas');
    let full = 0;
    for (const c of all) {
      if (c.width >= project.canvas.width && c.height >= project.canvas.height) full += 1;
    }
    const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
    const cache = frameCache.memory;
    return {
      canvases: `${full}/${all.length}`,
      play: playback.state,
      onion: project.onionSkin.on ? 'on' : 'off',
      // Memory leads: undo's pixels (MB), the frame cache (frames/MB of
      // PNGs), and offscreen canvases not yet freed, app-wide.
      undo: mb(history.bytes),
      cache: `${cache.frames}/${mb(cache.bytes)}`,
      made: liveCanvasCount(),
    };
  }

  function reportCanvasLoad({ renewed, broken }) {
    if (renewed.length > 0) devLog.add('load-renewed', { frame: tag(session.frame.id), layers: renewed.map(short).join(','), ...guardContext() });
    if (broken.length > 0) {
      devLog.add('load-broken', { frame: tag(session.frame.id), layers: broken.map(short).join(','), ...guardContext() });
      if (!canvasTroubleShown) {
        canvasTroubleShown = true;
        showNotice("Parapara! can't show this frame's drawing right now. Your drawing is safe. Close Parapara! and open it again.");
      }
      return;
    }
    if (renewed.length > 0) showBanner("This frame's drawing stopped showing, so it was loaded again.");
    canvasTroubleShown = false;
  }

  // One recovery at a time; layers refused meanwhile join it. It waits
  // for a quiet moment (no stroke, no frame or layer change), and is
  // dropped if another frame loads first — that load checked it.
  let pendingRecovery = null; // { frameId, ids: Set }

  function recoverLayers(frameId, layerIds) {
    if (pendingRecovery?.frameId === frameId) {
      for (const id of layerIds) pendingRecovery.ids.add(id);
      return;
    }
    pendingRecovery = { frameId, ids: new Set(layerIds) };
    tryRecovery();
  }

  function tryRecovery() {
    const pending = pendingRecovery;
    if (!pending) return;
    if (closing || session.frame.id !== pending.frameId) {
      pendingRecovery = null;
      return;
    }
    if (!canAct()) {
      setTimeout(tryRecovery, 200);
      return;
    }
    pendingRecovery = null;
    exclusive(async () => {
      if (session.frame.id !== pending.frameId) return;
      const frame = session.frame;
      const ids = [...pending.ids].filter((id) => project.layers.some((l) => l.id === id));
      devLog.add('recover', { frame: tag(frame.id), layers: ids.map(short).join(','), ...guardContext() });
      canvasApi.renewLayers(ids);
      const result = { renewed: [], broken: [] };
      for (const id of ids) {
        unsavedLayers.delete(id);
        const blob = await readBitmap(frame.bitmapRefs[id]);
        const image = blob ? await createImageBitmap(blob) : null;
        const status = canvasApi.setLayerImage(id, image);
        image?.close?.();
        if (status === 'broken') result.broken.push(id);
        panel.refreshThumbnail(id);
      }
      frameCache.touch(frame.id);
      if (result.broken.length > 0) {
        reportCanvasLoad(result);
      } else {
        canvasTroubleShown = false;
        showNotice("This frame's drawing stopped showing, so it was loaded again from your last save. Your last stroke or two may be missing.");
      }
    });
  }

  // Checks every layer of the open frame (the app came back into view).
  function checkCanvases() {
    if (!canAct()) return;
    const bad = project.layers.map((l) => l.id).filter((id) => {
      const check = canvasApi.checkLayer(id);
      if (!check.ok) devLog.add('check-failed', { frame: tag(session.frame.id), layer: short(id), had: check.had, lost: check.lost, ...guardContext() });
      return !check.ok;
    });
    if (bad.length > 0) recoverLayers(session.frame.id, bad);
  }

  async function leaveFrame() {
    if (canSave) await autosaver.flush();
    for (const layerId of unsavedLayers) {
      // Never hold pixels from a canvas that lost them (see the guard).
      const check = canvasApi.checkLayer(layerId);
      if (!check.ok) {
        devLog.add('hold-refused', { frame: tag(session.frame.id), layer: short(layerId), had: check.had, lost: check.lost, ...guardContext() });
        continue;
      }
      const blob = await canvasApi.exportPNG(layerId);
      heldBitmaps.set(session.frame.bitmapRefs[layerId], blob);
      devLog.add('held', { frame: tag(session.frame.id), layer: short(layerId), bytes: blob.size });
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
    const sizes = new Map();
    const images = await decodeFrameImages(project.layers, next, readBitmap, sizes);
    for (const [ref, bytes] of sizes) savedBytes.set(ref, bytes);
    devLog.add('show', { from: tag(session.frame.id), to: tag(frameId), bytes: [...sizes.values()].join('/') });
    const reference = await decodeReference(next, readBitmap, canvasApi.getReferenceKey());

    session.frame = next;
    project.currentFrameId = next.id;
    const loaded = canvasApi.loadFrame({ layers: project.layers, activeLayerId: project.activeLayerId, images });
    for (const image of images.values()) image.close?.();
    reportCanvasLoad(loaded);
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
    devLog.add('frame-in', { frame: tag(frame.id) });
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
    devLog.add('frame-out', { frame: tag(id) });
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
  //   'frame-delete'  { record }  (4d) the same record, run the other way
  //   'frame-move'    { frameId, from, to }  (4d) timeline indexes
  //   'image'         { frameId, before, after }  (3a) frame.image
  //                   records (null = none); blobs stay in storage
  //   'image-all'     { frameId, before, after }  (3b) Use on all
  //                   frames: before = { [frameId]: image } for each
  //                   frame it changed, after = the image they got
  //   'audio'         { before, after }  (step 5) project.audioClips
  //                   lists; the sound files stay in storage
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
    devLog.add('layer-out', { layer: short(layerId), keptInMemory: Boolean(blob) });
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
    devLog.add('layer-in', { layer: short(layer.id) });
    let blob = record.blob;
    if (!blob && refs[session.frame.id]) blob = await readBitmap(refs[session.frame.id]);
    const image = blob ? await createImageBitmap(blob) : null;

    project.layers = insertLayer(project.layers, layer, index);
    setFrames(frames);
    project.activeLayerId = layer.id;
    canvasApi.syncLayers(project.layers);
    const status = canvasApi.setLayerImage(layer.id, image);
    image?.close?.();
    reportCanvasLoad({ renewed: status === 'renewed' ? [layer.id] : [], broken: status === 'broken' ? [layer.id] : [] });
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
    devLog.add(direction, {
      type: entry.type,
      frame: entry.frameId ? tag(entry.frameId) : entry.record?.frame ? tag(entry.record.frame.id) : null,
      layer: entry.layerId ? short(entry.layerId) : entry.record?.layer ? short(entry.record.layer.id) : null,
      at: tag(session.frame.id),
    });
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
      case 'frame-delete': {
        const remove = (entry.type === 'frame-add') === undoing;
        exclusive(() => (remove ? takeOutFrame(entry.record) : insertFrame(entry.record)));
        return entry;
      }
      case 'frame-move':
        applyFrameMove(entry.frameId, undoing ? entry.from : entry.to);
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
      case 'audio':
        exclusive(() => setClips(undoing ? entry.before : entry.after));
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
    devLog.add('stroke', { tool, frame: tag(session.frame.id), layer: short(layerId), rect: `${rect.w}x${rect.h}` });
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

  canvasApi.onGesture((name) => {
    devLog.add('gesture', name);
    if (name === 'undo') undo();
    else redo();
  });
  canvasApi.onDebug((event, details) => devLog.add(event, { frame: tag(session.frame.id), ...details }));

  canvasApi.onBlocked((reason) => {
    if (reason === 'broken') {
      showBanner("This layer's drawing can't be shown right now. Close Parapara! and open it again.");
      return;
    }
    showBanner(reason === 'locked'
      ? 'This layer is locked. Unlock it in Layers to draw on it.'
      : 'This layer is hidden. Show it in Layers to draw on it.');
  });

  // --- frame strip actions ---

  // While playing, any tile stops playback and lands there (4b).
  function selectFrame(id) {
    if (playback.active) {
      stopPlayback(id);
      return;
    }
    if (landing) {
      landing.then(() => selectFrame(id));
      return;
    }
    if (!canAct() || id === session.frame.id) return;
    exclusive(() => showFrame(id));
  }

  // A blank frame right after the current one, with a slot for every
  // layer; she's moved onto it. It keeps the reference image when
  // every frame shares one (inheritedImage). Undoable.
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

  // Delete (4d): the frame she's on, from the frame menu. No confirm —
  // it's undoable (undo puts it back where it was and shows it). Its
  // pixels stay in storage under its refs for undo; the launch sweep
  // clears them once that's moot. She lands on the frame before it.
  // The last frame can't be deleted.
  function deleteFrame() {
    if (!canAct() || project.frames.length <= 1) return;
    exclusive(async () => {
      const record = { frame: session.frame, index: -1 };
      await takeOutFrame(record);
      history.push({ type: 'frame-delete', record, bytes: 0 });
    });
  }

  // Reorder (4d): long-press and drag on the strip. Only the order
  // changes (project.frames); she stays on the frame she's on.
  function moveFrame(frameId, to) {
    if (!canAct()) return;
    const from = project.frames.indexOf(frameId);
    if (from < 0 || moveFrameId(project.frames, frameId, to) === project.frames) return;
    applyFrameMove(frameId, to);
    history.push({ type: 'frame-move', frameId, from, to, bytes: 0 });
  }

  // Frame 1 may change (the gallery thumbnail); the strip, the cache's
  // rebuild order and the onion ghosts follow in refreshPanel.
  function applyFrameMove(frameId, to) {
    project.frames = moveFrameId(project.frames, frameId, to);
    const byId = new Map(session.frames.map((f) => [f.id, f]));
    session.frames = project.frames.map((id) => byId.get(id));
    devLog.add('frame-move', { frame: tag(frameId), to });
    thumbnailStale = true;
    scheduleProjectSave();
    refreshPanel();
  }

  // Copy / paste drawing (4d; the layer menu): the active layer's
  // drawing on this frame, pasted onto whichever layer is active when
  // she pastes — another layer, another frame, or both — on top of
  // what's there. The clipboard is in memory, for this open project
  // only (dropped on close). Paste is one 'pixels' undo entry.
  // (clipboard is declared up with `busy`: refreshPanel reads it.)

  function copyDrawing() {
    if (!canAct()) return;
    const layerId = project.activeLayerId;
    const layer = project.layers.find((l) => l.id === layerId);
    // A canvas iOS emptied would copy blank: recover it instead.
    const check = canvasApi.checkLayer(layerId);
    if (!check.ok) {
      devLog.add('check-failed', { frame: tag(session.frame.id), layer: short(layerId), had: check.had, lost: check.lost, ...guardContext() });
      recoverLayers(session.frame.id, [layerId]);
      return;
    }
    const copied = canvasApi.copyDrawing();
    if (!copied) {
      showBanner(`${layer?.name ?? 'This layer'} has nothing to copy on this frame.`);
      return;
    }
    clipboard = copied;
    devLog.add('copy-drawing', { frame: tag(session.frame.id), layer: short(layerId), rect: `${copied.rect.w}x${copied.rect.h}` });
    showBanner(`Copied ${layer?.name ?? 'the layer'}'s drawing. Tap the layer to paste into (on any frame), then Paste.`);
    refreshPanel();
  }

  // Refused for a locked or hidden layer, with wording for pasting (the
  // canvas would refuse too, but its banner talks about drawing).
  function pasteDrawing() {
    if (!canAct() || !clipboard) return;
    const layer = project.layers.find((l) => l.id === project.activeLayerId);
    if (layer?.locked) {
      showBanner('This layer is locked. Unlock it in Layers to paste on it.');
      return;
    }
    if (layer && !layer.visible) {
      showBanner('This layer is hidden. Show it in Layers to paste on it.');
      return;
    }
    devLog.add('paste-drawing', { frame: tag(session.frame.id), layer: short(project.activeLayerId) });
    canvasApi.pasteDrawing(clipboard);
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
    devLog.add('copy', { pairs: pairs.length, stored: stored.length, held: pairs.length - stored.length });
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
    renderSound();
  }

  // Ends adjust mode and records what changed, as one undo step.
  function finishAdjust() {
    if (!adjust) return;
    const { frameId, before } = adjust;
    adjust = null;
    canvasApi.setAdjusting(false);
    ui.setAdjusting(false);
    ui.setHistoryState(history.canUndo, history.canRedo);
    renderSound();
    const key = canvasApi.getReferenceKey();
    const after = key ? { blobRef: key, ...canvasApi.getReferencePlacement() } : null;
    if (sameImage(before, after)) return;
    const frame = session.frames.find((f) => f.id === frameId);
    if (!frame) return;
    frame.image = after;
    devLog.add('image', { frame: tag(frameId), photo: after ? short(after.blobRef) : null });
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

  // --- sound (step 5) ---
  //
  // Two rows (5c): one Music clip (imported) and one Voice clip
  // (recorded), in project.audioClips (rules in audio/clip.js). A file
  // is stored exactly as picked or recorded (saveAudioBlob) before the
  // project points at it, then decoded for playback. Import (Replace),
  // a recording, Delete and each trim or move in the sound panel are one
  // 'audio' undo entry each (whole clip lists); files stay in storage
  // for undo, and the sweep clears them once nothing points at them.
  // Only the current clips' decoded sound is kept in memory.

  // Puts the project's clips on the audio engine, decoding any file not
  // decoded yet. A file that's missing or won't decode is skipped with
  // a banner — never a failed open — and its record is kept. Resolves
  // once every clip's sound is ready (or has failed).
  function loadSound() {
    const refs = new Set(project.audioClips.map((c) => c.blobRef));
    for (const ref of [...soundBuffers.keys()]) if (!refs.has(ref)) soundBuffers.delete(ref);
    for (const ref of [...soundPeaks.keys()]) if (!refs.has(ref)) soundPeaks.delete(ref);
    applyClips();
    const missing = project.audioClips.filter((c) => !soundBuffers.has(c.blobRef)
      && !soundFailed.has(c.blobRef) && !soundLoadingRefs.has(c.blobRef));
    if (missing.length === 0) return soundLoading ?? Promise.resolve();
    const loading = Promise.all([soundLoading, ...missing.map((clip) => loadClipSound(clip))]).then(() => {});
    soundLoading = loading;
    loading.finally(() => {
      if (soundLoading === loading) soundLoading = null;
      renderSound();
    });
    renderSound();
    return loading;
  }

  async function loadClipSound(clip) {
    soundLoadingRefs.add(clip.blobRef);
    try {
      const blob = await readBitmap(clip.blobRef);
      if (!blob) throw new Error('The sound file is missing');
      const decoded = audio.keepFirst(await audio.decode(await blob.arrayBuffer()), MAX_CLIP_SECONDS);
      // Gone while decoding (undo, a replace): not needed any more.
      if (!project.audioClips.some((c) => c.blobRef === clip.blobRef)) return;
      soundBuffers.set(clip.blobRef, decoded);
      applyClips();
    } catch (err) {
      soundFailed.add(clip.blobRef);
      console.warn('Parapara! could not load the sound:', err);
      devLog.add('sound-failed', { sound: short(clip.blobRef), kind: clip.kind, error: String(err?.message ?? err) });
      showBanner(clip.kind === 'voice'
        ? "This animation's voice recording couldn't be played."
        : "This animation's sound couldn't be played.");
    } finally {
      soundLoadingRefs.delete(clip.blobRef);
    }
  }

  // The engine plays whichever clips are decoded.
  function applyClips() {
    audio.setClips(project.audioClips.map((clip) => ({ clip, buffer: soundBuffers.get(clip.blobRef) ?? null })));
  }

  // The project's clips are now `clips`: saved, shown on the button,
  // and loaded for playback. Resolves once the sound is ready.
  function setClips(clips) {
    project.audioClips = clips;
    scheduleProjectSave();
    refreshPanel();
    return loadSound();
  }

  // A picked file becomes the Music (replacing any; the Voice is left
  // alone). Size is checked before reading; it's accepted only if this
  // device can decode it — so playback (and step 6's export) can always
  // read what was stored. A file longer than MAX_CLIP_SECONDS keeps only
  // its start (the whole file is stored).
  function importSound(file) {
    if (busy) return;
    const size = checkImportSize(file.size);
    if (size === 'too-big') {
      showBanner('That sound file is too big. Sound files can be up to 20 MB.');
      return;
    }
    if (size === 'empty') {
      showNotice("That sound couldn't be opened. Try a different file.");
      return;
    }
    exclusive(async () => {
      let bytes;
      let decoded;
      try {
        bytes = await file.arrayBuffer();
        // Decoding may detach the buffer it's given: decode a copy and
        // store the original bytes.
        decoded = await audio.decode(bytes.slice(0));
      } catch (err) {
        console.warn('Parapara! could not read the picked sound:', err);
        devLog.add('sound-refused', { type: file.type || '?', bytes: file.size });
        showNotice("That sound couldn't be opened. Try a different file.");
        return;
      }
      const blob = new Blob([bytes], { type: soundType(file) });
      const blobRef = newId();
      if (!(await storeSoundBlob(blobRef, blob))) {
        showNotice("That sound couldn't be added. The iPad may be out of space.");
        return;
      }
      const { clip, clipped } = newClip({ id: newId(), blobRef, duration: decoded.duration, kind: 'music' });
      soundBuffers.set(blobRef, audio.keepFirst(decoded, MAX_CLIP_SECONDS));
      const before = project.audioClips;
      await setClips(withClip(before, 'music', clip));
      history.push({ type: 'audio', before, after: project.audioClips, bytes: 0 });
      devLog.add('sound', { sound: short(blobRef), type: blob.type, bytes: blob.size, seconds: Math.round(decoded.duration) });
      showBanner(clipped
        ? 'Sound added. Only its first 3 minutes are used.'
        : 'Sound added. Press Play to hear it with your animation.');
    });
  }

  // Stores a sound file before anything points at it. False if it
  // couldn't be saved.
  async function storeSoundBlob(blobRef, blob) {
    if (!canSave) {
      heldBitmaps.set(blobRef, blob);
      return true;
    }
    try {
      await saveAudioBlob(project.id, blobRef, blob);
      return true;
    } catch (err) {
      console.error('Parapara! saving a sound failed:', err);
      return false;
    }
  }

  // --- the mixer and listening (after 5c) ---

  // A row's volume slider let go: one 'audio' undo step. Allowed while
  // playing — she mixes by ear (the bus already followed the slider).
  function commitVolume(kind, volume) {
    const clip = clipOfKind(project.audioClips, kind);
    if (!clip || busy || adjust) {
      audio.setVolume(kind, clip ? clipVolume(clip) : 1); // refused: back to the saved level
      renderSound();
      return;
    }
    const before = project.audioClips;
    const after = withClip(before, kind, withVolume(clip, volume));
    if (sameClips(before, after)) return;
    project.audioClips = after;
    scheduleProjectSave();
    applyClips();
    renderSound();
    history.push({ type: 'audio', before, after, bytes: 0 });
    devLog.add('sound-volume', { kind, volume: clipVolume(clipOfKind(after, kind)).toFixed(2) });
  }

  // Moving the song when there's a Voice take puts them out of time
  // (the take was recorded against the song as it was): asks first,
  // once per panel opening. False while asking — the touch or tap that
  // asked does nothing; she does it again after (like the mic's popups).
  function canRetimeMusic(then) {
    if (musicRetimeOk || !clipOfKind(project.audioClips, 'voice')) return true;
    showConfirm({
      title: 'Move the song?',
      message: 'Your voice was recorded with the song where it is now. Moving the song will put them out of time.',
      confirmLabel: 'Move it',
    }).then((yes) => {
      if (!yes) return;
      musicRetimeOk = true;
      showBanner(then);
    });
    return false;
  }

  // Listen ('listen') or Set start ('set'): the song alone from the
  // part's start. Runs inside the tap (iOS starts sound only there).
  function startListen(mode) {
    if (playback.active || landing) {
      stopPlayback(); // like Import: a tap while playing only stops
      return;
    }
    if (listen) finishListen('switch');
    if (take || !canAct() || adjust) return;
    const clip = clipOfKind(project.audioClips, 'music');
    if (!clip || !soundBuffers.get(clip.blobRef)) return;
    if (mode === 'set' && !canRetimeMusic('Tap Set start again.')) return;
    audio.unlock();
    const started = audio.listen({ kind: 'music', from: clip.trimStart, onEnd: () => finishListen('end') });
    if (!started) return;
    listen = { mode, startClip: clip, raf: 0 };
    devLog.add('listen', { mode, from: clip.trimStart.toFixed(2), ...audio.debugState });
    const step = () => {
      if (!listen) return;
      ui.sound.setListening(listenState());
      listen.raf = requestAnimationFrame(step);
    };
    step();
  }

  // Set start: the Music clip with its start where she's listening.
  function movedStart(position) {
    const buffer = soundBuffers.get(listen.startClip.blobRef);
    return slipClip(listen.startClip, position - listen.startClip.trimStart, {
      duration: buffer ? buffer.duration : listen.startClip.trimEnd,
      minLength: minClipSeconds(project.fps),
    });
  }

  function listenState() {
    const position = audio.listenPosition() ?? listen.startClip.trimStart;
    return { mode: listen.mode, position, clip: listen.mode === 'set' ? movedStart(position) : null };
  }

  // Stops listening. For Set start, wherever it stopped is the new start
  // (one undo step) — however it stopped, except the editor closing.
  function finishListen(why) {
    if (!listen) return;
    const current = listen;
    const position = audio.listenPosition();
    cancelAnimationFrame(current.raf);
    audio.stopListening();
    let moved = null;
    if (current.mode === 'set' && position !== null && why !== 'destroy') moved = movedStart(position);
    listen = null;
    ui.sound.setListening(null);
    devLog.add('listen-stop', { mode: current.mode, why, at: position === null ? '-' : position.toFixed(2) });
    if (moved) changeClip('music', moved);
  }

  // A trim or move in the sound panel (5b): one 'audio' undo step per
  // drag. The decoded sound is the same, so nothing reloads.
  function changeClip(kind, clip) {
    if (!canAct() || adjust || playback.active || landing || take) return;
    const before = project.audioClips;
    const after = withClip(before, kind, clip);
    if (sameClips(before, after)) return;
    setClips(after);
    history.push({ type: 'audio', before, after, bytes: 0 });
    devLog.add('sound-edit', {
      kind,
      trim: `${clip.trimStart.toFixed(2)}-${clip.trimEnd.toFixed(2)}`,
      at: clip.offset.toFixed(2),
    });
  }

  // One row of the sound panel: its clip, decoded length and peaks
  // (once loaded). Peaks are worked out the first time the panel shows
  // a clip — never for a project whose panel stays shut.
  function soundRow(kind) {
    const clip = clipOfKind(project.audioClips, kind);
    if (!clip) return { clip: null, duration: 0, peaks: null, loading: false };
    const buffer = soundBuffers.get(clip.blobRef) ?? null;
    if (buffer && ui.sound.isOpen && !soundPeaks.has(clip.blobRef)) {
      const channels = [];
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch));
      soundPeaks.set(clip.blobRef, computePeaks(channels, buffer.sampleRate));
    }
    return {
      clip,
      duration: buffer ? buffer.duration : 0,
      peaks: buffer ? soundPeaks.get(clip.blobRef) ?? null : null,
      loading: soundLoadingRefs.has(clip.blobRef),
    };
  }

  // The sound panel's state: both rows, what limits editing, and the
  // recording in progress.
  function renderSound() {
    ui.sound.render({
      music: soundRow('music'),
      voice: soundRow('voice'),
      fps: project.fps,
      frameCount: project.frames.length,
      busy: busy || Boolean(adjust),
      playing: playback.active || Boolean(landing),
      recording: take && take.phase !== 'finishing'
        ? { phase: take.phase === 'recording' ? 'recording' : 'countdown', startIndex: take.startIndex }
        : null,
      canRecord: recorder.supported,
    });
  }

  // Delete a row (sound panel). Undoable; the file stays for undo.
  function deleteSound(kind) {
    if (!canAct() || adjust || take) return;
    const before = project.audioClips;
    if (!clipOfKind(before, kind)) return;
    setClips(withClip(before, kind, null));
    history.push({ type: 'audio', before, after: project.audioClips, bytes: 0 });
    devLog.add('sound-deleted', { kind });
    showBanner(kind === 'voice' ? 'Voice deleted.' : 'Sound deleted.');
  }

  // --- recording (5c) ---
  //
  // Hold the mic (sound panel): a 3-second countdown, silent, with the
  // mic opening meanwhile; then the recorder starts, and once it has,
  // playback runs from her frame without looping, the Music playing and
  // the old Voice silent. Letting go — or any other touch, the last
  // frame, the 3-minute cap, hiding the app — ends it, and the take
  // becomes the Voice (one 'audio' undo entry). Letting go during the
  // countdown records nothing.
  //
  // take = {
  //   phase: 'countdown' | 'starting' | 'recording' | 'finishing',
  //   startIndex, fps, held, count, timer, capTimer,
  //   stream (once open), opening (open()'s promise), opened (bool),
  //   startedAt (when the recorder began, performance.now()),
  //   anchor (performance.now() at the animation's time 0 of the run),
  //   stopRequested }
  //
  // Before a hold starts, two popups may stand in its way (each
  // interrupts the hold; she holds again after): replacing a Voice not
  // recorded since the panel opened asks first; recording with Music
  // shows the headphones tip once per panel opening.
  function onMicDown() {
    if (playback.active || landing) {
      stopPlayback(); // like Import: a press while playing only stops
      return;
    }
    if (take || !canAct() || adjust || !recorder.supported) return;
    if (project.frames.length < 2) {
      showBanner('Add another frame to record.');
      return;
    }
    const voice = clipOfKind(project.audioClips, 'voice');
    if (voice && voice.blobRef !== voiceOkRef) {
      showConfirm({
        title: 'Replace the voice?',
        message: "Recording will replace this animation's voice recording. You can undo it while this animation is open.",
        confirmLabel: 'Replace',
      }).then((yes) => {
        if (!yes) return;
        voiceOkRef = voice.blobRef;
        showBanner('Hold the mic to record.');
      });
      return;
    }
    const hasMusic = Boolean(clipOfKind(project.audioClips, 'music'));
    if (hasMusic && !uiState.hideHeadphonesTip && !headphonesTipShown) {
      headphonesTipShown = true;
      showConfirm({
        title: 'Use headphones',
        message: 'Use headphones when you record over music, or the song gets recorded too.',
        confirmLabel: 'Got it',
        cancelLabel: "Don't show again",
        dismissConfirms: true,
      }).then((gotIt) => {
        audio.unlock({ expectSound: true }); // still inside the tap
        if (!gotIt) setUiState({ hideHeadphonesTip: true });
        showBanner('Hold the mic to record.');
      });
      return;
    }
    startTake();
  }

  function startTake() {
    const index = project.frames.indexOf(session.frame.id);
    // From the last frame there's nothing to record over: start over.
    const startIndex = index >= project.frames.length - 1 ? 0 : index;
    // Inside the press: iOS starts sound only from a touch.
    audio.unlock({ expectSound: Boolean(soundLoading) });
    setMicMode(true, 'hold');
    const current = {
      phase: 'countdown',
      startIndex,
      fps: project.fps,
      held: true,
      count: COUNTDOWN_SECONDS,
      timer: 0,
      capTimer: 0,
      stream: null,
      opened: false,
      startedAt: 0,
      anchor: null,
      stopRequested: false,
    };
    take = current;
    devLog.add('rec-hold', { from: tag(project.frames[startIndex]), fps: project.fps });
    canvasApi.setPlaybackInput(true); // a canvas touch during the countdown only cancels
    ui.countdown.show(current.count);
    current.timer = setTimeout(tick, 1000);
    renderSound();
    renderTransport();

    current.opening = recorder.open().then((stream) => {
      micAllowed = true;
      if (take !== current || current.phase === 'finishing') {
        recorder.close(stream);
        // Opened after the hold was let go: back to playback now that
        // it's closed (unless another hold has started).
        if (!take) setMicMode(false, 'late-close');
        return null;
      }
      current.stream = stream;
      current.opened = true;
      return stream;
    }, (err) => {
      const why = micError(err);
      devLog.add('rec-mic-failed', { why, error: String(err?.name ?? err) });
      if (take === current) cancelTake('mic');
      if (!take) setMicMode(false, 'mic-failed'); // no mic to wait for
      if (why === 'denied') {
        showNotice("Parapara! can't use the microphone. To record, allow the microphone for Parapara! in the iPad's Settings.");
      } else if (why === 'no-mic') {
        showNotice('No microphone was found.');
      } else {
        showNotice("The microphone couldn't be started. Try again.");
      }
      return null;
    });

    function tick() {
      if (take !== current || current.phase !== 'countdown') return;
      current.count -= 1;
      if (current.count > 0) {
        ui.countdown.show(current.count);
        current.timer = setTimeout(tick, 1000);
        return;
      }
      beginRecording(current);
    }
  }

  // The countdown ended with the mic still held: start the recorder,
  // then the picture.
  async function beginRecording(current) {
    current.phase = 'starting';
    ui.countdown.hide();
    const stream = await current.opening;
    if (take !== current || !stream) return;
    if (current.stopRequested) {
      cancelTake('released');
      return;
    }
    let started;
    try {
      started = await recorder.start(stream);
    } catch (err) {
      devLog.add('rec-failed', { error: String(err?.message ?? err) });
      if (take === current) cancelTake('failed');
      showNotice("The recording couldn't be started. Try again.");
      return;
    }
    if (take !== current) {
      recorder.stop();
      return;
    }
    current.startedAt = started.startedAt;
    current.phase = 'recording';
    // Switching to record mode may have paused the sound (its music):
    // ask it to run. The log says how it stood and what the mic got.
    audio.wake();
    devLog.add('rec-start', { ...audio.debugState, ...micSettings(stream) });
    renderSound();
    if (current.stopRequested) {
      endTake('released');
      return;
    }
    playback.start({
      ids: project.frames,
      startIndex: current.startIndex,
      fps: current.fps,
      loop: false,
      skip: ['voice'],
    });
    // The 3-minute cap (MAX_CLIP_SECONDS), from the first frame.
    current.capTimer = setTimeout(() => endTake('cap'), MAX_CLIP_SECONDS * 1000 + 2000);
  }

  // Playback showed a frame during a take: the first one fixes where the
  // animation's time 0 is on the wall clock (what she sees and hears).
  function noteTakeFrame() {
    if (take?.phase === 'recording' && take.anchor === null) {
      take.anchor = performance.now() - audio.clock.now();
    }
  }

  // The mic was let go (or the touch was taken away).
  function onMicUp({ cancelled } = {}) {
    const current = take;
    if (!current) return;
    current.held = false;
    if (current.phase === 'countdown') {
      // A system prompt (the first mic request) takes the touch away:
      // say so once she's answered, rather than "keep holding".
      cancelTake(cancelled && !micAllowed ? 'prompt' : 'released');
    } else if (current.phase === 'starting') {
      current.stopRequested = true;
    } else if (current.phase === 'recording') {
      endTake('released');
    }
  }

  // Anything else she does during a take ends it: during the countdown
  // nothing is kept; once recording, the take is.
  function interruptTake() {
    if (!take) return;
    if (take.phase === 'countdown') cancelTake('interrupted');
    else if (take.phase === 'starting') take.stopRequested = true;
    else if (take.phase === 'recording') endTake('interrupted');
  }

  // Ends a take that isn't recording yet: nothing is kept.
  function cancelTake(reason) {
    const current = take;
    if (!current) return;
    take = null;
    clearTimeout(current.timer);
    clearTimeout(current.capTimer);
    ui.countdown.hide();
    devLog.add('rec-cancel', { reason });
    if (current.stream) recorder.close(current.stream);
    const closing = recorder.recording ? recorder.stop() : null;
    // Back to playback once the mic is closed. A stream still opening
    // is closed (and switched back) when it arrives (startTake).
    if (closing) closing.finally(() => { if (!take) setMicMode(false, 'cancel'); });
    else if (current.stream || current.opened) setMicMode(false, 'cancel');
    else if (!current.opening) setMicMode(false, 'cancel');
    canvasApi.setPlaybackInput(playStatus.state !== 'idle');
    if (reason === 'released' || reason === 'interrupted') {
      showBanner('Keep holding until the countdown ends.');
    } else if (reason === 'prompt') {
      current.opening?.then((stream) => {
        if (micAllowed) showBanner('The microphone is on. Hold the mic again to record.');
        return stream;
      });
    }
    renderSound();
    renderTransport();
  }

  // Ends a recording: stops the recorder and the picture (she lands on
  // the frame showing, as after playback), then keeps the take. Actions
  // tapped meanwhile wait for it (they wait on `landing`).
  function endTake(reason) {
    const current = take;
    if (!current || current.phase !== 'recording') return;
    current.phase = 'finishing';
    clearTimeout(current.capTimer);
    const stopped = recorder.stop();
    devLog.add('rec-stop', { reason });
    // Back to playback only once the recorder has stopped and closed the
    // mic — switching earlier left the first loops in record mode's
    // quieter output on her iPad.
    stopped.finally(() => { if (!take || take === current) setMicMode(false, 'take-end'); });
    if (playback.active) stopPlayback();
    // After the current call stack, so a landing started by whoever
    // stopped playback is the one this waits for.
    queueMicrotask(() => {
      const moved = landing ?? Promise.resolve();
      const saving = moved
        .then(() => stopped)
        .then((blob) => keepTake(current, blob))
        .catch((err) => {
          console.error('Parapara! keeping a recording failed:', err);
          showNotice("That recording couldn't be kept.");
        })
        .finally(() => {
          if (take === current) take = null;
          if (landing === saving) landing = null;
          canvasApi.setPlaybackInput(playStatus.state !== 'idle');
          renderSound();
          renderTransport();
        });
      landing = saving;
      renderTransport();
    });
  }

  // The finished take becomes the Voice (replacing any), as one undo
  // step. The lead-in before the first frame is cut (recordedClip).
  async function keepTake(current, blob) {
    if (!blob || current.anchor === null) {
      showBanner('Nothing was recorded. Hold the mic until the animation starts.');
      return;
    }
    const leadIn = (current.anchor - current.startedAt) / 1000;
    await exclusiveTask(async () => {
      let decoded;
      const bytes = await blob.arrayBuffer();
      try {
        decoded = await audio.decode(bytes.slice(0));
      } catch (err) {
        devLog.add('rec-refused', { type: blob.type, bytes: blob.size, error: String(err?.message ?? err) });
        showNotice("That recording couldn't be played, so it wasn't kept.");
        return;
      }
      const blobRef = newId();
      const placed = {
        id: newId(),
        blobRef,
        duration: decoded.duration,
        leadIn,
        offset: timeAtFrame(current.startIndex, current.fps),
        minLength: minClipSeconds(current.fps),
      };
      let clip = recordedClip(placed);
      // Level the take by its speech's loudness in the part that plays
      // (loudnessGain; after 5c — peak leveling left takes quieter than
      // the music). It plays through a compressor (audio.js).
      const peak = clip ? loudest(decoded, clip.trimStart, clip.trimEnd) : 0;
      const loudness = clip ? speechLoudness(channelsOf(decoded), decoded.sampleRate, clip.trimStart, clip.trimEnd) : 0;
      if (clip) clip = recordedClip({ ...placed, gain: loudnessGain({ loudness, peak }), leveling: 'loudness' });
      if (!clip) {
        showBanner('That was too short to keep. Hold the mic a little longer.');
        return;
      }
      const stored = new Blob([bytes], { type: blob.type || 'audio/mp4' });
      if (!(await storeSoundBlob(blobRef, stored))) {
        showNotice("That recording couldn't be kept. The iPad may be out of space.");
        return;
      }
      soundBuffers.set(blobRef, audio.keepFirst(decoded, MAX_CLIP_SECONDS));
      voiceOkRef = blobRef; // a retake replaces it without asking
      musicRetimeOk = false; // the new take is in time with the song as it is
      const before = project.audioClips;
      await setClips(withClip(before, 'voice', clip));
      history.push({ type: 'audio', before, after: project.audioClips, bytes: 0 });
      devLog.add('recorded', {
        sound: short(blobRef), type: stored.type, bytes: stored.size,
        seconds: (clip.trimEnd - clip.trimStart).toFixed(2), leadIn: leadIn.toFixed(3),
        peak: peak.toFixed(3), loudness: loudness.toFixed(3), gain: (clip.gain ?? 1).toFixed(2),
      });
      showBanner('Voice recorded.');
    });
  }

  // The audio session's mode for the mic (see audio.setRecording), with
  // a log line: iOS plays quieter in record mode, and the switch back
  // seems to wait for the mic to close (her voice got louder after a
  // loop or two), so when each switch happens matters.
  function setMicMode(on, why) {
    audio.setRecording(on);
    devLog.add('rec-session', { mode: on ? 'record' : 'playback', why, ...audio.debugState });
  }

  function channelsOf(buffer) {
    const channels = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch));
    return channels;
  }

  // The loudest sample (any channel) between `from` and `to` seconds.
  function loudest(buffer, from, to) {
    const rate = buffer.sampleRate;
    const start = Math.max(0, Math.floor(from * rate));
    let max = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      const end = Math.min(data.length, Math.ceil(to * rate));
      for (let i = start; i < end; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > max) max = v;
      }
    }
    return max;
  }

  // exclusive() skips a task while something else runs; a take must
  // not be dropped, so it waits its turn.
  async function exclusiveTask(task) {
    while (busy) await new Promise((resolve) => setTimeout(resolve, 50));
    return exclusive(task);
  }

  // DEV ONLY (5c): how late a sound she hears lands in a recording —
  // the number for MIC_DELAY_SECONDS. Plays three clicks 0.4 s apart,
  // starting 0.6 s after the recorder starts, and finds each in the file
  // as a jump above the room's noise (measured in the first 0.3 s): the
  // mic records quietly, so no fixed level would do (her first runs
  // missed a click at 0.04). Starts the sound inside the tap (gear
  // menu), so it isn't wrapped in afterPlayback.
  async function devMicDelayTest() {
    if (playback.active) stopPlayback();
    if (take || busy || !recorder.supported) return;
    const ctx = audio.context;
    if (!ctx) {
      showNotice('Mic delay test: no Web Audio here.');
      return;
    }
    const CLICKS = [0.6, 1.0, 1.4];
    setMicMode(true, 'mic-test');
    ctx.resume?.()?.catch?.(() => {});
    let stream = null;
    try {
      stream = await recorder.open();
      const mic = micSettings(stream);
      const { startedAt } = await recorder.start(stream);
      stream = null;
      // Record mode may have paused the sound: wait (briefly) for it.
      audio.wake();
      const waitFrom = performance.now();
      while (ctx.state !== 'running' && performance.now() - waitFrom < 1500) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const ctxState = ctx.state;
      const rate = ctx.sampleRate;
      const click = ctx.createBuffer(1, Math.round(rate * 0.03), rate);
      const data = click.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 1000 * i) / rate) > 0 ? 0.9 : -0.9;
      // Each click's time on the page's clock, from when it's scheduled
      // (+ the output delay, if Safari reports one).
      const now = performance.now();
      const base = ctx.currentTime;
      const out = ctx.outputLatency || ctx.baseLatency || 0;
      const sinceStart = (now - startedAt) / 1000;
      const heard = [];
      for (const at of CLICKS) {
        const when = base + Math.max(0, at - sinceStart);
        const source = ctx.createBufferSource();
        source.buffer = click;
        source.connect(ctx.destination);
        source.start(when);
        heard.push(now + (when - base + out) * 1000);
      }
      await new Promise((resolve) => setTimeout(resolve, (CLICKS.at(-1) + 0.8) * 1000));
      const blob = await recorder.stop();
      if (!blob) throw new Error('nothing was recorded');
      const decoded = await audio.decode(await blob.arrayBuffer());
      const samples = decoded.getChannelData(0);
      const fileRate = decoded.sampleRate;
      // Noise: the loudest of the first 0.3 s (before any click).
      let noise = 0;
      for (let i = 0; i < Math.min(samples.length, fileRate * 0.3); i++) noise = Math.max(noise, Math.abs(samples[i]));
      const threshold = Math.max(noise * 3, 0.004);
      // Each click: the first sample above the threshold, searching in
      // order from just past the previous find (the delay is unknown,
      // so there's no window to look in).
      const results = [];
      let from = Math.floor(fileRate * 0.3);
      for (let k = 0; k < CLICKS.length; k++) {
        let i = from;
        while (i < samples.length && Math.abs(samples[i]) < threshold) i++;
        if (i >= samples.length) break;
        let level = 0;
        for (let j = i; j < Math.min(samples.length, i + fileRate * 0.03); j++) level = Math.max(level, Math.abs(samples[j]));
        const found = i / fileRate;
        const expected = (heard[k] - startedAt) / 1000;
        results.push({ ms: Math.round((found - expected) * 1000), found, level });
        from = i + Math.floor(fileRate * 0.15); // past this click
      }
      const detail = {
        ctx: ctxState,
        out: Math.round(out * 1000),
        noise: noise.toFixed(4),
        ...mic,
        clicks: results.map((r) => `${r.ms}ms@${r.found.toFixed(3)}/${r.level.toFixed(3)}`).join(' ') || 'none',
        type: blob.type,
      };
      devLog.add('mic-delay', detail);
      if (results.length < CLICKS.length) {
        showNotice(`Mic delay test: heard ${results.length} of ${CLICKS.length} clicks (sound was ${ctxState}). Volume up, no headphones, quiet room, and try again.`);
        return;
      }
      const spread = Math.max(...results.map((r) => r.ms)) - Math.min(...results.map((r) => r.ms));
      showNotice(`Mic delay: ${results.map((r) => r.ms).join(', ')} ms${spread > 40 ? ' (uneven — run it again)' : ''}. The details are in the activity log.`);
    } catch (err) {
      if (stream) recorder.close(stream);
      if (recorder.recording) recorder.stop();
      devLog.add('mic-delay', { result: 'failed', error: String(err?.name ?? err?.message ?? err) });
      showNotice(`Mic delay test failed: ${err?.message ?? err}`);
    } finally {
      setMicMode(false, 'mic-test');
    }
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
    devLog.add('clear', { frame: tag(session.frame.id), layer: short(id) });
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
    devLog.add('layer-prop', { layer: short(id), opacity: after });
    applyLayerChanges(id, { opacity: after });
    history.push({
      type: 'layer-props', layerId: id, before: { opacity: before }, after: { opacity: after }, bytes: 0,
    });
  }

  // Visibility and lock aren't undoable — view state, as in Photoshop.
  function toggleLayerProp(id, prop) {
    if (busy) return;
    const layer = project.layers.find((l) => l.id === id);
    if (layer) {
      devLog.add('layer-prop', { layer: short(id), [prop]: !layer[prop] });
      applyLayerChanges(id, { [prop]: !layer[prop] });
    }
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
  reportCanvasLoad(openLoad);

  if (!canSave) {
    showNotice("Saving isn't working right now, so drawings won't be kept.");
    return;
  }

  autosaver = createAutosaver({
    save: async () => {
      const layerIds = [...unsavedLayers];
      unsavedLayers.clear();
      // Which frame these pixels belong to is settled *before* any
      // await: every layer is exported in this same tick (toBlob copies
      // the pixels when it's called), and each goes to the ref of the
      // frame it was exported from — never to whatever frame is open by
      // the time the encode finishes.
      //
      // The save guard (after 4c): a layer whose canvas has lost ink
      // outside the areas she edited is never saved — iOS emptied it,
      // and saving would write blank over her drawing. It's reloaded
      // from storage instead (recoverLayers).
      const frame = session.frame;
      const refused = [];
      const exports = [];
      for (const layerId of layerIds) {
        const check = canvasApi.checkLayer(layerId);
        if (!check.ok) {
          refused.push(layerId);
          devLog.add('save-refused', { frame: tag(frame.id), layer: short(layerId), had: check.had, lost: check.lost, ...guardContext() });
          continue;
        }
        const encoding = canvasApi.exportPNG(layerId);
        encoding.catch(() => {}); // a failure is handled where it's awaited
        exports.push({ layerId, ref: frame.bitmapRefs[layerId], blob: encoding });
      }
      if (refused.length > 0) recoverLayers(frame.id, refused);
      try {
        for (const { layerId, ref, blob: encoding } of exports) {
          const blob = await encoding;
          await saveLayerBitmap(project.id, ref, blob);
          devLog.add('save', { frame: tag(frame.id), layer: short(layerId), bytes: blob.size, was: savedBytes.get(ref) ?? '?' });
          savedBytes.set(ref, blob.size);
        }
        if (session.frame.id !== frame.id) devLog.add('save-note', 'frame changed during save');
      } catch (err) {
        devLog.add('save-failed', { frame: tag(frame.id), error: String(err?.message ?? err) });
        // Re-saving one that did land is harmless; losing one isn't.
        for (const { layerId } of exports) unsavedLayers.add(layerId);
        throw err;
      }
    },
    onError: (err) => {
      console.error('Parapara! autosave failed:', err);
      // A stuck encode (exportPNG's timeout) isn't a space problem; the
      // drawing is still on screen and the next stroke tries again.
      if (err?.name === 'TimeoutError') {
        showNotice("Your drawing couldn't be saved just now. Parapara! will try again after your next stroke.");
      } else {
        showNotice("Your drawing couldn't be saved. The iPad may be out of space.");
      }
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
    devLog.add('flush', { at: tag(session.frame.id), unsaved: unsavedLayers.size, held: heldBitmaps.size });
    finishAdjust();
    stopPlayback();
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
  checkEditor = checkCanvases;
  // Hiding the app ends a recording (and keeps the take).
  hideEditor = () => {
    interruptTake();
    finishListen('hidden');
  };

  // The project's sound decodes in the background; Play waits for it.
  loadSound();

  // The Gallery button. Waits out nothing: a tap while a layer or
  // frame change or a stroke is in progress is ignored, like other
  // buttons. If some of her drawing couldn't be saved, she's asked
  // before it's dropped.
  let closing = false;
  async function close() {
    if (closing || !canAct()) return;
    closing = true;
    finishListen('destroy');
    devLog.add('close', { at: tag(session.frame.id) });
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
    checkEditor = null;
    hideEditor = null;
    if (take) cancelTake('closed');
    playback.destroy();
    audio.destroy();
    playbackFrames.destroy();
    onionView.destroy();
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

// The MIME type to store a picked sound file under. iOS usually says;
// when it doesn't, the extension decides. The bytes are never changed.
function soundType(file) {
  if (file.type) return file.type;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name ?? '')?.[1]?.toLowerCase();
  return {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf',
  }[ext] ?? 'application/octet-stream';
}

// Same placement and same stored image (or both none).
function sameImage(a, b) {
  if (!a || !b) return !a && !b;
  return a.blobRef === b.blobRef && samePlacement(a, b);
}

// Decodes a frame's saved layer bitmaps: a Map of layer id ->
// ImageBitmap, with blank layers left out. A bitmap that won't decode
// throws — the caller treats that like any failed load. `sizes`, if
// given, gets bitmapRef -> bytes read (0 = blank), for the log.
async function decodeFrameImages(layers, frame, read, sizes = null) {
  const images = new Map();
  for (const layer of layers) {
    const ref = frame.bitmapRefs[layer.id];
    const blob = await read(ref);
    sizes?.set(ref, blob ? blob.size : 0);
    if (blob) images.set(layer.id, await createImageBitmap(blob));
  }
  return images;
}
