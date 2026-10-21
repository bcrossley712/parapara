// js/canvas/canvas.js
//
// Owns: Pointer Events input, brush engine, stroke-layer compositing,
// two-finger pan/zoom (gesture math lives in gestures.js; dispatch —
// deciding whether a touch is a stroke or a gesture — lives here).
// Onion skin (4c) only gets a canvas here (getOnionContext), between
// the reference image and the layers; onion-view.js draws the ghosts.
//
// Layers (step 2c): one <canvas> per layer, stacked bottom-to-top
// inside a wrapper element (.pp-canvas). The wrapper carries the
// pan/zoom/rotate transform; pointer input is heard on the whole canvas
// area around it (the container), so gestures work off the page; layer
// visibility and opacity are plain CSS on each layer canvas, so the
// browser composites them. Only the open frame's layers exist — layers
// are shared across frames (see PROJECT_NOTES.md "Schema"), so moving
// to another frame reuses the same layer canvases with new pixels.
// Tools paint on the active layer only; fill *reads* every visible
// layer (so a color layer fills up to line art on another layer) but
// writes only the active one. Smudge reads and writes the active layer.
//
// The reference image (step 3a) sits under the layers in its own
// element (reference.js). In adjust mode, touches move it instead of
// drawing (see "adjust mode" below); main.js decides what it shows.
//
// It doesn't know about storage: main.js hands it decoded images via
// loadFrame(), and saves via onChange() + exportPNG(layerId) (see the
// API at the bottom).
//
// Undo capture (step 2b): an offscreen "committed copy" holds the
// active layer as of the last committed edit. While a stroke paints,
// a dirty rect grows around every stamp; when it commits, the "before"
// pixels for just that rect are read from the copy and handed to
// onChange listeners, then the copy is synced for that rect. One copy
// only — it follows the active layer, never one per layer. The same
// copy is what reverts an uncommitted mark when a touch turns out to
// be a gesture (draw, erase and fill alike).
//
// Talks to other modules only through the shared frame/project data
// shapes (see PROJECT_NOTES.md schema) once those exist — no reaching
// into timeline/storage internals directly.

import { roundBrush } from './brush.js';
import {
  distance,
  midpoint,
  angleBetween,
  shortestAngleDelta,
  screenToNaturalPoint,
  isQuickTap,
  isDoubleTap,
  classifyThreeFinger,
  centroid,
  computeGestureTransform,
  GESTURE_WINDOW_MS,
  GESTURE_MOVEMENT_THRESHOLD_PX,
  THREE_FINGER_JOIN_MS,
  THREE_FINGER_JOIN_MAX_MOVEMENT_PX,
} from './gestures.js';
import { rectAroundPoint, unionRect, clampRect } from './region.js';
import { createReferenceView } from './reference.js';
import { dragPlacement, pinchPlacement } from './transform.js';

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

// Upper bound for brush size — shared with ui.js (imported there for
// the size slider's max) so the two don't drift out of sync, and used
// here to size the smudge tool's scratch canvas once instead of
// reallocating it per stroke.
export const MAX_BRUSH_SIZE = 60;

// Smudge: how strongly each individual step blends sampled pixels
// into the new position (0 = no effect, 1 = fully replaces), and how
// far apart those steps land along the path (as a fraction of brush
// diameter — same idea as brush.js's spacingRatio, just tuned
// separately since smudge compounds differently than a solid stamp).
//
// These compound fast: consecutive steps overlap, so a single
// continuous pass over one spot applies roughly (1 / spacingRatio)
// overlapping blends, not one. At the original settings (strength
// 0.5, spacing 0.2 → ~5 overlaps per pass), that works out to
// 1-(1-0.5)^5 ≈ 97% effective opacity — a single pass already looked
// almost like solid paint, reported as "goes to a full color line."
// These values are tuned for a single light pass landing around
// ~30% effective blend (1-(1-0.18)^2 ≈ 0.33 at spacing 0.5 → ~2
// overlaps), so it takes a couple of deliberate passes to build up
// real blending, matching how smudge tools elsewhere feel. Revisit
// once tested — this is a feel judgment, not a formula with one right
// answer.
const SMUDGE_STRENGTH = 0.18;
const SMUDGE_SPACING_RATIO = 0.5;

// Default draw/fill color — single source of truth, shared with
// ui/color-picker.js so the picker's initial state and the canvas's
// actual starting color can't drift apart.
export const DEFAULT_COLOR = '#2b2b2b';

// --- tool settings (remembered across launches; see main.js) ---
//
// Tools, and which of them have a size. Fill has no size (a flood
// fill has no radius).
const TOOLS = ['draw', 'erase', 'fill', 'smudge'];
const SIZED_TOOLS = ['draw', 'erase', 'smudge'];
const DEFAULT_TOOL = 'draw';
const DEFAULT_BRUSH_SIZE = 6;

// Turns whatever was saved (possibly from an older app version, or
// corrupted) into valid settings. Each field is checked on its own: a
// bad color doesn't throw away a good tool or sizes, and anything
// missing or invalid falls back to its default. Pure — no DOM — so
// it's unit-tested directly.
export function sanitizeToolSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};

  const tool = TOOLS.includes(input.tool) ? input.tool : DEFAULT_TOOL;

  const color = typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color)
    ? input.color.toLowerCase()
    : DEFAULT_COLOR;

  const savedSizes = input.brushSizes && typeof input.brushSizes === 'object'
    ? input.brushSizes
    : {};
  const brushSizes = {};
  for (const name of SIZED_TOOLS) {
    const size = savedSizes[name];
    brushSizes[name] = Number.isInteger(size) && size >= 1 && size <= MAX_BRUSH_SIZE
      ? size
      : DEFAULT_BRUSH_SIZE;
  }

  return { tool, color, brushSizes };
}

// Fill: per-channel color-distance tolerance for what counts as "the
// same region" to flood. Anti-aliased line edges are never a single
// exact color, so a tolerance of 0 would leave a ring of unfilled
// fringe pixels around every stroke. Fixed default, not yet tuned
// against the real device.
const FILL_TOLERANCE = 32;

export function initCanvas(container, options = {}) {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;

  // The wrapper: what she sees as "the canvas". Sized in JS to fit the
  // canvas area (fitStack) since a <div> has no intrinsic size.
  const stack = document.createElement('div');
  stack.className = 'pp-canvas';
  // Bug fix: the pan/zoom math in gestures.js (computeGestureTransform)
  // assumes transform-origin is pinned at the transformed element's own
  // top-left corner — that assumption was never actually enforced
  // anywhere. CSS defaults transform-origin to 50% 50% (center), so
  // scale() was zooming around the center regardless of where the pinch
  // was, reported as "doesn't zoom where you're pinching." The wrapper
  // is what transforms now, so it's pinned here.
  stack.style.transformOrigin = '0 0';
  container.appendChild(stack);

  // The reference image (step 3a): under every layer, its own element
  // (reference.js). main.js tells it what to show; adjust mode (below)
  // moves it.
  const reference = createReferenceView(stack, width, height);

  // Layer surfaces, by layer id: { canvas, ctx, visible, opacity }.
  // `order` is bottom-to-top, matching the DOM order inside the stack.
  const surfaces = new Map();
  let order = [];
  let activeLayerId = null;

  // The active layer's canvas and context — what every tool paints on.
  // null until main.js calls loadFrame().
  let canvas = null;
  let ctx = null;

  // Deliberately NOT passing { willReadFrequently: true } to layer
  // contexts, even though smudge/fill do call getImageData. That hint
  // typically pushes the canvas onto a software (CPU) rendering path
  // instead of GPU-accelerated — which would slow down every draw/
  // erase stamp too, not just the occasional pixel read. Draw/erase
  // happen far more often than smudge/fill, so trading their
  // performance away to speed up the less-used tools is the wrong
  // direction. If smudge/fill specifically still feel slow after
  // this, that's a narrower problem to solve (e.g. bounding fill's
  // read/write region) rather than reintroducing this.
  function createSurface(id) {
    const el = document.createElement('canvas');
    el.width = width;
    el.height = height;
    el.className = 'pp-layer';
    el.dataset.layerId = id;
    return { canvas: el, ctx: el.getContext('2d'), visible: true, opacity: 1, locked: false };
  }

  function applySurfaceStyle(surface) {
    surface.canvas.style.visibility = surface.visible ? '' : 'hidden';
    surface.canvas.style.opacity = String(surface.opacity);
  }

  function readLayerProps(surface, layer) {
    surface.visible = layer.visible !== false;
    surface.opacity = typeof layer.opacity === 'number'
      ? Math.min(1, Math.max(0, layer.opacity))
      : 1;
    surface.locked = layer.locked === true;
    applySurfaceStyle(surface);
  }

  // Makes the surfaces match `layers` (bottom first): creates canvases
  // for new ids (blank), releases ones no longer listed, re-orders the
  // DOM, and applies visible/opacity/locked. Existing pixels are left
  // alone. If the active layer went away, the top layer becomes active.
  function applyLayers(layers) {
    const keep = new Set(layers.map((l) => l.id));
    for (const [id, surface] of surfaces) {
      if (keep.has(id)) continue;
      surface.canvas.remove();
      // Free the backing store now, not at GC (iPad canvas memory).
      surface.canvas.width = 0;
      surface.canvas.height = 0;
      surfaces.delete(id);
    }
    if (activeLayerId !== null && !surfaces.has(activeLayerId)) {
      canvas = null;
      ctx = null;
      activeLayerId = null;
    }

    order = layers.map((l) => l.id);
    for (const layer of layers) {
      let surface = surfaces.get(layer.id);
      if (!surface) {
        surface = createSurface(layer.id);
        surfaces.set(layer.id, surface);
      }
      readLayerProps(surface, layer);
      // append() moves an existing child, so this also re-orders.
      stack.appendChild(surface.canvas);
    }
    // The playback picture (4b) stays above every layer.
    if (playbackCanvas) stack.appendChild(playbackCanvas);

    if (activeLayerId === null) {
      const top = order[order.length - 1];
      if (top !== undefined) activate(top);
      else dirty = null;
    }
  }

  // Why the active layer can't be painted on right now, or null.
  // Locked: the standard lock. Hidden: painting where you can't see
  // the result would be a surprise, so it's refused too.
  function paintBlockReason() {
    const surface = surfaces.get(activeLayerId);
    if (!surface) return null;
    if (surface.locked) return 'locked';
    if (!surface.visible) return 'hidden';
    return null;
  }

  // While true (main.js sets it during async layer/frame work), new
  // touches are ignored entirely.
  let inputBlocked = false;

  // DEV ONLY (activity log, after 4b): things that change pixels
  // without an undo step, reported for main.js to log.
  const debugListeners = new Set();
  function emitDebug(event, details) {
    for (const listener of debugListeners) listener(event, details);
  }

  // --- playback (4b) ---
  //
  // While the animation plays (or gets ready to), a touch on the canvas
  // area stops it and does nothing else: no stroke, fill, pick or
  // gesture. That touch — and any finger that joins it — stays
  // swallowed until every finger is up, even though playback has
  // stopped by then, so the tap that stops it never starts drawing.
  let playbackInput = false;
  const swallowed = new Set(); // pointer ids
  const playbackTapListeners = new Set();
  // The playing picture: one full-size canvas above the layers, inside
  // the wrapper so it gets the same view transform. Only exists while
  // shown (it's ~8 MB at 1920×1080).
  let playbackCanvas = null;

  function swallow(event) {
    swallowed.add(event.pointerId);
    try {
      container.setPointerCapture(event.pointerId);
    } catch {
      // not capturable (already gone) — pointerleave covers it
    }
    if (playbackInput) {
      for (const listener of playbackTapListeners) listener();
    }
  }

  // Onion skin (4c): neighboring frames' ghosts, drawn by
  // onion-view.js on one full-size canvas right after the reference
  // holder — over the photo, under every layer (applyLayers appends
  // layers after it). Not a layer: never in readVisible, never
  // touched by the tools. Only exists while ghosts show.
  let onionCanvas = null;

  function freeOnionCanvas() {
    if (!onionCanvas) return;
    onionCanvas.remove();
    onionCanvas.width = 0;
    onionCanvas.height = 0;
    onionCanvas = null;
  }

  function freePlaybackCanvas() {
    if (!playbackCanvas) return;
    playbackCanvas.remove();
    playbackCanvas.width = 0;
    playbackCanvas.height = 0;
    playbackCanvas = null;
  }

  // Set at the start of a stroke on a layer that can't be painted: the
  // stroke still runs (so a second finger can still turn it into a
  // gesture) but paints nothing, and on lift reports why instead of
  // committing.
  let strokeBlocked = null;

  const blockedListeners = new Set();

  // Smudge's scratch buffer: sized once to the largest brush size
  // rather than reallocated per stroke.
  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = MAX_BRUSH_SIZE;
  scratchCanvas.height = MAX_BRUSH_SIZE;
  const scratchCtx = scratchCanvas.getContext('2d');

  // The committed copy (see top of file). Read with getImageData only
  // when a stroke commits, so — like the main canvas — no
  // willReadFrequently hint.
  const committedCanvas = document.createElement('canvas');
  committedCanvas.width = width;
  committedCanvas.height = height;
  const committedCtx = committedCanvas.getContext('2d');

  // Canvas-pixel box around everything painted since the last commit
  // (unclamped; clamped at commit). null = nothing uncommitted.
  let dirty = null;

  function markDirty(rect) {
    dirty = unionRect(dirty, rect);
  }

  // Copies `rect` of the main canvas into the committed copy.
  function syncCommitted(rect) {
    committedCtx.clearRect(rect.x, rect.y, rect.w, rect.h);
    committedCtx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
  }

  // Puts the committed pixels back over everything uncommitted — how a
  // touch that became a gesture loses its first mark (or fill).
  function revertUncommitted() {
    const rect = clampRect(dirty, width, height);
    dirty = null;
    if (!rect) return;
    emitDebug('revert', { layer: activeLayerId, rect: `${rect.x},${rect.y} ${rect.w}x${rect.h}` });
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    ctx.drawImage(committedCanvas, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }

  // Commits whatever is dirty: reads the "before" patch from the copy,
  // syncs the copy, and tells listeners. Nothing dirty (a smudge tap
  // with no drag, a fill on an already-filled area) = no change at all,
  // so no undo step and no save.
  function commit() {
    const rect = clampRect(dirty, width, height);
    dirty = null;
    if (!rect) return;
    const before = committedCtx.getImageData(rect.x, rect.y, rect.w, rect.h);
    syncCommitted(rect);
    notifyChange({ rect, before, layerId: activeLayerId, tool });
  }

  let tool = DEFAULT_TOOL; // one of TOOLS: 'draw' | 'erase' | 'fill' | 'smudge'
  let brush = roundBrush; // only tip today — see brush.js for the seam
  let color = DEFAULT_COLOR;  // draw/fill color; unused for erase/smudge

  // Per-tool brush size memory — draw/erase/smudge each remember
  // their own size independently (matches how Procreate/Sketchbook/
  // etc. behave) rather than one shared size that carries between
  // tools. Fill has no size concept (a flood fill has no radius), so
  // it isn't tracked here.
  const brushSizes = sanitizeToolSettings(null).brushSizes; // defaults

  // Pressure/tilt from PointerEvent aren't read yet — deliberately,
  // per the architecture note that the brush engine shouldn't bake in
  // assumptions about them. They're there on the event when Pencil
  // support is added later; wiring them into brush size is a later,
  // additive change, not a restructure.

  // One active stroke at a time: the first pointer down claims
  // drawing until it lifts, and any pointer that goes down while a
  // stroke is already active is ignored. This is a simple palm-
  // rejection heuristic (catches a palm landing after the stylus has
  // already touched down) — it doesn't handle every ordering (e.g.
  // palm touching first), and needs tuning against the real stylus on
  // the real device before treating it as done.
  let activePointerId = null;

  // Only the last two points are needed for the midpoint-smoothing
  // curve below (and for smudge's from/to), so they're tracked
  // directly rather than growing an array for the whole stroke.
  let p0 = null; // two points back
  let p1 = null; // one point back

  // --- pan/zoom/rotate viewport (two-finger gesture) ---
  //
  // Applied as a CSS transform on the wrapper only — the layers'
  // backing-store bitmaps and their 1920x1080 resolution never change.
  // toCanvasPoint() below maps screen points to canvas pixels
  // analytically from this state (via gestures.js's
  // screenToNaturalPoint), not by reading the canvas's bounding rect —
  // getBoundingClientRect() on a rotated element returns the
  // axis-aligned box that merely contains the rotated shape, not its
  // own tilted frame, so it stopped being usable once rotation was
  // added.
  let viewportScale = 1;
  let viewportRotation = 0; // radians
  let viewportX = 0;
  let viewportY = 0;

  // The canvas's natural (untransformed, fit-to-screen) box, relative
  // to its container — captured once, and re-captured on resize. This
  // is the fixed reference frame the gesture math works in.
  let natLeft = 0, natTop = 0, natWidth = 0, natHeight = 0;

  function applyViewport() {
    stack.style.transform =
      `translate(${viewportX}px, ${viewportY}px) rotate(${viewportRotation}rad) scale(${viewportScale})`;
  }

  function resetViewport() {
    viewportScale = 1;
    viewportRotation = 0;
    viewportX = 0;
    viewportY = 0;
    applyViewport();
  }

  // Sizes the wrapper to the largest box with the canvas's aspect ratio
  // that fits the canvas area — what max-width/max-height did when the
  // canvas element itself was the thing on screen.
  function fitStack() {
    const fit = Math.min(container.clientWidth / width, container.clientHeight / height);
    stack.style.width = `${width * fit}px`;
    stack.style.height = `${height * fit}px`;
    reference.setDisplayWidth(width * fit);
  }

  function captureNaturalRect() {
    fitStack();
    const areaRect = container.getBoundingClientRect();
    // Clear the transform first so the measured rect is the natural
    // (untransformed) box, not whatever pan/zoom happens to be
    // applied right now.
    stack.style.transform = '';
    const canvasRect = stack.getBoundingClientRect();
    natLeft = canvasRect.left - areaRect.left;
    natTop = canvasRect.top - areaRect.top;
    natWidth = canvasRect.width;
    natHeight = canvasRect.height;
    applyViewport();
  }

  captureNaturalRect();

  // Layout may have changed (e.g. iPad rotation) — simplest safe
  // behavior is to reset pan/zoom/rotation rather than try to
  // preserve the transform across a layout change.
  //
  // Watches the canvas area itself, not window 'resize': on iOS the
  // safe-area padding and post-rotation layout can settle after the
  // last window resize event (or without one at all), which would
  // leave natLeft/natTop/natWidth/natHeight stale and make strokes
  // land offset from the stylus. ResizeObserver fires whenever the
  // area's box actually changes, plus once right after observe() —
  // which also corrects the initial measurement if it ran before
  // layout had settled.
  const areaObserver = new ResizeObserver(() => {
    viewportScale = 1;
    viewportRotation = 0;
    viewportX = 0;
    viewportY = 0;
    captureNaturalRect();
  });
  areaObserver.observe(container);

  // --- touch-vs-gesture disambiguation ---
  //
  // A touch pointer starts drawing immediately (no added delay) but
  // stays a "pending" gesture candidate for a short window. If a
  // second touch joins within that window while the first has barely
  // moved, both become a two-finger pan/zoom gesture instead — the
  // first pointer's just-drawn mark (or fill) is reverted from the
  // committed copy. If the window expires (or the first pointer moves
  // too far) without a second touch, it was just a normal solo stroke
  // and nothing further happens — the draw was never delayed waiting
  // to find out.
  //
  // pointerType 'pen' (and mouse, for desktop testing) bypasses all
  // of this and goes straight to drawing — real styli, and hopefully
  // eventually a real Apple Pencil, report reliably enough that no
  // gesture candidacy is needed.
  let pendingTouch = null; // { pointerId, startTime, startLocal, lastLocal }
  // Two-finger pan/zoom/rotate, or — once a third finger joins —
  // a three-finger undo/redo gesture (gesture.threeFinger set).
  let gesture = null;      // { pointerIds, points, startPoints, startTime, startScale, startX, startY, startMidpoint, startDistance, totalMovement, threeFinger }
  let lastTwoFingerTapTime = null; // for the two-finger double-tap

  // Undo/redo gesture listeners: called with 'undo' or 'redo'.
  const gestureListeners = new Set();
  function emitGesture(name) {
    for (const listener of gestureListeners) listener(name);
  }

  function restoreGestureStartViewport(g) {
    viewportScale = g.startScale;
    viewportRotation = g.startRotation;
    viewportX = g.startX;
    viewportY = g.startY;
    applyViewport();
  }

  // iPadOS has its own three-finger undo/redo (and its HUD). Pointer
  // Events can't cancel a system gesture, so this is the one deliberate
  // exception to "Pointer Events only": a non-passive touch listener
  // that only calls preventDefault() while 3+ touches are down. All
  // gesture *recognition* stays in the pointer handlers. Whether this
  // actually blocks the system gesture is device-only; if three-finger
  // tap/swipe stops registering on the iPad, suspect this listener first.
  const blockSystemThreeFinger = (event) => {
    if (event.touches.length >= 3) event.preventDefault();
  };
  container.addEventListener('touchstart', blockSystemThreeFinger, { passive: false });
  container.addEventListener('touchmove', blockSystemThreeFinger, { passive: false });

  function toCanvasPoint(event) {
    const local = toLocalPoint(event);
    const natural = screenToNaturalPoint(local, {
      natLeft, natTop,
      scale: viewportScale,
      rotation: viewportRotation,
      x: viewportX,
      y: viewportY,
    });
    return {
      x: (natural.x / natWidth) * width,
      y: (natural.y / natHeight) * height,
    };
  }

  // Container-relative CSS px — distinct from toCanvasPoint (which
  // maps to backing-store pixels and accounts for the live
  // transform). This is for gesture math only, in the same stable
  // frame as natLeft/natTop (the container itself never transforms).
  function toLocalPoint(event) {
    const areaRect = container.getBoundingClientRect();
    return { x: event.clientX - areaRect.left, y: event.clientY - areaRect.top };
  }

  function stampMidpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // --- draw/erase: stamp the active brush along the smoothed path ---

  // Every draw/erase stamp goes through here so the dirty rect can't
  // miss one.
  function stamp(point, size) {
    brush.stamp(ctx, point, size);
    markDirty(rectAroundPoint(point, size));
  }

  function stampAlongLine(a, b) {
    const size = brushSizes[tool];
    const spacing = Math.max(1, size * brush.spacingRatio);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      stamp({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, size);
    }
  }

  function stampAlongQuadratic(start, control, end) {
    const size = brushSizes[tool];
    const spacing = Math.max(1, size * brush.spacingRatio);
    // Control-polygon length as a cheap upper-bound estimate of arc
    // length — good enough to pick a stamp count, doesn't need to be
    // exact.
    const approxLength = Math.hypot(control.x - start.x, control.y - start.y)
      + Math.hypot(end.x - control.x, end.y - control.y);
    const steps = Math.max(1, Math.ceil(approxLength / spacing));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const oneMinusT = 1 - t;
      const x = oneMinusT * oneMinusT * start.x + 2 * oneMinusT * t * control.x + t * t * end.x;
      const y = oneMinusT * oneMinusT * start.y + 2 * oneMinusT * t * control.y + t * t * end.y;
      stamp({ x, y }, size);
    }
  }

  // --- smudge: sample a patch behind the stroke, blend it forward ---

  function smudgeStep(from, to, size) {
    const half = size / 2;

    // Sample a patch centered on the previous position, then paint it
    // back centered on the new position at partial opacity. Points
    // near the canvas edge sample some out-of-bounds pixels, which
    // come back transparent per spec — fine, it just fades toward
    // transparent at the edge.
    const patch = ctx.getImageData(
      Math.round(from.x - half),
      Math.round(from.y - half),
      size,
      size
    );
    scratchCtx.putImageData(patch, 0, 0);

    ctx.save();
    ctx.beginPath();
    ctx.arc(to.x, to.y, half, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = SMUDGE_STRENGTH;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(scratchCanvas, 0, 0, size, size, to.x - half, to.y - half, size, size);
    ctx.restore();
    markDirty(rectAroundPoint(to, size));
  }

  // Bug fix: smudge originally called smudgeStep once per pointer
  // sample pair, with no interpolation — unlike draw/erase (see
  // stampAlongLine/stampAlongQuadratic above), which already fill
  // gaps between far-apart samples. On a fast drag, consecutive
  // points can land farther apart than the brush radius, so instead
  // of a continuous smear it produced isolated circular blends with
  // visible gaps — reported as "stippling dots." This interpolates
  // smudgeStep calls along the segment the same way draw/erase do.
  function smudgeAlongLine(from, to) {
    const size = Math.max(2, Math.round(brushSizes.smudge));
    const spacing = Math.max(1, size * SMUDGE_SPACING_RATIO);
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / spacing));

    let prev = from;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      smudgeStep(prev, point, size);
      prev = point;
    }
  }

  // --- fill: flood fill from a single tap, no drag involved ---

  function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    const value = parseInt(clean, 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
  }

  function colorsClose(r1, g1, b1, a1, r2, g2, b2, a2, tolerance) {
    return Math.abs(r1 - r2) <= tolerance
      && Math.abs(g1 - g2) <= tolerance
      && Math.abs(b1 - b2) <= tolerance
      && Math.abs(a1 - a2) <= tolerance;
  }

  // THE "visible canvas" sampler — what fill and the eyedropper see:
  // every visible layer composited at its opacity (Sketchbook's
  // sample-all-layers), so a fill on a color layer stops at line art on
  // another layer and the eyedropper picks what's on screen. Hidden
  // layers don't count. Returns ImageData for `rect` (default: the
  // whole canvas), unpremultiplied, transparent where nothing's drawn.
  // The reference image (3a) is included, under the layers, when it's
  // showing — she traces and fills up to it, and picks its colors.
  // Onion skin (4c) must NOT be (ghost frames aren't her drawing).
  // When the active layer is the only thing visible, at full opacity,
  // that's just its own pixels — no composite needed.
  function readVisible(rect = { x: 0, y: 0, w: width, h: height }) {
    const { x, y, w, h } = rect;
    const visible = order.map((id) => surfaces.get(id)).filter((s) => s.visible);
    const withReference = reference.isShowing();
    if (!withReference && visible.length === 1 && visible[0].ctx === ctx && visible[0].opacity === 1) {
      return ctx.getImageData(x, y, w, h);
    }
    const temp = document.createElement('canvas');
    temp.width = w;
    temp.height = h;
    const tctx = temp.getContext('2d');
    if (withReference) reference.drawInto(tctx, x, y);
    for (const surface of visible) {
      tctx.globalAlpha = surface.opacity;
      tctx.drawImage(surface.canvas, x, y, w, h, 0, 0, w, h);
    }
    const sample = tctx.getImageData(0, 0, w, h);
    // Release the backing store now rather than whenever GC runs —
    // iPad Safari counts canvas memory hard.
    temp.width = 0;
    temp.height = 0;
    return sample;
  }

  function floodFill(point) {
    if (strokeBlocked) return;
    const startX = Math.round(point.x);
    const startY = Math.round(point.y);
    if (startX < 0 || startY < 0 || startX >= width || startY >= height) return;

    // `data` decides the region (all visible layers); `target` is the
    // active layer, where the fill color is written. Same object when
    // the sample is just the active layer.
    const sampleData = readVisible();
    const data = sampleData.data;

    const startIdx = (startY * width + startX) * 4;
    const startR = data[startIdx];
    const startG = data[startIdx + 1];
    const startB = data[startIdx + 2];
    const startA = data[startIdx + 3];

    const fillColor = hexToRgb(color);

    // Already the target color — nothing to do, and filling would
    // churn every pixel in the region for no visible change.
    if (colorsClose(startR, startG, startB, startA, fillColor.r, fillColor.g, fillColor.b, 255, 0)) {
      return;
    }

    const targetData = ctx.getImageData(0, 0, width, height);
    const target = targetData.data;

    // Iterative (stack-based) rather than recursive — a recursive
    // flood fill can blow the call stack on a large open region at
    // 1920x1080.
    const stack = [[startX, startY]];
    const visited = new Uint8Array(width * height);
    visited[startY * width + startX] = 1;

    // Bounds of the filled pixels — the undo patch only covers these.
    let minX = startX, maxX = startX, minY = startY, maxY = startY;

    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < minX) minX = x; else if (x > maxX) maxX = x;
      if (y < minY) minY = y; else if (y > maxY) maxY = y;
      const idx = (y * width + x) * 4;
      target[idx] = fillColor.r;
      target[idx + 1] = fillColor.g;
      target[idx + 2] = fillColor.b;
      target[idx + 3] = 255;

      const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const vIdx = ny * width + nx;
        if (visited[vIdx]) continue;

        const nIdx = vIdx * 4;
        if (colorsClose(data[nIdx], data[nIdx + 1], data[nIdx + 2], data[nIdx + 3], startR, startG, startB, startA, FILL_TOLERANCE)) {
          visited[vIdx] = 1;
          stack.push([nx, ny]);
        }
      }
    }

    // Write back only the filled box: same pixels, less to upload.
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    ctx.putImageData(targetData, 0, 0, minX, minY, w, h);
    markDirty({ x: minX, y: minY, w, h });
  }

  // --- stroke lifecycle, shared by draw/erase/smudge ---

  // --- eyedropper ---
  //
  // Not one of TOOLS (never saved as a setting): armed from the color
  // picker, it turns the next touch into a pick. While the finger is
  // down, listeners get a live 'preview' of the color under it; on
  // lift, a 'pick' — then it disarms and the tool she had is back
  // (Flipaclip). A second finger turns the touch into a gesture as
  // usual and leaves it armed. Lifting off the page picks nothing and
  // stays armed. It only reads, so a locked or hidden active layer
  // doesn't stop it.
  let eyedropperArmed = false;
  let picking = false;       // a pick touch is down
  let pickHex = null;        // the color under it (null = off the page)
  const eyedropperListeners = new Set();
  function emitEyedropper(type, hex = null) {
    for (const listener of eyedropperListeners) listener({ type, hex });
  }

  // The color she sees at a canvas point: the visible composite,
  // flattened over the white page. Null off the page.
  function colorAt(point) {
    const px = Math.floor(point.x);
    const py = Math.floor(point.y);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const [r, g, b, a] = readVisible({ x: px, y: py, w: 1, h: 1 }).data;
    const over = (c) => Math.round((c * a + 255 * (255 - a)) / 255);
    return `#${[over(r), over(g), over(b)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }

  function beginPick(point) {
    picking = true;
    strokeBlocked = null;
    pickHex = colorAt(point);
    if (pickHex) emitEyedropper('preview', pickHex);
  }

  function movePick(point) {
    const hex = colorAt(point);
    if (hex && hex !== pickHex) emitEyedropper('preview', hex);
    pickHex = hex;
  }

  function endPick() {
    activePointerId = null;
    picking = false;
    const hex = pickHex;
    pickHex = null;
    if (!hex) {
      emitEyedropper('preview-end');
      return;
    }
    eyedropperArmed = false;
    emitEyedropper('pick', hex);
  }

  function beginStroke(point) {
    p0 = null;
    p1 = point;
    if (strokeBlocked) return;

    if (tool === 'smudge') {
      // Smudge has no "begin" mark — it only does something once it
      // has a from/to pair to drag between (see extendStroke). A
      // lone tap with no movement intentionally does nothing, same
      // as smudge tools elsewhere (nothing to blend without a
      // direction to drag).
      return;
    }

    ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
    ctx.fillStyle = color;

    // Stamp once immediately so a tap with no movement still leaves a
    // mark instead of rendering nothing.
    stamp(point, brushSizes[tool]);
  }

  function extendStroke(point) {
    const p2 = point;
    if (strokeBlocked) {
      p1 = p2;
      return;
    }

    if (tool === 'smudge') {
      smudgeAlongLine(p1, p2);
      p0 = p1;
      p1 = p2;
      return;
    }

    if (p0 === null) {
      // Second point of the stroke — not enough history yet for the
      // midpoint technique below, so stamp along a straight segment.
      stampAlongLine(p1, p2);
    } else {
      // Quadratic midpoint smoothing: stamp along the curve through
      // the midpoints of consecutive points rather than connecting
      // raw sample points with straight segments, which is what
      // produces the jagged/faceted look on sampled pointer input.
      const mid1 = stampMidpoint(p0, p1);
      const mid2 = stampMidpoint(p1, p2);
      stampAlongQuadratic(mid1, p1, mid2);
    }

    p0 = p1;
    p1 = p2;
  }

  function endStroke() {
    activePointerId = null;
    p0 = null;
    p1 = null;
    if (strokeBlocked) {
      const reason = strokeBlocked;
      strokeBlocked = null;
      dirty = null;
      for (const listener of blockedListeners) listener(reason);
      return;
    }
    // Every committed edit ends here — draw/erase/smudge strokes, and
    // fills too (a fill's pointerup also routes through endStroke). A
    // touch that turned into a gesture never reaches this: its mark
    // was already reverted, so it doesn't count as a change.
    commit();
  }

  // --- change notification (main.js: undo history + autosave) ---

  const changeListeners = new Set();

  // change = { rect, before, layerId, tool }: the committed rect, its
  // pixels before the edit (ImageData), the layer it was on, and what
  // made it (a TOOLS name, or 'clear' / 'dev' for the gear menu's).
  function notifyChange(change) {
    for (const listener of changeListeners) listener(change);
  }

  function isBusy() {
    return activePointerId !== null || pendingTouch !== null || gesture !== null
      || adjustPointers.size > 0;
  }

  function hasPaint(data) {
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  }

  // --- adjust mode (step 3a): touches move the reference image ---
  //
  // While main.js has adjust mode on, no tool or view gesture runs: one
  // pointer (finger, pen or mouse) drags the image, two fingers move,
  // scale and turn it (pinchPlacement), a third is ignored. The view
  // stays put — except a two-finger double-tap, which still resets it
  // so she can always get her bearings back. Points are converted to
  // canvas space (toCanvasPoint), so the view's zoom and rotation don't
  // change how far the image moves under her finger. Every time a
  // finger joins or lifts, the motion restarts from where the image is,
  // so nothing jumps.
  let adjusting = false;
  // pointerId -> { canvas: point, local: point }
  const adjustPointers = new Map();
  // The motion in progress: { kind: 'drag' | 'pinch', start (placement),
  //   from, a0, b0, ids, lastAngle, turned, startTime, movement }
  let adjustMotion = null;

  function restartAdjustMotion(now) {
    const start = reference.placement();
    const ids = [...adjustPointers.keys()];
    if (!start || ids.length === 0) {
      adjustMotion = null;
      return;
    }
    if (ids.length === 1) {
      adjustMotion = { kind: 'drag', start, from: adjustPointers.get(ids[0]).canvas, ids };
      return;
    }
    const a0 = adjustPointers.get(ids[0]).canvas;
    const b0 = adjustPointers.get(ids[1]).canvas;
    adjustMotion = {
      kind: 'pinch', start, a0, b0, ids,
      lastAngle: angleBetween(a0, b0),
      turned: 0,
      startTime: now,
      movement: 0,
    };
  }

  function adjustDown(event) {
    if (!reference.key() || adjustPointers.size >= 2) return;
    container.setPointerCapture(event.pointerId);
    adjustPointers.set(event.pointerId, { canvas: toCanvasPoint(event), local: toLocalPoint(event) });
    restartAdjustMotion(event.timeStamp);
  }

  function adjustMove(event) {
    const pointer = adjustPointers.get(event.pointerId);
    if (!pointer || !adjustMotion) return;
    const local = toLocalPoint(event);
    pointer.canvas = toCanvasPoint(event);
    const m = adjustMotion;
    if (m.kind === 'drag') {
      reference.setPlacement(dragPlacement(m.start, m.from, pointer.canvas));
      return;
    }
    m.movement += distance(local, pointer.local);
    pointer.local = local;
    const a1 = adjustPointers.get(m.ids[0]).canvas;
    const b1 = adjustPointers.get(m.ids[1]).canvas;
    const angle = angleBetween(a1, b1);
    m.turned += shortestAngleDelta(m.lastAngle, angle);
    m.lastAngle = angle;
    const image = reference.size();
    const size = { imageW: image.width, imageH: image.height, canvasW: width, canvasH: height };
    reference.setPlacement(pinchPlacement(m.start, { a0: m.a0, b0: m.b0, a1, b1, turned: m.turned }, size));
  }

  function adjustUp(event) {
    if (!adjustPointers.has(event.pointerId)) return;
    if (container.hasPointerCapture?.(event.pointerId)) container.releasePointerCapture(event.pointerId);
    const m = adjustMotion;
    adjustPointers.delete(event.pointerId);
    if (event.type === 'pointercancel' && m) {
      // The system took over: undo this motion, nothing more.
      reference.setPlacement(m.start);
    } else if (m?.kind === 'pinch') {
      if (isQuickTap(event.timeStamp - m.startTime, m.movement)) {
        // A two-finger tap shouldn't nudge the image; two in a row
        // reset the view, as everywhere else.
        reference.setPlacement(m.start);
        if (isDoubleTap(lastTwoFingerTapTime, event.timeStamp)) {
          lastTwoFingerTapTime = null;
          resetViewport();
        } else {
          lastTwoFingerTapTime = event.timeStamp;
        }
      } else {
        lastTwoFingerTapTime = null;
      }
    }
    restartAdjustMotion(event.timeStamp);
  }

  function endAdjustTouches() {
    for (const id of adjustPointers.keys()) {
      if (container.hasPointerCapture?.(id)) container.releasePointerCapture(id);
    }
    adjustPointers.clear();
    adjustMotion = null;
  }

  function onPointerDown(event) {
    if (playbackInput || swallowed.size > 0) {
      // A primary pointer means no other finger is down, so anything
      // still listed lost its pointerup somewhere: start fresh.
      if (!playbackInput && event.isPrimary) {
        swallowed.clear();
      } else {
        swallow(event);
        return;
      }
    }
    if (!ctx || inputBlocked) return; // no frame loaded yet, or busy
    if (adjusting) {
      adjustDown(event);
      return;
    }
    if (event.pointerType === 'touch') {
      if (gesture) {
        // A third finger landing right after a two-finger gesture
        // started turns it into a three-finger undo/redo gesture.
        // Anything else extra (a fourth finger, a late third) is
        // ignored, as the palm-rejection heuristic always has been.
        const elapsed = event.timeStamp - gesture.startTime;
        if (
          !gesture.threeFinger
          && elapsed <= THREE_FINGER_JOIN_MS
          && gesture.totalMovement <= THREE_FINGER_JOIN_MAX_MOVEMENT_PX
        ) {
          const local = toLocalPoint(event);
          container.setPointerCapture(event.pointerId);
          gesture.pointerIds.push(event.pointerId);
          gesture.points.set(event.pointerId, local);
          gesture.startPoints.set(event.pointerId, local);
          gesture.threeFinger = true;
          // Whatever tiny pan/zoom the first two fingers caused is undone.
          restoreGestureStartViewport(gesture);
        }
        return;
      }

      if (pendingTouch && event.pointerId !== pendingTouch.pointerId) {
        const elapsed = event.timeStamp - pendingTouch.startTime;
        const moved = distance(pendingTouch.lastLocal, pendingTouch.startLocal);

        if (elapsed <= GESTURE_WINDOW_MS && moved <= GESTURE_MOVEMENT_THRESHOLD_PX) {
          // Confirmed: this is a two-finger gesture, not a palm.
          // Revert whatever the first finger had started drawing (or
          // filling) from the committed copy.
          revertUncommitted();
          if (container.hasPointerCapture?.(pendingTouch.pointerId)) {
            container.releasePointerCapture(pendingTouch.pointerId);
          }

          const firstLocal = pendingTouch.lastLocal;
          const secondLocal = toLocalPoint(event);

          container.setPointerCapture(event.pointerId);
          gesture = {
            pointerIds: [pendingTouch.pointerId, event.pointerId],
            points: new Map([
              [pendingTouch.pointerId, firstLocal],
              [event.pointerId, secondLocal],
            ]),
            startPoints: new Map([
              [pendingTouch.pointerId, pendingTouch.startLocal],
              [event.pointerId, secondLocal],
            ]),
            startTime: event.timeStamp,
            // The very first touch, for three-finger tap duration.
            firstTouchTime: pendingTouch.startTime,
            startScale: viewportScale,
            startRotation: viewportRotation,
            startX: viewportX,
            startY: viewportY,
            startMidpoint: midpoint(firstLocal, secondLocal),
            startDistance: Math.max(1, distance(firstLocal, secondLocal)),
            // Rotation is tracked incrementally (frame-to-frame,
            // shortest-path) rather than as a single start-to-current
            // diff — see gestures.js's shortestAngleDelta for why: a
            // continuous twist past 180° needs this to avoid visibly
            // snapping.
            lastAngle: angleBetween(firstLocal, secondLocal),
            accumulatedRotation: 0,
            totalMovement: 0,
            threeFinger: false,
          };

          pendingTouch = null;
          activePointerId = null;
          strokeBlocked = null; // a gesture, not a refused stroke
          if (picking) {
            // Still armed: the next one-finger touch picks.
            picking = false;
            pickHex = null;
            emitEyedropper('preview-end');
          }
          p0 = null;
          p1 = null;
          return;
        }

        // Too late, or the first finger already moved too far to be
        // a gesture start — just ignore this extra touch.
        return;
      }

      if (pendingTouch || activePointerId !== null) return;

      const point = toCanvasPoint(event);
      activePointerId = event.pointerId;
      strokeBlocked = paintBlockReason();
      container.setPointerCapture(event.pointerId);

      const local = toLocalPoint(event);
      pendingTouch = {
        pointerId: event.pointerId,
        startTime: event.timeStamp,
        startLocal: local,
        lastLocal: local,
      };

      if (eyedropperArmed) {
        beginPick(point);
        return;
      }

      if (tool === 'fill') {
        // Fills right away (no latency), but stays a gesture candidate
        // like a stroke: a second finger in the window reverts it from
        // the committed copy. It commits on pointerup.
        floodFill(point);
        return;
      }

      beginStroke(point);
      return;
    }

    // Non-touch (pen, mouse): unchanged, immediate draw, no gesture
    // candidacy at all — see the comment above pendingTouch for why.
    if (activePointerId !== null || gesture || pendingTouch) return;

    activePointerId = event.pointerId;
    strokeBlocked = paintBlockReason();
    container.setPointerCapture(event.pointerId);

    if (eyedropperArmed) {
      beginPick(toCanvasPoint(event));
      return;
    }

    if (tool === 'fill') {
      floodFill(toCanvasPoint(event));
      return;
    }

    beginStroke(toCanvasPoint(event));
  }

  function onPointerMove(event) {
    if (swallowed.has(event.pointerId)) return;
    if (adjusting) {
      adjustMove(event);
      return;
    }
    if (gesture && gesture.pointerIds.includes(event.pointerId)) {
      const local = toLocalPoint(event);
      const prev = gesture.points.get(event.pointerId);
      gesture.totalMovement += distance(local, prev);
      gesture.points.set(event.pointerId, local);

      // Three fingers: just track the points; it's classified on lift
      // and never moves the view.
      if (gesture.threeFinger) return;

      const [idA, idB] = gesture.pointerIds;
      const pA = gesture.points.get(idA);
      const pB = gesture.points.get(idB);
      const currentMidpoint = midpoint(pA, pB);
      const currentDistance = Math.max(1, distance(pA, pB));

      // Incremental, shortest-path angle tracking — see the comment
      // on gesture.lastAngle at gesture creation for why this can't
      // just be (currentAngle - startAngle).
      const currentAngle = angleBetween(pA, pB);
      gesture.accumulatedRotation += shortestAngleDelta(gesture.lastAngle, currentAngle);
      gesture.lastAngle = currentAngle;
      const rotation = gesture.startRotation + gesture.accumulatedRotation;

      const next = computeGestureTransform({
        natLeft, natTop,
        startScale: gesture.startScale,
        startRotation: gesture.startRotation,
        startX: gesture.startX,
        startY: gesture.startY,
        startMidpointLocal: gesture.startMidpoint,
        startDistance: gesture.startDistance,
        rotation,
        currentMidpointLocal: currentMidpoint,
        currentDistance,
      });

      viewportScale = next.scale;
      viewportRotation = rotation;
      viewportX = next.x;
      viewportY = next.y;
      applyViewport();
      return;
    }

    if (pendingTouch && event.pointerId === pendingTouch.pointerId) {
      pendingTouch.lastLocal = toLocalPoint(event);

      const moved = distance(pendingTouch.lastLocal, pendingTouch.startLocal);
      const elapsed = event.timeStamp - pendingTouch.startTime;
      if (elapsed > GESTURE_WINDOW_MS || moved > GESTURE_MOVEMENT_THRESHOLD_PX) {
        // Window's closed, or this is clearly a real stroke, not a
        // gesture candidate — stop tracking it as pending. The stroke
        // itself keeps going via the activePointerId path below; this
        // only stops it from being revertible.
        pendingTouch = null;
      }
    }

    if (event.pointerId !== activePointerId) return;
    if (picking) {
      movePick(toCanvasPoint(event));
      return;
    }
    if (tool === 'fill') return; // nothing to drag for fill

    // Coalesced events give the actual sampled points between the
    // last two animation frames' worth of pointermove — using them
    // instead of just the latest point avoids losing detail on fast
    // strokes when the browser throttles move events.
    const events = typeof event.getCoalescedEvents === 'function'
      ? event.getCoalescedEvents()
      : [];

    for (const e of (events.length ? events : [event])) {
      extendStroke(toCanvasPoint(e));
    }
  }

  function onPointerUp(event) {
    if (swallowed.has(event.pointerId)) {
      swallowed.delete(event.pointerId);
      if (container.hasPointerCapture?.(event.pointerId)) container.releasePointerCapture(event.pointerId);
      return;
    }
    if (adjusting) {
      adjustUp(event);
      return;
    }
    if (gesture && gesture.pointerIds.includes(event.pointerId)) {
      // Ending either finger ends the gesture entirely — drawing
      // doesn't resume with whichever pointer is still down, to avoid
      // a stray mark right as a pinch/pan ends. The other pointer's
      // future move/up events fall through every branch below as a
      // no-op once gesture is cleared, since it was never tracked as
      // pendingTouch or activePointerId.
      // The lifted finger's final position counts too.
      if (event.type !== 'pointercancel') {
        gesture.points.set(event.pointerId, toLocalPoint(event));
      }

      for (const id of gesture.pointerIds) {
        if (container.hasPointerCapture?.(id)) container.releasePointerCapture(id);
      }
      const ended = gesture;
      gesture = null;

      // A cancelled gesture (system took over) does nothing.
      if (event.type === 'pointercancel') return;

      if (ended.threeFinger) {
        handleThreeFingerEnd(ended, event.timeStamp);
        return;
      }

      const wasTap = isQuickTap(event.timeStamp - ended.startTime, ended.totalMovement);
      if (!wasTap) {
        lastTwoFingerTapTime = null;
        return;
      }
      // A tap shouldn't leave the view nudged by finger jitter.
      restoreGestureStartViewport(ended);
      if (isDoubleTap(lastTwoFingerTapTime, event.timeStamp)) {
        lastTwoFingerTapTime = null;
        resetViewport();
      } else {
        lastTwoFingerTapTime = event.timeStamp;
      }
      return;
    }

    if (pendingTouch && event.pointerId === pendingTouch.pointerId) {
      pendingTouch = null;
      // Falls through to the normal endStroke() below — this was
      // just a solo stroke that never grew a second finger.
    }

    if (event.pointerId !== activePointerId) return;
    if (container.hasPointerCapture?.(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }
    if (picking) {
      if (event.type === 'pointercancel') pickHex = null; // system took over
      else movePick(toCanvasPoint(event));
      endPick();
      return;
    }
    endStroke();
  }

  function handleThreeFingerEnd(ended, now) {
    const starts = ended.pointerIds.map((id) => ended.startPoints.get(id));
    const currents = ended.pointerIds.map((id) => ended.points.get(id));
    const startC = centroid(starts);
    const endC = centroid(currents);
    let maxTravel = 0;
    for (let i = 0; i < starts.length; i++) {
      maxTravel = Math.max(maxTravel, distance(starts[i], currents[i]));
    }
    const kind = classifyThreeFinger({
      durationMs: now - ended.firstTouchTime,
      dx: endC.x - startC.x,
      dy: endC.y - startC.y,
      maxTravel,
    });
    lastTwoFingerTapTime = null;
    if (kind === 'tap' || kind === 'swipe-left') emitGesture('undo');
    else if (kind === 'swipe-right') emitGesture('redo');
  }

  // Input is heard on the whole canvas area, not just the page: a
  // gesture works with fingers on the dark backdrop around it (as in
  // Sketchbook/Procreate — and it's most of the screen when zoomed
  // out), and a stroke can start off the page and paint from where it
  // crosses on. Positions are already measured from the area
  // (toLocalPoint), so nothing else changes. Off-page stamps are simply
  // clipped; a fill tap off the page does nothing.
  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);
  // Pointer capture should keep move/up events routed here even if
  // the pointer slides off the canvas edge mid-stroke/gesture, but
  // this is a belt-and-suspenders fallback in case capture isn't
  // honored.
  container.addEventListener('pointerleave', (event) => {
    const isTracked = event.pointerId === activePointerId
      || swallowed.has(event.pointerId)
      || adjustPointers.has(event.pointerId)
      || (pendingTouch && event.pointerId === pendingTouch.pointerId)
      || (gesture && gesture.pointerIds.includes(event.pointerId));
    if (isTracked && !container.hasPointerCapture?.(event.pointerId)) {
      onPointerUp(event);
    }
  });

  // Makes `id` the layer the tools paint on, and resyncs the committed
  // copy to it (the copy only ever mirrors the active layer).
  function activate(id) {
    const surface = surfaces.get(id);
    if (!surface) return false;
    if (canvas) canvas.classList.remove('pp-layer--active');
    activeLayerId = id;
    canvas = surface.canvas;
    ctx = surface.ctx;
    canvas.classList.add('pp-layer--active');
    dirty = null;
    syncCommitted({ x: 0, y: 0, w: width, h: height });
    return true;
  }

  return {
    // The wrapper element (what's on screen as "the canvas").
    canvasElement: stack,
    setTool(next) {
      tool = next;
    },
    // Not called anywhere yet — only one brush exists (see brush.js)
    // — but the API accepting a brush instead of hardcoding roundBrush
    // is the seam itself, so it's here from the start.
    setBrush(next) {
      brush = next;
    },
    setBrushSize(px) {
      // Fill has no size concept (a flood fill has no radius) — no
      // memory slot for it, so setting size while Fill is active is
      // a no-op rather than silently creating a meaningless entry.
      if (tool === 'fill') return;
      brushSizes[tool] = px;
    },
    // Lets ui.js sync the size slider to the newly active tool's
    // remembered size when the tool changes. Returns null for fill,
    // meaning "no size control applies."
    getBrushSize() {
      return tool === 'fill' ? null : brushSizes[tool];
    },
    setColor(hex) {
      color = hex;
    },

    // Eyedropper (see above). Arming while a touch is down waits for
    // the next one. listener({ type, hex }): 'preview' (color under the
    // finger), 'preview-end' (lifted without picking, or became a
    // gesture — still armed), 'pick' (done; disarmed).
    setEyedropper(armed) {
      eyedropperArmed = armed === true;
    },
    isEyedropperArmed() {
      return eyedropperArmed;
    },
    onEyedropper(listener) {
      eyedropperListeners.add(listener);
      return () => eyedropperListeners.delete(listener);
    },

    // Current tool settings, in the shape sanitizeToolSettings()
    // returns — what main.js saves, and what ui.js syncs its controls
    // from after applySettings().
    getSettings() {
      return { tool, color, brushSizes: { ...brushSizes } };
    },

    // Applies saved settings, cleaning them first (see
    // sanitizeToolSettings), so callers can pass raw stored data.
    applySettings(raw) {
      const clean = sanitizeToolSettings(raw);
      tool = clean.tool;
      color = clean.color;
      Object.assign(brushSizes, clean.brushSizes);
    },

    // Undoable like any edit. Clearing an already-blank layer is a
    // no-op, so it doesn't add an undo step that does nothing.
    clear() {
      if (isBusy() || !ctx) return;
      const reason = paintBlockReason();
      if (reason) {
        for (const listener of blockedListeners) listener(reason);
        return;
      }
      const before = committedCtx.getImageData(0, 0, width, height);
      if (!hasPaint(before.data)) return;
      ctx.clearRect(0, 0, width, height);
      committedCtx.clearRect(0, 0, width, height);
      notifyChange({ rect: { x: 0, y: 0, w: width, h: height }, before, layerId: activeLayerId, tool: 'clear' });
    },

    // --- undo/redo seam (step 2b) ---

    // True while a stroke, pending touch or gesture is in progress —
    // main.js skips undo/redo then, so a button tapped with another
    // finger can't swap pixels out from under a live stroke.
    isBusy,

    // Writes `patch` (ImageData) at rect on layer `layerId` (default:
    // the active layer) and returns the pixels it replaced. Undo and
    // redo are both this one call. The layer may not be the active one
    // — then it's written directly and the committed copy is left
    // alone; for the active layer the copy is kept in sync. Returns
    // null if that layer isn't loaded. Doesn't fire onChange — main.js
    // schedules the save itself.
    swapRegion(rect, patch, layerId = activeLayerId) {
      const surface = surfaces.get(layerId);
      if (!surface) return null;
      const isActive = layerId === activeLayerId;
      const source = isActive ? committedCtx : surface.ctx;
      const replaced = source.getImageData(rect.x, rect.y, rect.w, rect.h);
      surface.ctx.putImageData(patch, rect.x, rect.y);
      if (isActive) committedCtx.putImageData(patch, rect.x, rect.y);
      return replaced;
    },

    // Calls listener('undo' | 'redo') for the three-finger gestures.
    // Returns an unsubscribe function.
    onGesture(listener) {
      gestureListeners.add(listener);
      return () => gestureListeners.delete(listener);
    },

    // --- persistence seam (step 2a) and layers (step 2c) ---
    //
    // The canvas doesn't know about storage or the schema beyond the
    // layer fields it renders; main.js moves pixels between the two
    // through these.

    // Calls `listener({ rect, before, layerId })` after every committed
    // edit (stroke end, fill, clear) — before is the rect's ImageData
    // from before the edit. Returns an unsubscribe function.
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },

    // A layer's pixels (default: the active layer) as a PNG Blob.
    // toBlob encodes asynchronously, so this doesn't block drawing.
    exportPNG(layerId = activeLayerId) {
      const surface = surfaces.get(layerId);
      if (!surface) return Promise.reject(new Error(`Layer ${layerId} is not loaded`));
      return new Promise((resolve, reject) => {
        surface.canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Canvas PNG export failed'));
        }, 'image/png');
      });
    },

    // Shows a frame: `layers` is the project's layer list (bottom
    // first; only id/visible/opacity are read), `images` a Map of
    // layer id -> already-decoded image (ImageBitmap, or anything
    // drawImage accepts; missing = blank). Layer canvases whose id is
    // still in the list are reused, so moving between frames doesn't
    // reallocate ~8 MB per layer; the rest are released.
    //
    // Synchronous on purpose: main.js decodes the saved PNGs *before*
    // calling this, so there's no window where a stroke could land and
    // then be wiped by a late-arriving load. Doesn't fire onChange —
    // loading isn't an edit.
    loadFrame({ layers, activeLayerId: nextActive, images = new Map() }) {
      applyLayers(layers);
      for (const id of order) {
        const surface = surfaces.get(id);
        surface.ctx.clearRect(0, 0, width, height);
        const image = images.get(id);
        if (image) surface.ctx.drawImage(image, 0, 0, width, height);
      }
      if (surfaces.has(nextActive)) activate(nextActive);
      else if (activeLayerId !== null) activate(activeLayerId); // resync the copy
    },

    // Makes the layer stack match `layers` (same shape as loadFrame)
    // without touching any existing layer's pixels: new ids get blank
    // canvases, missing ids are released, order and visible/opacity/
    // locked are applied. For add/delete/reorder/property changes.
    syncLayers(layers) {
      applyLayers(layers);
    },

    // Replaces one layer's pixels with an already-decoded image (or
    // blank for null) — how a layer brought back by undo gets its saved
    // pixels. Doesn't fire onChange.
    setLayerImage(id, image) {
      const surface = surfaces.get(id);
      if (!surface) return;
      surface.ctx.clearRect(0, 0, width, height);
      if (image) surface.ctx.drawImage(image, 0, 0, width, height);
      if (id === activeLayerId) {
        dirty = null;
        syncCommitted({ x: 0, y: 0, w: width, h: height });
      }
    },

    // Switches which layer the tools paint on. Refused (returns false)
    // mid-stroke or mid-gesture, or for an unknown layer.
    setActiveLayer(id) {
      if (isBusy()) return false;
      return activate(id);
    },

    getActiveLayerId() {
      return activeLayerId;
    },

    // Updates one layer's display/lock: { visible?, opacity? (0-1),
    // locked? }.
    setLayerProps(id, props) {
      const surface = surfaces.get(id);
      if (!surface) return;
      if (typeof props.visible === 'boolean') surface.visible = props.visible;
      if (typeof props.opacity === 'number') {
        surface.opacity = Math.min(1, Math.max(0, props.opacity));
      }
      if (typeof props.locked === 'boolean') surface.locked = props.locked;
      applySurfaceStyle(surface);
    },

    // Draws a scaled-down copy of a layer into `target` (a small
    // <canvas>), over a cleared background — the layers panel's
    // thumbnails. Cheap enough to call after each committed edit.
    drawThumbnail(id, target) {
      const surface = surfaces.get(id);
      const tctx = target.getContext('2d');
      tctx.clearRect(0, 0, target.width, target.height);
      if (surface) tctx.drawImage(surface.canvas, 0, 0, target.width, target.height);
    },

    // A layer's live pixels as something to drawImage from (its canvas),
    // or null if it isn't loaded — how the open frame is flattened for
    // the frame cache (4a-ii), unsaved strokes included. Read-only:
    // draw from it, never into it, or the edit skips undo and saving.
    getLayerImage(id) {
      return surfaces.get(id)?.canvas ?? null;
    },

    // Tears the canvas down when the editor closes (back to the
    // gallery): stops watching for resizes, ignores input, and frees
    // every canvas's pixel memory right away by shrinking it to 0×0 —
    // iOS reclaims detached canvases lazily, and the next project's
    // layers need that memory. Unusable afterwards.
    destroy() {
      areaObserver.disconnect();
      inputBlocked = true;
      for (const surface of surfaces.values()) {
        surface.canvas.width = 0;
        surface.canvas.height = 0;
      }
      surfaces.clear();
      reference.destroy();
      order = [];
      canvas = null;
      ctx = null;
      for (const c of [committedCanvas, scratchCanvas]) {
        c.width = 0;
        c.height = 0;
      }
      freePlaybackCanvas();
      freeOnionCanvas();
      playbackTapListeners.clear();
      debugListeners.clear();
      changeListeners.clear();
      gestureListeners.clear();
      eyedropperListeners.clear();
      blockedListeners.clear();
      stack.remove();
    },

    // --- playback (4b) ---

    // While true, a touch on the canvas area stops playback (onPlaybackTap)
    // instead of drawing; see `swallow` above.
    setPlaybackInput(on) {
      playbackInput = on === true;
    },

    // Calls listener() when a touch lands while playback input is on.
    // Returns an unsubscribe function.
    onPlaybackTap(listener) {
      playbackTapListeners.add(listener);
      return () => playbackTapListeners.delete(listener);
    },

    // The playback picture's 2D context (full canvas size), shown above
    // the layers; created if needed. Never part of readVisible: it's
    // not her drawing.
    getPlaybackContext() {
      if (!playbackCanvas) {
        playbackCanvas = document.createElement('canvas');
        playbackCanvas.width = width;
        playbackCanvas.height = height;
        playbackCanvas.className = 'pp-layer pp-playback';
        stack.appendChild(playbackCanvas);
      }
      return playbackCanvas.getContext('2d');
    },

    // --- onion skin (4c) ---

    // The ghost canvas's 2D context (full canvas size), over the
    // reference image and under every layer; created if needed. Never
    // part of readVisible: ghosts aren't her drawing.
    getOnionContext() {
      if (!onionCanvas) {
        onionCanvas = document.createElement('canvas');
        onionCanvas.width = width;
        onionCanvas.height = height;
        onionCanvas.className = 'pp-onion';
        reference.element.after(onionCanvas);
      }
      return onionCanvas.getContext('2d');
    },

    // Takes the ghosts away and frees their canvas.
    hideOnion() {
      freeOnionCanvas();
    },

    // DEV ONLY: listener(event, details) for the activity log.
    onDebug(listener) {
      debugListeners.add(listener);
      return () => debugListeners.delete(listener);
    },

    // Takes the playback picture away and frees its memory.
    hidePlayback() {
      freePlaybackCanvas();
    },

    // Ignores new touches while true — main.js sets it around async
    // work (bringing a layer back from storage) so a stroke can't land
    // on pixels that are about to be replaced.
    setInputBlocked(next) {
      inputBlocked = next === true;
    },

    // Calls listener('locked' | 'hidden') when a stroke, fill or Clear
    // was refused because of the active layer. Returns an unsubscribe
    // function.
    onBlocked(listener) {
      blockedListeners.add(listener);
      return () => blockedListeners.delete(listener);
    },

    // --- reference image (step 3a) ---
    //
    // main.js owns which image a frame has; the canvas only shows it.

    // Shows `image` (decoded; drawImage-able) keyed by `key` (its
    // blobRef) at `placement` ({ x, y, scale, rotation, opacity,
    // flipX, flipY }), or
    // nothing for a null key. A key that's already showing keeps its
    // pixels — pass image null then to change only the placement.
    setReference(key, image, placement) {
      reference.set(key, image, placement);
    },
    // The key showing now (null if none) — main.js skips decoding when
    // the next frame shares it.
    getReferenceKey() {
      return reference.key();
    },
    // Its placement now, including adjust-mode moves (null if none).
    getReferencePlacement() {
      return reference.placement();
    },
    getReferenceSize() {
      return reference.size();
    },
    // A finger still on the image carries on from the new placement
    // (a flip mid-drag isn't undone by the next move).
    setReferencePlacement(placement) {
      reference.setPlacement(placement);
      if (adjusting && adjustPointers.size > 0) restartAdjustMotion(performance.now());
    },
    // Hide images (project-wide): off screen and out of readVisible.
    setReferenceHidden(hidden) {
      reference.setHidden(hidden);
    },

    // Adjust mode on/off: touches move the reference instead of
    // drawing or moving the view (see adjust mode above). Refused
    // (false) while a stroke or gesture is in progress.
    setAdjusting(next) {
      const on = next === true;
      if (on === adjusting) return true;
      if (on && isBusy()) return false;
      endAdjustTouches();
      adjusting = on;
      lastTwoFingerTapTime = null;
      stack.classList.toggle('is-adjusting', on);
      return true;
    },
    isAdjusting() {
      return adjusting;
    },

    // Developer tool (memory stress test): fills a whole layer with
    // `color` as one undoable edit, through the same onChange path as
    // a stroke. Ignores lock/visibility on purpose.
    devFillLayer(id, color) {
      const surface = surfaces.get(id);
      if (!surface || isBusy()) return;
      const isActive = id === activeLayerId;
      const before = (isActive ? committedCtx : surface.ctx).getImageData(0, 0, width, height);
      surface.ctx.save();
      surface.ctx.globalCompositeOperation = 'source-over';
      surface.ctx.globalAlpha = 1;
      surface.ctx.fillStyle = color;
      surface.ctx.fillRect(0, 0, width, height);
      surface.ctx.restore();
      if (isActive) syncCommitted({ x: 0, y: 0, w: width, h: height });
      notifyChange({ rect: { x: 0, y: 0, w: width, h: height }, before, layerId: id, tool: 'dev' });
    },
  };
}
