// Parapara! service worker
//
// __VERSION__ is a placeholder replaced at deploy time by
// .github/workflows/deploy.yml — a text substitution only, not a
// build step. Exists so a real deploy busts the cache on an
// already-installed device rather than being invisible to it.

const VERSION = '__VERSION__';
const CACHE_NAME = `parapara-${VERSION}`;

// Every file the app loads at startup belongs here — including every
// ES module reachable from main.js. A module left off this list isn't
// versioned with the rest: it falls through to the network on each
// launch, so an installed device can run a new ui.js against an old
// canvas.js (or fail offline). Add new modules here as they get
// imported.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './js/main.js',
  './js/updater.js',
  './js/ui/ui.js',
  './js/ui/color-picker.js',
  './js/ui/settings-panel.js',
  './js/ui/layers-panel.js',
  './js/ui/gallery.js',
  './js/ui/confirm-dialog.js',
  './js/ui/icons.js',
  './js/ui/reference-bar.js',
  './js/ui/image-menu.js',
  './js/ui/sound-panel.js',
  './js/ui/countdown.js',
  './js/ui/onion-badge.js',
  './js/ui/dev-log-view.js',
  './js/canvas/canvas.js',
  './js/canvas/brush.js',
  './js/canvas/gestures.js',
  './js/canvas/region.js',
  './js/canvas/ink-map.js',
  './js/canvas/thumbnail.js',
  './js/canvas/render-frame.js',
  './js/canvas/frame-tiles.js',
  './js/canvas/playback-frames.js',
  './js/canvas/onion-view.js',
  './js/canvas/reference.js',
  './js/canvas/transform.js',
  './js/storage/storage.js',
  './js/storage/autosave.js',
  './js/storage/history.js',
  './js/storage/layers.js',
  './js/storage/colors.js',
  './js/storage/dev-log.js',
  './js/timeline/frames.js',
  './js/timeline/frame-strip.js',
  './js/timeline/clock.js',
  './js/timeline/frame-cache.js',
  './js/timeline/playback.js',
  './js/timeline/transport.js',
  './js/timeline/onion.js',
  './js/timeline/dev-stress.js',
  './js/audio/audio.js',
  './js/audio/clip.js',
  './js/audio/recorder.js',
  './js/audio/peaks.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: 'reload' skips the browser's HTTP cache and goes to the
      // network. Without it, cache.addAll() can be served from the HTTP
      // cache (GitHub Pages allows 10 minutes), so a new version's
      // cache could be filled with the *previous* deploy's files —
      // a new version number with old CSS/JS inside it.
      cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  // Deliberately NOT calling self.skipWaiting() here. A new SW stays
  // in "waiting" state until the page tells it to take over (see the
  // SKIP_WAITING message below), which is what lets main.js show an
  // update-available prompt instead of silently swapping caches out
  // from under an open session.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // The settings panel shows which build is running. It asks the
  // worker controlling the page (not the page's own JS), because that
  // worker is what decides which cached files the page actually got.
  if (event.data && event.data.type === 'GET_VERSION' && event.ports[0]) {
    event.ports[0].postMessage(VERSION);
  }
});

self.addEventListener('activate', (event) => {
  // Deletes only this app's *old* caches. GitHub Pages serves every
  // project on the account from one origin (bcrossley712.github.io),
  // and caches are per-origin — so deleting "everything that isn't
  // ours" would also wipe other apps' offline caches. Keep the
  // prefix check.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('parapara-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
