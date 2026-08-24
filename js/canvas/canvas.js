// js/canvas/canvas.js
//
// Owns: Pointer Events input, brush engine, stroke-layer compositing,
// two-finger pan/zoom (gesture math lives in gestures.js; dispatch —
// deciding whether a touch is a stroke or a gesture — lives here).
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
import {
  distance,
  midpoint,
  isQuickTap,
  computeGestureTransform,
  GESTURE_WINDOW_MS,
  GESTURE_MOVEMENT_THRESHOLD_PX,
} from './gestures.js';

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

  // Deliberately NOT passing { willReadFrequently: true } here, even
  // though smudge/fill do call getImageData. That hint typically
  // pushes the whole canvas onto a software (CPU) rendering path
  // instead of GPU-accelerated — which would slow down every draw/
  // erase stamp too, not just the occasional pixel read. Draw/erase
  // happen far more often than smudge/fill, so trading their
  // performance away to speed up the less-used tools is the wrong
  // direction. If smudge/fill specifically still feel slow after
  // this, that's a narrower problem to solve (e.g. bounding fill's
  // read/write region) rather than reintroducing this.
  const ctx = canvas.getContext('2d');

  // Smudge's scratch buffer: sized once to the largest brush size
  // rather than reallocated per stroke.
  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = MAX_BRUSH_SIZE;
  scratchCanvas.height = MAX_BRUSH_SIZE;
  const scratchCtx = scratchCanvas.getContext('2d');

  let tool = 'draw';      // 'draw' | 'erase' | 'fill' | 'smudge'
  let brush = roundBrush; // only tip today — see brush.js for the seam
  let color = DEFAULT_COLOR;  // draw/fill color; unused for erase/smudge

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

  // --- pan/zoom viewport (two-finger gesture) ---
  //
  // Applied as a CSS transform on the canvas element only — the
  // backing-store bitmap and its 1920x1080 resolution never change.
  // toCanvasPoint() below reads the canvas's live bounding rect on
  // every call, so it automatically accounts for whatever transform
  // is currently applied, with no changes needed there.
  let viewportScale = 1;
  let viewportX = 0;
  let viewportY = 0;

  // The canvas's natural (untransformed, fit-to-screen) box, relative
  // to its container — captured once, and re-captured on resize. This
  // is the fixed reference frame the gesture math works in.
  let natLeft = 0, natTop = 0, natWidth = 0, natHeight = 0;

  function applyViewport() {
    canvas.style.transform = `translate(${viewportX}px, ${viewportY}px) scale(${viewportScale})`;
  }

  function resetViewport() {
    viewportScale = 1;
    viewportX = 0;
    viewportY = 0;
    applyViewport();
  }

  function captureNaturalRect() {
    const areaRect = container.getBoundingClientRect();
    // Clear the transform first so the measured rect is the natural
    // (untransformed) box, not whatever pan/zoom happens to be
    // applied right now.
    canvas.style.transform = '';
    const canvasRect = canvas.getBoundingClientRect();
    natLeft = canvasRect.left - areaRect.left;
    natTop = canvasRect.top - areaRect.top;
    natWidth = canvasRect.width;
    natHeight = canvasRect.height;
    applyViewport();
  }

  captureNaturalRect();

  // Layout may have changed (e.g. iPad rotation) — simplest safe
  // behavior is to reset pan/zoom rather than try to preserve it
  // across a resize.
  window.addEventListener('resize', () => {
    viewportScale = 1;
    viewportX = 0;
    viewportY = 0;
    captureNaturalRect();
  });

  // --- touch-vs-gesture disambiguation ---
  //
  // A touch pointer starts drawing immediately (no added delay) but
  // stays a "pending" gesture candidate for a short window. If a
  // second touch joins within that window while the first has barely
  // moved, both become a two-finger pan/zoom gesture instead — the
  // first pointer's just-drawn mark is reverted from a saved pixel
  // patch. If the window expires (or the first pointer moves too far)
  // without a second touch, it was just a normal solo stroke and
  // nothing further happens — the draw was never delayed waiting to
  // find out.
  //
  // pointerType 'pen' (and mouse, for desktop testing) bypasses all
  // of this and goes straight to drawing — real styli, and hopefully
  // eventually a real Apple Pencil, report reliably enough that no
  // gesture candidacy is needed. Fill is also exempt: it commits its
  // result immediately regardless of pointerType, since reverting an
  // arbitrary flood-filled region isn't a cheap "restore a small
  // patch" operation the way draw/erase's single dot is.
  let pendingTouch = null; // { pointerId, startTime, startLocal, lastLocal, revertPatch }
  let gesture = null;      // { pointerIds, points, startTime, startScale, startX, startY, startMidpoint, startDistance, totalMovement }

  function toCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
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
  }

  // --- revert-patch helpers, used only for the touch/gesture disambiguation below ---

  function capturePatchAt(point, size) {
    const half = size / 2;
    const x = Math.round(point.x - half);
    const y = Math.round(point.y - half);
    return { x, y, data: ctx.getImageData(x, y, size, size) };
  }

  function restorePatch(patch) {
    ctx.putImageData(patch.data, patch.x, patch.y);
  }

  function onPointerDown(event) {
    if (event.pointerType === 'touch') {
      // A third finger, or a second finger arriving after the window
      // has already closed, is treated the same as the palm-rejection
      // heuristic always has: ignored.
      if (gesture) return;

      if (pendingTouch && event.pointerId !== pendingTouch.pointerId) {
        const elapsed = event.timeStamp - pendingTouch.startTime;
        const moved = distance(pendingTouch.lastLocal, pendingTouch.startLocal);

        if (elapsed <= GESTURE_WINDOW_MS && moved <= GESTURE_MOVEMENT_THRESHOLD_PX) {
          // Confirmed: this is a two-finger gesture, not a palm.
          // Revert whatever the first finger had started drawing.
          if (pendingTouch.revertPatch) restorePatch(pendingTouch.revertPatch);
          if (canvas.hasPointerCapture?.(pendingTouch.pointerId)) {
            canvas.releasePointerCapture(pendingTouch.pointerId);
          }

          const firstLocal = pendingTouch.lastLocal;
          const secondLocal = toLocalPoint(event);

          canvas.setPointerCapture(event.pointerId);
          gesture = {
            pointerIds: [pendingTouch.pointerId, event.pointerId],
            points: new Map([
              [pendingTouch.pointerId, firstLocal],
              [event.pointerId, secondLocal],
            ]),
            startTime: event.timeStamp,
            startScale: viewportScale,
            startX: viewportX,
            startY: viewportY,
            startMidpoint: midpoint(firstLocal, secondLocal),
            startDistance: Math.max(1, distance(firstLocal, secondLocal)),
            totalMovement: 0,
          };

          pendingTouch = null;
          activePointerId = null;
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
      canvas.setPointerCapture(event.pointerId);

      const local = toLocalPoint(event);
      pendingTouch = {
        pointerId: event.pointerId,
        startTime: event.timeStamp,
        startLocal: local,
        lastLocal: local,
        revertPatch: null,
      };

      if (tool === 'fill') {
        // Fill commits immediately regardless of pointerType — not a
        // gesture candidate (see the comment above pendingTouch).
        floodFill(point);
        pendingTouch = null;
        return;
      }

      if (tool === 'draw' || tool === 'erase') {
        pendingTouch.revertPatch = capturePatchAt(point, brushSizes[tool]);
      }
      // Smudge draws nothing on pointerdown (see beginStroke) — there
      // is nothing yet to revert, so no patch needed.

      beginStroke(point);
      return;
    }

    // Non-touch (pen, mouse): unchanged, immediate draw, no gesture
    // candidacy at all — see the comment above pendingTouch for why.
    if (activePointerId !== null || gesture || pendingTouch) return;

    activePointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);

    if (tool === 'fill') {
      floodFill(toCanvasPoint(event));
      return;
    }

    beginStroke(toCanvasPoint(event));
  }

  function onPointerMove(event) {
    if (gesture && gesture.pointerIds.includes(event.pointerId)) {
      const local = toLocalPoint(event);
      const prev = gesture.points.get(event.pointerId);
      gesture.totalMovement += distance(local, prev);
      gesture.points.set(event.pointerId, local);

      const [idA, idB] = gesture.pointerIds;
      const pA = gesture.points.get(idA);
      const pB = gesture.points.get(idB);
      const currentMidpoint = midpoint(pA, pB);
      const currentDistance = Math.max(1, distance(pA, pB));

      const next = computeGestureTransform({
        natLeft, natTop,
        startScale: gesture.startScale,
        startX: gesture.startX,
        startY: gesture.startY,
        startMidpointLocal: gesture.startMidpoint,
        startDistance: gesture.startDistance,
        currentMidpointLocal: currentMidpoint,
        currentDistance,
      });

      viewportScale = next.scale;
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
    if (gesture && gesture.pointerIds.includes(event.pointerId)) {
      // Ending either finger ends the gesture entirely — drawing
      // doesn't resume with whichever pointer is still down, to avoid
      // a stray mark right as a pinch/pan ends. The other pointer's
      // future move/up events fall through every branch below as a
      // no-op once gesture is cleared, since it was never tracked as
      // pendingTouch or activePointerId.
      const gestureDuration = event.timeStamp - gesture.startTime;
      const wasTap = isQuickTap(gestureDuration, gesture.totalMovement);

      for (const id of gesture.pointerIds) {
        if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
      }
      gesture = null;

      if (wasTap) resetViewport();
      return;
    }

    if (pendingTouch && event.pointerId === pendingTouch.pointerId) {
      pendingTouch = null;
      // Falls through to the normal endStroke() below — this was
      // just a solo stroke that never grew a second finger.
    }

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
  // the pointer slides off the canvas edge mid-stroke/gesture, but
  // this is a belt-and-suspenders fallback in case capture isn't
  // honored.
  canvas.addEventListener('pointerleave', (event) => {
    const isTracked = event.pointerId === activePointerId
      || (pendingTouch && event.pointerId === pendingTouch.pointerId)
      || (gesture && gesture.pointerIds.includes(event.pointerId));
    if (isTracked && !canvas.hasPointerCapture?.(event.pointerId)) {
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
