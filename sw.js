// Parapara! service worker
//
// __VERSION__ is a placeholder replaced at deploy time by
// .github/workflows/deploy.yml — a text substitution only, not a
// build step. Exists so a real deploy busts the cache on an
// already-installed device rather than being invisible to it.

const VERSION = '__VERSION__';
const CACHE_NAME = `parapara-${VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './style.css',
  './js/main.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
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
