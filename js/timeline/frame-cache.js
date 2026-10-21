// js/timeline/frame-cache.js
//
// Owns: the flattened-frame cache's bookkeeping (step 4a-ii) — which
// frames are up to date, which to rebuild next, and throwing away
// results that went stale while they were being built. What a frame's
// cached value *is* (a full-size PNG of its layers plus a tile-sized
// copy) and how it's built belongs to the caller (main.js, through
// canvas/render-frame.js); this file never touches pixels, the DOM or
// storage, so it's unit-tested (tests/unit/frame-cache.test.js).
//
// Invalidation (PROJECT_NOTES.md, step 4):
//   - The layer signature (layerSignature) covers what every frame
//     shares: which layers show, in what order, at what opacity. A
//     change makes every entry stale at once, without touching any —
//     dragging the opacity slider only swaps a string.
//   - Each frame's content version is bumped by touch() whenever its
//     pixels change (a stroke, fill, Clear, undo/redo on it).
//   An entry is fresh when both match what it was built with. Changing
//   the signature back (undoing an opacity change) makes old entries
//   fresh again — they really are what she'd see.
//
// Rebuilding runs in the background, one frame at a time: it waits for
// changes to settle (`settleMs`, so a slider drag or a run of strokes
// doesn't start a rebuild per step), only while canWork() says she
// isn't mid-stroke or mid-change, and goes nearest the current frame
// first (the open frame, then its neighbors — what onion skin and the
// tiles in view need). A build that fails isn't retried until that
// frame or the signature changes, so a bad frame can't spin.

// The part of the layer list every flattened frame depends on: visible
// layers bottom-up with their opacity. Hidden and fully transparent
// layers draw nothing, so they're left out (hiding one that's already
// at 0% opacity changes nothing). Names and lock don't show.
export function layerSignature(layers) {
  return layers
    .filter((layer) => layer.visible && layer.opacity > 0)
    .map((layer) => `${layer.id}:${layer.opacity}`)
    .join('|');
}

const defaultTimers = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id),
};

// build(frameId): Promise<value> — flattens that frame now.
// canWork(): false while background work would get in the way.
// onUpdate(frameId, value): a fresh value was stored.
// dispose(value): a value is no longer held (replaced, its frame
//   removed, a stale result thrown away, or destroy()).
// onError(err, frameId): a build failed.
export function createFrameCache({
  build,
  canWork = () => true,
  onUpdate = () => {},
  dispose = () => {},
  onError = () => {},
  settleMs = 300,
  pollMs = 250,
  yieldMs = 16,
  timers = defaultTimers,
}) {
  const entries = new Map();  // frameId -> { value, sig, version }
  const versions = new Map(); // frameId -> content version (missing = 0)
  const failed = new Map();   // frameId -> the sig#version that failed
  let order = [];
  let currentId = null;
  let signature = '';
  let timer = null;
  let running = null;         // frameId being built
  let settleUntil = 0;
  let destroyed = false;

  const versionOf = (id) => versions.get(id) ?? 0;
  const keyOf = (id) => `${signature}#${versionOf(id)}`;

  function isFresh(id) {
    const entry = entries.get(id);
    return Boolean(entry) && entry.sig === signature && entry.version === versionOf(id);
  }

  function needsBuild(id) {
    return !isFresh(id) && failed.get(id) !== keyOf(id);
  }

  // Nearest the current frame first: the frame itself, then one after,
  // one before, two after, … (the next frame is what she draws toward).
  function nextToBuild() {
    const at = Math.max(0, order.indexOf(currentId));
    for (let d = 0; d < order.length; d++) {
      const candidates = d === 0 ? [at] : [at + d, at - d];
      for (const i of candidates) {
        if (i < 0 || i >= order.length) continue;
        if (needsBuild(order[i])) return order[i];
      }
    }
    return null;
  }

  function schedule(ms) {
    if (destroyed) return;
    if (timer !== null) timers.clear(timer);
    timer = timers.set(run, Math.max(0, ms));
  }

  // Something changed: rebuilding waits until changes stop for settleMs.
  function invalidated() {
    settleUntil = timers.now() + settleMs;
    if (!running) schedule(settleMs);
  }

  async function run() {
    timer = null;
    if (destroyed || running) return;
    const wait = settleUntil - timers.now();
    if (wait > 0) {
      schedule(wait);
      return;
    }
    const id = nextToBuild();
    if (!id) return;
    if (!canWork()) {
      schedule(pollMs);
      return;
    }
    const sig = signature;
    const version = versionOf(id);
    running = id;
    let value = null;
    let error = null;
    try {
      value = await build(id);
    } catch (err) {
      error = err;
    }
    running = null;
    if (destroyed) {
      if (value) dispose(value);
      return;
    }
    if (error) {
      failed.set(id, `${sig}#${version}`);
      onError(error, id);
    } else if (order.includes(id) && sig === signature && version === versionOf(id)) {
      const old = entries.get(id);
      entries.set(id, { value, sig, version });
      onUpdate(id, value);
      if (old) dispose(old.value);
    } else {
      dispose(value); // went stale while it was being built
    }
    schedule(yieldMs); // let a touch or a frame through between builds
  }

  function kick() {
    if (destroyed || running || timer !== null) return;
    schedule(0);
  }

  return {
    // The visible-layer signature now (layerSignature(project.layers)).
    setSignature(next) {
      if (next === signature) return;
      signature = next;
      invalidated();
    },

    // The timeline (frame ids in order) and the frame she's on, which
    // decides what's rebuilt first. Entries for frames no longer listed
    // are dropped. Cheap to call on every refresh.
    setFrames(frameIds, current) {
      order = [...frameIds];
      currentId = current;
      const listed = new Set(order);
      for (const [id, entry] of entries) {
        if (listed.has(id)) continue;
        entries.delete(id);
        versions.delete(id);
        failed.delete(id);
        dispose(entry.value);
      }
      kick();
    },

    // That frame's pixels changed.
    touch(frameId) {
      versions.set(frameId, versionOf(frameId) + 1);
      invalidated();
    },

    // Try now — e.g. when whatever made canWork() false is over
    // (otherwise it's polled every pollMs).
    kick,

    // The fresh value for a frame, or null if it's stale or missing.
    get(frameId) {
      return isFresh(frameId) ? entries.get(frameId).value : null;
    },

    // The newest value even if stale (stale tiles stay up until they're
    // replaced), or null.
    latest(frameId) {
      return entries.get(frameId)?.value ?? null;
    },

    isFresh,

    // How many listed frames aren't fresh yet (4b's "Getting ready").
    get staleCount() {
      return order.filter((id) => !isFresh(id)).length;
    },

    destroy() {
      destroyed = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
      for (const entry of entries.values()) dispose(entry.value);
      entries.clear();
    },
  };
}
