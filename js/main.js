// Parapara! — app entry point
//
// Glue between modules: loads the project from storage/, hands it to
// the canvas, and wires autosave. Modules don't import each other's
// internals; this file moves data between them (see PROJECT_NOTES.md,
// scope-specific file structure). Screen routing (gallery <-> editor)
// lands here with step 2d; for now it opens straight into the editor.

import { initUI, showUpdatePrompt, showNotice } from './ui/ui.js';
import {
  initStorage,
  openLastProject,
  loadLayerBitmap,
  saveLayerBitmap,
} from './storage/storage.js';
import { createAutosaver } from './storage/autosave.js';

startEditor();

async function startEditor() {
  // Load everything — including decoding the saved image — *before*
  // the canvas exists, so there's no moment where she could draw and
  // then have a late-arriving load wipe the stroke.
  let session = null;      // { project, frame, layer } once loaded
  let savedImage = null;
  try {
    await initStorage();
    const { project, frames } = await openLastProject();
    const frame = frames[0];
    const layer = frame.layers.find((l) => l.id === frame.activeLayerId) ?? frame.layers[0];
    const blob = await loadLayerBitmap(layer.bitmapRef);
    if (blob) savedImage = await createImageBitmap(blob);
    session = { project, frame, layer };
  } catch (err) {
    // Anything failing here — storage unavailable, or a saved image
    // that won't decode — means drawing still works but autosave stays
    // OFF. Saving a blank canvas over a drawing that merely failed to
    // load would destroy it.
    console.error('Parapara! could not load saved work:', err);
  }

  const canvasApi = initUI(document.getElementById('app'));

  if (savedImage) {
    canvasApi.setImage(savedImage);
    savedImage.close?.();
  }

  if (!session) {
    showNotice("Saving isn't working right now, so drawings won't be kept.");
    return;
  }

  const autosaver = createAutosaver({
    save: async () => {
      const blob = await canvasApi.exportPNG();
      await saveLayerBitmap(session.project.id, session.layer.bitmapRef, blob);
    },
    onError: (err) => {
      console.error('Parapara! autosave failed:', err);
      showNotice("Your drawing couldn't be saved. The iPad may be out of space.");
    },
  });

  canvasApi.onChange(() => autosaver.schedule());

  // iPadOS can close a backgrounded web app without warning, so save
  // the moment it's hidden rather than waiting out the debounce.
  // visibilitychange is the reliable signal on iOS; pagehide is a
  // backup for an actual unload.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosaver.flush();
  });
  window.addEventListener('pagehide', () => autosaver.flush());
}

// PWA update-refresh prompt. Registers sw.js, and when a new version
// has installed and is sitting in "waiting" (see sw.js — it no longer
// auto-skipWaiting's), shows a prompt rather than swapping the cache
// out silently. Useful during active development: confirms a push
// actually landed instead of wondering if you're looking at stale
// cache.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((registration) => {
      // Covers the case where a waiting worker already exists at
      // page load (e.g. update installed in a background tab).
      if (registration.waiting && navigator.serviceWorker.controller) {
        showUpdatePrompt(() => {
          registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        });
      }

      // Covers the case where a new worker starts installing during
      // this page's lifetime.
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          // "installed" + an existing controller means this is an
          // update to an already-running app, not the first-ever
          // install (which has no controller yet and shouldn't
          // prompt).
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdatePrompt(() => {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
            });
          }
        });
      });
    }).catch((err) => {
      console.error('Service worker registration failed:', err);
    });

    // Once the new worker takes control, reload so the page actually
    // picks up the fresh app shell instead of running old JS against
    // a swapped cache.
    //
    // Only when an older worker was already in control, though: on the
    // very first install, sw.js's clients.claim() also fires
    // controllerchange, and reloading then would interrupt her first
    // session (possibly mid-stroke) for no reason.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}

registerServiceWorker();
