# Design Notes — Parapara!

The *why* behind decisions, and lessons from things that went wrong.
**Read on demand**, when working in the area a section covers —
`PROJECT_NOTES.md` is the required read and points here.

Rules a future conversation must follow live in `PROJECT_NOTES.md`
only; this file explains them. If the two ever disagree,
`PROJECT_NOTES.md` wins — fix this file. Play-by-play history belongs
in git commits, not here.

Sections: [Process lessons](#process-lessons) ·
[Stack](#stack) · [Drawing engine](#drawing-engine) ·
[Gestures](#gestures) · [Layers and undo](#layers-and-undo) ·
[Storage](#storage) · [PWA, layout and updates](#pwa-layout-and-updates) ·
[Testing and CI](#testing-and-ci) · [Planned features](#planned-features)

---

## Process lessons

- **Coupled features get flagged at decision time.** Rotation is part
  of the standard two-finger gesture (Procreate/Clip Studio
  twist-to-rotate). It was mentioned once early on, but not raised
  again when "two-finger pinch+pan" was chosen — though it shares the
  same file and transform math. Retrofitting it meant reworking
  `gestures.js`'s anchor math and rewriting `toCanvasPoint`.
- **Remembered state is part of any persistence decision.** 2a saved
  the drawing but not tool, color or sizes; she'd have re-picked her
  color every launch. Sketchbook and Procreate both remember these. It
  was caught on the device, not at scoping.
- **Defaults are conventions too.** Step 1 capped zoom-out at
  fit-to-screen (`MIN_SCALE = 1`) without flagging it; her apps zoom
  out further, and once rotation existed a rotated canvas couldn't be
  seen whole. Found on the device in 2b. Limits and thresholds picked
  as "reasonable defaults" need the same check against her apps as
  features do.
- **Convention catches that worked:** per-tool brush size memory (vs.
  one shared size) and undoable layer operations were both caught by
  checking against her apps before building.
- **Cheap-now scaffolding, example:** `style.css` had `#3a3226` and
  `#f2a65a` hardcoded in several selectors. Naming them (`--pp-ink`,
  `--pp-accent`, …) was trivial at two colors and a handful of
  selectors; every later screen would have repeated the hex or needed
  a risky find-and-replace. It's also most of a design-token system.
  The test: does it make a *near-certain* change cheaper without
  adding real complexity now? Hedging against a feature that might
  not happen is still scope creep.
- **Visual checks in desktop Chromium aren't iPad checks.** The
  settings panel's version line was made `nowrap` after a screenshot
  looked fine; the iPad's system font is wider, and it clipped.
  Layouts must tolerate wider text rather than be tuned to one render.
- **Model choice:** step 2 (dense, interdependent state) moved to an
  Opus-class model. Early payoff: it found the stale service-worker
  pre-cache bug behind the viewport issue, and the shared-origin cache
  bug. (A planned bug-rate comparison against step 1 was never
  tracked; dropped rather than left open.)

## Stack

- **Vanilla JS + native ES modules, no Vue, no bundler.** The hard
  parts (canvas drawing, frame compositing, playback loop) are
  imperative; a reactive framework adds a mental-model split for little
  benefit at this scope. Also matches his preference to avoid an npm
  build step — npm exists only for test tooling.
- **Pointer Events, not Touch Events.** Apple Pencil and finger/stylus
  arrive through the same API; a Pencil just adds `pressure`/`tilt`
  and `pointerType: "pen"`. Pencil support later is a few
  conditionals and brush-curve logic, not an architecture change.
- **Scope-specific folders** so fixing one feature means opening one
  or two files. Modules talk through the shared project/frame data
  shapes, with `main.js` as glue.

## Drawing engine

- **Stamping, not `ctx.stroke()`.** Draw/erase stamp the active brush
  tip along the smoothed path (`brush.js`: `stamp(ctx, point, size)`
  plus `spacingRatio`). A chisel/textured/edge-blending tip is a new
  brush object, not a change to input or smoothing.
- **Smoothing:** quadratic curves through midpoints of consecutive
  samples, plus coalesced pointer events so fast strokes keep detail.
- **Palm rejection:** first pointer down wins; pointers landing while
  a stroke is active are ignored. Works in real use; doesn't handle
  every ordering (e.g. palm first).
- **Fill:** iterative flood fill (a large region can't blow the
  stack), `FILL_TOLERANCE = 32` so anti-aliased edges don't leave a
  fringe. Reads/writes the whole buffer per tap; fast enough on her
  iPad.
- **Smudge tuning math.** Overlapping steps *multiply*: one pass over a
  spot applies ~1/spacingRatio blends. The original strength 0.5 /
  spacing 0.2 gave 1-(1-0.5)^5 ≈ 97% — "goes to a full color line."
  Now 0.18 / 0.5 → 1-(1-0.18)^2 ≈ 33% per pass, so blending builds up
  over a couple of passes. Still not the feel she expects: she showed
  that brushes in other apps soften their own edges, so smudge feel is
  tied to having a broader brush set. Don't retune it in isolation.
- **No `willReadFrequently: true`.** It tends to push the whole canvas
  onto a slower CPU path — hurting draw/erase (constant) to help
  smudge/fill (rare). If those need speed, bound fill's region.

## Gestures

- **Why pan/zoom/rotate came before storage:** the cost lives in the
  pointer-coordinate mapping. Building storage, layers and image
  transforms on a no-zoom assumption would have meant retrofitting all
  of them.
- **Mechanism:** a CSS `translate() rotate() scale()` on the wrapper
  that holds the layer canvases (`.pp-canvas`); the bitmaps never
  change. `gestures.js` is pure math; `canvas.js`
  dispatches.
- **`toCanvasPoint` is analytic** because `getBoundingClientRect()` of
  a rotated element is the axis-aligned box *around* it.
- **Rotation accumulates frame to frame** (`shortestAngleDelta`):
  `atan2` jumps ~2π at ±180°, so diffing against the start angle snaps
  on a long twist. Scale/translate are recomputed from start values,
  which avoids drift.
- **Pinch vs. stroke.** Her stylus almost certainly reports
  `pointerType: 'touch'` like a finger. A touch draws immediately (no
  latency) but stays a gesture candidate for `GESTURE_WINDOW_MS`
  (150 ms) while it moves under `GESTURE_MOVEMENT_THRESHOLD_PX` (8 px).
  A second touch in that window reverts the first mark from the
  committed copy (see Layers and undo) and both become a gesture. `pen`/mouse skip this, which
  is also why a real Pencil will slot in cleanly. Thresholds are
  reasoned defaults, not tuned on her stylus — retune there first if it
  misfires. Fill used to be exempt from the revert (a flood fill wasn't
  a cheap patch to restore), which meant a pinch with Fill active
  filled and never zoomed; since 2b the committed copy makes reverting
  any uncommitted area cheap, so fill is a candidate too. Lifting
  either finger ends the gesture, and drawing doesn't resume with the other finger — avoids a stray mark
  as a pinch ends.
- **Sketchbook vs. Procreate mapping.** She uses Sketchbook most, and
  its defaults differ: Sketchbook three-finger tap = undo, three-finger
  swipe left/right = undo/redo, two-finger double-tap = fit view;
  Procreate two-finger tap = undo, three-finger tap = redo. Two-finger
  single tap does nothing, so Procreate habits don't misfire. Source:
  [Sketchbook gesture guide](https://help.sketchbook.com/docs/gestures).
  Sketchbook lets users remap, so confirm what *she* does. (She mostly
  uses the undo buttons, so the gestures are a nicety.)
- **Three-finger recognition rides on the two-finger gesture:** the
  third finger must join within 200 ms with little movement, which
  undoes any tiny pan/zoom the first two caused. It's classified once,
  on the first finger's lift — tap, or a mostly-horizontal swipe — and
  never moves the view. Firing on lift (not mid-swipe) keeps one swipe
  = one step.
- **The touch-listener exception.** iPadOS has a system three-finger
  undo/redo with its own HUD. Pointer Events can't cancel a system
  gesture, so a non-passive touch listener calls `preventDefault()`
  with 3+ touches down. Cancelling `touchstart` shouldn't suppress
  pointer events in WebKit, but that's unverified on the device — if
  three-finger gestures stop registering, remove this listener first.
- **Input is heard on the whole canvas area, not just the page.**
  Originally the listeners sat on the canvas element, so a finger on
  the dark backdrop didn't exist to the app and a gesture with one
  finger off the page failed — worse once zoom-out to 0.25× made most
  of the screen backdrop. Sketchbook and Procreate treat the whole
  drawing area as live, and let a stroke start off the page.

## Layers and undo

- **Layers reversed an earlier single-bitmap decision**, because she's
  used to Sketchbook-style layers. Caught before storage/undo existed,
  so nothing was thrown away.
- **Layers are shared across the animation (2c), not per frame.** The
  first plan had each frame copy the previous frame's layer list. That
  departs from Flipaclip and Rough Animator, where the layer stack
  belongs to the whole animation: hiding the sketch layer to check
  line art is one tap, not one per frame. Switching cost a one-time
  schema v2 migration while only one frame existed in saved data —
  the one deliberate restructure. Frames keep a `bitmapRefs` map
  rather than deriving blob ids, so existing refs (and the "assigned
  once, never changes" rule) carried over without moving any pixels.
- **One `<canvas>` per layer, stacked, rather than compositing into a
  single visible canvas.** The browser composites on the GPU,
  visibility/opacity are free CSS, and a stroke only touches its own
  layer. She sees no difference from a native app's layers. The view
  transform moved from the canvas to the wrapper.
- **Only the open frame's layers live in memory.** A frame switch
  saves, then loads the next frame's PNGs into the same layer canvases
  (shared layer ids make reuse natural). Memory stays at cap × ~8 MB
  however long the animation gets; the cost is a short decode pause
  per switch, unmeasured on the iPad. Playback/onion skin (step 4)
  will want a separate flattened-frame cache, not all layers loaded.
- **Fill samples all visible layers** (Sketchbook's sample-all,
  Clip Studio's refer-to-other-layers). Without it, filling a color
  layer under line art floods the whole canvas. Smudge stays on the
  active layer. Hidden layers don't count toward the fill.
- **The reference image stays separate from layers** — it has its own
  transform model (position/scale/rotation) that doesn't map onto a
  stroke layer.
- **Raster snapshots, not replayable vector commands.** Smudge has no
  "recipe" to replay, only a pixel result; one snapshot model avoids
  two undo code paths.
- **Layer operations are undoable** on the same stack — an accidental
  layer delete is undoable in Procreate/Photoshop/Krita, and "only
  strokes undo" would have been a surprising gap.
- **Memory is the real constraint.** A 1920×1080 layer is ~8 MB raw;
  iPad Safari caps canvas/tab memory hard. Whole-stack before/after
  snapshots would crash the 9th-gen iPad well before 30 steps. Hence:
  only what changed (usually one layer, cropped to the stroke's bounds),
  only the "before" patch (redo is captured at undo time), and a
  ~150 MB budget alongside the 30-step cap. A typical stroke entry is
  ~0.5–1 MB; a full-canvas fill or Clear ~8 MB. The budget is what
  protects the iPad; 30 steps is conservative next to Procreate.
- **One project-wide history, in memory only.** Per-frame stacks would
  make undo on frame 5 skip what she just did on frame 6. Almost no
  drawing app keeps undo across a relaunch, and persisting snapshots
  would eat storage. (`frame.undoStack` was removed from the draft
  schema for this.)
- **How a stroke's "before" patch is captured: a committed copy.**
  Bounds aren't known until a stroke ends, and a full `getImageData`
  at pointerdown would add latency right where drawing starts. Instead
  an offscreen copy holds the layer as of the last commit; a dirty rect
  grows around each stamp; at commit, the before patch is read from the
  copy for just that rect, and only that rect is re-synced. Cost: one
  layer of memory (~8 MB) and a small blit per stroke.
- **One copy, of the active layer only.** A copy per layer would add
  ~8 MB per layer for nothing — only the active layer is drawn on. In
  2c a layer switch resyncs the copy; undoing an edit on another layer
  writes to that layer directly and leaves the copy alone.
- **One patch per entry, budget counts both stacks.** Undo swaps the
  before patch in and keeps the after; redo reverses it. Same rect,
  same bytes, so moving an entry between stacks never changes the
  total, and redo memory is never "free". Trimming only happens on a
  new edit, which clears redo first.
- **Clear on a blank layer adds nothing**, so undo never does a step
  with no visible effect.
- **2c was built in passes, internals first.** The schema change and
  the move to one canvas per layer shipped with no visible change, so
  a problem on the iPad could be traced to them before any panel or
  frame UI sat on top.
- **Layer cap (8, per project now that layers are shared)** for the
  same memory reason — Procreate caps layers by canvas size and device
  memory too. 8 × ~8 MB ≈ 64 MB of layers; iPad Safari's real canvas
  ceiling is device-dependent and only testable on the iPad (hence the
  fill-all-layers dev tool).
- **A removed layer's pixels stay in storage, not in undo memory.**
  Holding them in the entry would cost up to ~8 MB per delete (or a
  PNG each, still real memory on the iPad). Instead removal saves the
  layer first and keeps the frames' refs in the entry; storage still
  has the pixels when undo brings it back. Add and delete are the same
  two operations (detach/attach) run in opposite directions, so there's
  one code path. The cost is garbage in storage until the next launch,
  when no undo can need it — a sweep deletes blobs nothing references.
  That's also why the sweep must know every kind of blob reference.
- **Drawing on a hidden layer is refused**, like a locked one. Painting
  where she can't see the result would be a surprise; a notice says
  why. Revisit if she expects otherwise.
- **Visibility and lock aren't undoable** — view state, as in
  Photoshop; eye-icon taps filling the 30-step stack would be worse.

## Storage

- **PNG blobs** for layer bitmaps: ~10–50× smaller than raw pixels for
  line art.
- **ArrayBuffer + MIME type, not Blob**, in IndexedDB — older WebKit
  had bugs storing Blobs.
- **`bitmapRef` assigned when a frame or layer is created, never
  changed;** no blob = blank. A stroke save writes only the blob
  store, not the frame.
- **Transactions resolve on *complete*** so "saved" means committed.
  Awaiting non-IndexedDB work inside one lets it auto-commit early.
- **`projectId` indexes on frames/blobs were created up front** so
  project delete (2d) needs no schema upgrade.
- **Autosave timing:** debounce after an edit so a burst of strokes is
  one save; saves never overlap (an older, slower save can't finish
  after a newer one); `flush()` on hide because iPadOS can kill a
  backgrounded app without warning. No automatic retry loop — a
  persistent failure (out of space) would spin.
- **Load before the canvas exists**, including decoding the PNG, so a
  late load can't wipe a fresh stroke. **If loading fails, saving
  stays off** — saving a blank canvas over a drawing that merely
  failed to load would destroy it.
- **Tool settings are app-wide** (one `meta` record) so brush and
  color follow her into another drawing, as in Sketchbook/Procreate.
  Validation is in `canvas.js` because that's where tools and limits
  are defined; each field falls back independently. Failures are only
  logged — losing a color choice isn't worth interrupting her.
- **`persist()` is requested** so iOS is less likely to evict her work;
  it may not be granted, which is why the storage warning is planned.

## PWA, layout and updates

- **Viewport saga.** The app was pushed off the bottom by about the
  status-bar height. Two fixes (safe-area padding, `black-translucent`)
  appeared not to work — very likely because the service worker's
  pre-cache could fill a "new" version with the previous deploy's CSS
  from the HTTP cache (GitHub Pages allows 10 minutes). The real
  layout fix was `position: fixed; inset: 0` instead of `100vh`
  (iPadOS standalone + `black-translucent` miscomputes `vh`), plus
  `cache: 'reload'` on pre-cache so fixes actually arrive.
- **Safe-area dependencies:** `env(safe-area-inset-*)` only resolves
  non-zero under `viewport-fit=cover` + `black-translucent` (under
  `default`, iOS reserves the bar). Padding only insets correctly with
  global `border-box`. `black-translucent` draws white status text
  over the top edge — fine while the rail and stage are dark there.
- **16px inputs:** iOS zooms the page when a smaller text field gets
  focus, and the zoom can stick.
- **ResizeObserver** on the canvas area: iOS layout (safe area,
  rotation) can settle without a window resize event, leaving
  `toCanvasPoint`'s reference box stale.
- **First install must not reload.** `clients.claim()` fires
  `controllerchange` on first install too; reloading then interrupted
  her first session. Found by the e2e suite.
- **The missed update.** The toast vanished and the update didn't land.
  Investigation: updates were only checked on launch, and iPadOS keeps
  home-screen apps suspended for days — now also checked on returning
  to the foreground (test-verified). A worker already mid-install at
  launch is now explicitly watched, but Chromium handled that case
  anyway, so that part is defensive for WebKit and unproven. The exact
  iOS cause wasn't pinned down; the gear's Check for updates / Fresh
  reload are the dependable fallback.
- **Shared-origin cache bug.** GitHub Pages serves all of an account's
  projects from `bcrossley712.github.io`; caches and service-worker
  registrations are per-origin. `sw.js` activate deleted every cache
  but its own — wiping other apps' offline caches on each Parapara!
  update. Now limited to `parapara-` caches. Other projects that copied
  the old handler likely have the same bug.
- **Fresh reload re-fetches with `cache: 'reload'`** because a plain
  reload can still pull files from GitHub's 10-minute HTTP cache.
- **Version comes from the controlling worker**, since that worker
  decides which cached files the page actually got.
- **Gear menu placement** matches Sketchbook/Procreate keeping
  app-level actions behind one gear/wrench. Clear lives there (dev-only)
  rather than on the rail so a stray tap can't wipe a drawing.

## Testing and CI

- **Tests live in the repo** because each step is a new conversation;
  otherwise every conversation rebuilds throwaway scripts or skips
  testing.
- **Tests gate the deploy.** A failure stops it; iPads keep the last
  good version. Gating delays *when* a version is posted, not how fast
  the iPad updates.
- **Exclude-list publishing:** a forgotten exclusion only leaks a
  harmless dev file; a forgotten inclusion would silently break the
  app.
- **Deploy time:** ~20 s before tests, ~2 min after. Most of that was
  fixed setup (fresh machines, installing Chromium + system libraries),
  now reduced with Playwright's prebuilt image. The growing part is
  e2e. Fixed sleeps were ~30% of e2e time; replacing them cut ~35 s →
  ~30 s and stops dead time compounding. Parallel workers need the
  update tests isolated first (they mutate shared server state).
- **The pre-cache test** exists because a module missing from
  `APP_SHELL` isn't versioned with the rest — an iPad can run new
  `ui.js` against old `canvas.js`.
- **A test that passes without its fix proves nothing.** The
  mid-install update test does exactly that in Chromium; it's kept as a
  behavior guard, with that caveat in its comment.

## Gallery

- **Mount/unmount, not reload, to switch projects.** A reload is
  little code but flashes white and cold-starts on every open. The
  editor's outside hooks were few (two document listeners, the
  visibility flush, one ResizeObserver), so tearing it down cleanly
  was cheap. Undo history resetting per project matches Procreate and
  Flipaclip.
- **Reopen where she left off.** Procreate and Sketchbook do;
  Flipaclip and Rough Animator always open the gallery. Matching the
  former kept 2c's behavior (straight into her drawing) for her.
- **Thumbnail id derived from the project id** instead of a
  `thumbnailRef` field (the scoped plan): giving a project a thumbnail
  then never writes the project record, which the open editor also
  saves — no chance of one overwriting the other. Thumbnails are drawn
  from saved bitmaps so the same code serves the open project and
  ones that were never opened since 2d.
- **Frame 1 as the thumbnail**, as Flipaclip shows it.
- **One-tap create** ("Animation N") rather than Flipaclip's setup
  dialog; size/fps are already stored per project, so a setup dialog
  can come later without a schema change.

## Planned features

- **Imported reference image** per frame: stored once, referenced by
  frames with a small transform record (x, y, scale, rotation,
  opacity). Onion skin shows the composite (image + strokes).
- **Mirroring** (step 3) means three different features. Ask her
  which one she wants before building:
  - **Flip view:** a temporary horizontal mirror for checking
    proportions (Procreate, Sketchbook). View-only, never saved, resets
    with the view. Coupled to the viewport transform and the
    `toCanvasPoint` math, the same lesson as rotation.
  - **Flip drawing:** mirrors the active layer's pixels on this frame,
    undoable as a `'pixels'` entry. Belongs with a transform tool and
    shares step 3's per-frame transform handles. Not a frame action:
    flipping every layer at once is unusual.
  - **Symmetry:** strokes mirror live across an axis (Sketchbook,
    Procreate). Lives in the brush/stamp code, so it pairs better with
    the brush-variety work if that's what she means.
- **Audio:** one project-wide clip, modeled as `audioClips: []` so a
  second clip later isn't a restructure. Non-destructive trim
  (`trimStart`/`trimEnd` in seconds); Web Audio plays just that slice.
- **Export tiers:** (1) video/animation export + native Web Share —
  covers "send it to a friend," the main use; (2) shareable link via a
  Cloudflare Worker + R2, deferred until the core app is proven;
  (3) full project export/import, stretch goal. Export format was
  originally GIF/WebM stitching; ffmpeg.wasm was floated but is
  superseded unless reinstated. Container/codec decided at step 6.
- **Krita reference import** (one-way PC → iPad) reuses the same
  Worker + R2 backend: `.kra` is a ZIP with a merged-preview image;
  import that as a reference layer, not a full layer-stack parser.
- **Storage warning** at ~80% of estimated quota, prompting her to
  export/back up — iOS can evict PWA storage under pressure.
- **Default fps 12 ("on twos")** matches Flipaclip/Rough Animator.
  **Canvas 1920×1080 landscape**, stored per project so changing it is
  config, not a rebuild.
