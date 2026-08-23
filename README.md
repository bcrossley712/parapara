# Parapara! (パラパラ)

A PWA for freehand frame-by-frame animation on iPad — drawing, onion
skinning, a frame timeline, imported reference images per frame, audio
recording/import with trim, and export/share of the finished
animation.

Built for personal use (single primary user, plus friends as share
recipients) — not a public product.

See **[PROJECT_NOTES.md](./PROJECT_NOTES.md)** for architecture,
working agreements, current build status, and what's next. Read that
file before making changes to this project.

## Stack

- Vanilla JS, native ES modules — no framework, no bundler for app
  code.
- IndexedDB for all project data (drawings, images, audio), fully
  client-side, no backend for the core app.
- GitHub Actions stamps a cache-busting version into the service
  worker on deploy (text substitution only, not a build/compile
  step).
- Deployed via GitHub Pages.

## Project structure

```
index.html
manifest.json
sw.js                  cache versioning lives here
style.css
js/
  canvas/               pointer input, brush engine, rendering
  timeline/              frame array, thumbnails, reorder logic
  storage/                IndexedDB wrapper
  export/                 GIF/WebM stitching
  audio/                  record/import, trim, Web Audio playback
  ui/                     toolbar, buttons, DOM glue
icons/                  app icon set (manifest + apple-touch-icon)
```

## Status

Early scaffolding — placeholder files only, no drawing engine yet.
See PROJECT_NOTES.md "Current state" and "What's realistically next"
for the up-to-date build order.

## Local development

No build step required. Serve the root directory with any static
file server and open `index.html`:

```
python3 -m http.server 8000
```

Note: service worker + IndexedDB behavior is best tested over
`localhost` or HTTPS, not `file://`.
