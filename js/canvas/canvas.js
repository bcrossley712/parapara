// js/canvas/canvas.js
//
// Owns: Pointer Events input, brush engine, stroke-layer compositing.
// Onion-skin rendering of neighboring frames lands with timeline/
// (step 4). Fill and smudge land once draw/erase feel is confirmed
// on the actual device — see PROJECT_NOTES.md build order.
//
// No frame/project data model wired in yet (that's storage/, step 2)
// — this owns a single in-memory canvas sized to the agreed default
// (1920x1080, see architectural decisions) and is used directly by
// ui/ui.js for now. Once storage/ exists, this should read/write the
// frame's strokeLayer instead of owning its own bitmap.
//
// Talks to other modules only through the shared frame/project data
// shapes (see PROJECT_NOTES.md schema) once those exist — no reaching
// into timeline/storage internals directly.

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;

export function initCanvas(container, options = {}) {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'pp-canvas';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let tool = 'draw';      // 'draw' | 'erase'
  let brushSize = 6;      // px, in canvas coordinate space (not CSS px)
  let color = '#2b2b2b';  // draw color; unused for erase

  // Pressure/tilt from PointerEvent aren't read yet — deliberately,
  // per the architecture note that the brush engine shouldn't bake in
  // assumptions about them. They're there on the event when Pencil
  // support is added later; wiring them into line width is a later,
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
  // curve below, so they're tracked directly rather than growing an
  // array for the whole stroke.
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

  function beginStroke(point) {
    p0 = null;
    p1 = point;

    ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = brushSize;

    // Draw a dot immediately so a tap with no movement still leaves a
    // mark instead of rendering nothing.
    ctx.beginPath();
    ctx.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function extendStroke(point) {
    const p2 = point;

    if (p0 === null) {
      // Second point of the stroke — not enough history yet for the
      // midpoint technique below, so draw a plain segment.
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    } else {
      // Quadratic midpoint smoothing: curve through the midpoints of
      // consecutive points rather than connecting raw sample points
      // with straight segments, which is what produces the jagged/
      // faceted look on sampled pointer input.
      const mid1 = midpoint(p0, p1);
      const mid2 = midpoint(p1, p2);
      ctx.beginPath();
      ctx.moveTo(mid1.x, mid1.y);
      ctx.quadraticCurveTo(p1.x, p1.y, mid2.x, mid2.y);
      ctx.stroke();
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
    beginStroke(toCanvasPoint(event));
  }

  function onPointerMove(event) {
    if (event.pointerId !== activePointerId) return;

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
    setBrushSize(px) {
      brushSize = px;
    },
    setColor(hex) {
      color = hex;
    },
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
