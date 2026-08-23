// Parapara! — app entry point
//
// Placeholder. Wires up the module folders below once each has real
// logic. See PROJECT_NOTES.md "What's realistically next" for build
// order (drawing engine first).
//
// import { initTimeline } from './timeline/timeline.js';
// import { initStorage } from './storage/storage.js';
import { initUI, showUpdatePrompt } from './ui/ui.js';

initUI(document.getElementById('app'));

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
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}

registerServiceWorker();
