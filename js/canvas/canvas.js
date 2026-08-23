// js/canvas/canvas.js
//
// Owns: Pointer Events input, brush engine, stroke-layer compositing.
// Onion-skin rendering of neighboring frames lands with timeline/
// (step 4).
//
// No frame/project data model wired in yet (that's storage/, step 2)
// — this owns a single in-memory canvas sized to the agreed default
// (1920x1080, see architectural decisions) and is used directly by
// ui/ui.js for now. Once storage/ exists, this should read/write the
// active layer's bitmap instead of owning its own single bitmap (see
// the layers decision in PROJECT_NOTES.md — this prototype stays
// single-layer until step 2 builds the real layers UI).
//
// Talks to other modules only through the shared frame/project data
// shapes (see PROJECT_NOTES.md schema) once those exist — no reaching
// into timeline/storage internals directly.

import { roundBrush } from './brush.js';

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

// Upper bound for brush size — shared with ui.js (imported there for
// the size slider's max) so the two don't drift out of sync, and used
// here to size the smudge tool's scratch canvas once instead of
// reallocating it per stroke.
export const MAX_BRUSH_SIZE = 60;

// Smudge: how strongly each drag step blends sampled pixels into the
// new position (0 = no effect, 1 = fully replaces). Fixed for now,
// not yet exposed as a control — brush size is the only shared
// control the toolset decision calls for.
const SMUDGE_STRENGTH = 0.5;

// Fill: per-channel color-distance tolerance for what counts as "the
// same region" to flood. Anti-aliased line edges are never a single
// exact color, so a tolerance of 0 would leave a ring of unfilled
// fringe pixels around every stroke. Fixed default, not yet tuned
// against the real device.
const FILL_TOLERANCE = 32;

export function initCanvas(container, options = {}) {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'pp-canvas';
  container.appendChild(canvas);

  // willReadFrequently: smudge calls getImageData on every drag step
  // and fill calls it once per tap — this hints the browser to keep
  // pixel reads cheap rather than optimizing purely for drawing.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Smudge's scratch buffer: sized once to the largest brush size
  // rather than reallocated per stroke.
  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = MAX_BRUSH_SIZE;
  scratchCanvas.height = MAX_BRUSH_SIZE;
  const scratchCtx = scratchCanvas.getContext('2d');

  let tool = 'draw';      // 'draw' | 'erase' | 'fill' | 'smudge'
  let brush = roundBrush; // only tip today — see brush.js for the seam
  let color = '#2b2b2b';  // draw/fill color; unused for erase/smudge

  // Per-tool brush size memory — draw/erase/smudge each remember
  // their own size independently (matches how Procreate/Sketchbook/
  // etc. behave) rather than one shared size that carries between
  // tools. Fill has no size concept (a flood fill has no radius), so
  // it isn't tracked here.
  const brushSizes = { draw: 6, erase: 6, smudge: 6 };

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

  function toCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // --- draw/erase: stamp the active brush along the smoothed path ---

  function stampAlongLine(a, b) {
    const size = brushSizes[tool];
    const spacing = Math.max(1, size * brush.spacingRatio);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      brush.stamp(ctx, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, size);
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
      brush.stamp(ctx, { x, y }, size);
    }
  }

  // --- smudge: sample a patch behind the stroke, blend it forward ---

  function smudgeStep(from, to) {
    const size = Math.max(2, Math.round(brushSizes.smudge));
    const half = size / 2;

    // Sample a patch centered on the stroke's previous point, then
    // paint it back centered on the new point at partial opacity —
    // repeated every step along a drag, this is what drags color
    // along the path instead of just stamping flat color like
    // draw/erase. Points near the canvas edge sample some
    // out-of-bounds pixels, which come back transparent per spec —
    // fine, it just fades toward transparent at the edge.
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

  function floodFill(point) {
    const startX = Math.round(point.x);
    const startY = Math.round(point.y);
    if (startX < 0 || startY < 0 || startX >= width || startY >= height) return;

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

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

    // Iterative (stack-based) rather than recursive — a recursive
    // flood fill can blow the call stack on a large open region at
    // 1920x1080.
    const stack = [[startX, startY]];
    const visited = new Uint8Array(width * height);
    visited[startY * width + startX] = 1;

    while (stack.length) {
      const [x, y] = stack.pop();
      const idx = (y * width + x) * 4;
      data[idx] = fillColor.r;
      data[idx + 1] = fillColor.g;
      data[idx + 2] = fillColor.b;
      data[idx + 3] = 255;

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

    ctx.putImageData(imageData, 0, 0);
  }

  // --- stroke lifecycle, shared by draw/erase/smudge ---

  function beginStroke(point) {
    p0 = null;
    p1 = point;

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
    brush.stamp(ctx, point, brushSizes[tool]);
  }

  function extendStroke(point) {
    const p2 = point;

    if (tool === 'smudge') {
      smudgeStep(p1, p2);
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
      const mid1 = midpoint(p0, p1);
      const mid2 = midpoint(p1, p2);
      stampAlongQuadratic(mid1, p1, mid2);
    }

    p0 = p1;
    p1 = p2;
  }

  function endStroke() {
    activePointerId = null;
    p0 = null;
    p1 = null;
  }

  function onPointerDown(event) {
    if (activePointerId !== null) return; // palm-rejection heuristic, see above

    activePointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);

    if (tool === 'fill') {
      // Fill is a single tap-and-done action, not a drag — no
      // beginStroke/extendStroke lifecycle needed.
      floodFill(toCanvasPoint(event));
      return;
    }

    beginStroke(toCanvasPoint(event));
  }

  function onPointerMove(event) {
    if (event.pointerId !== activePointerId) return;
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
    if (event.pointerId !== activePointerId) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    endStroke();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  // Pointer capture should keep move/up events routed here even if
  // the pointer slides off the canvas edge mid-stroke, but this is a
  // belt-and-suspenders fallback in case capture isn't honored.
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerId === activePointerId && !canvas.hasPointerCapture?.(event.pointerId)) {
      onPointerUp(event);
    }
  });

  return {
    canvasElement: canvas,
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
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
