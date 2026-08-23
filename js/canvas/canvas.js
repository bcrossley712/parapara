// js/canvas/canvas.js
//
// Owns: Pointer Events input, brush engine (draw/erase/fill/smudge),
// stroke-layer compositing, onion-skin rendering of neighboring
// frames.
//
// Talks to other modules only through the shared frame/project data
// shapes (see PROJECT_NOTES.md schema) — no reaching into
// timeline/storage internals directly.
//
// Not built yet — step 1 of the build order.

export function initCanvas(/* project, frame */) {
  // TODO: drawing engine prototype (Pointer Events, stroke smoothing)
}
