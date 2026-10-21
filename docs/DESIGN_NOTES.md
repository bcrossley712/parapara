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
[Testing and CI](#testing-and-ci) · [Gallery](#gallery) ·
[Reference image](#reference-image) · [Planned features](#planned-features)

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
- **Device-only visual bugs: get real screenshots, and the pattern,
  before fixing (2e).** Camera photos of the top-bar blur were
  unreadable — the exposure shifted between shots, so even identical
  colors looked different. Screenshots (top button + Home) showed it
  at once. The first fix was then built on a guess about the trigger
  and failed; asking *when* it starts ("never at launch, after any
  screen switch, either direction") is what pointed to the real cause.
  Ask both questions before proposing a fix that only the iPad can
  test — each wrong attempt costs a push and a test.
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
  over the top edge — fine only while everything iPadOS reads there is
  dark (next bullet).
- **The status bar follows the page's colors, not just
  `black-translucent`.** After 2d, the status text turned black over a
  light frosted band — first when the gallery appeared, then staying
  that way in the editor. The cause was the cream `theme-color`
  (`index.html`), the manifest's `theme_color`/`background_color`, and
  the cream `html, body` background (never visible, but iPadOS reads
  it). All are now the top bar's dark brown. That the gallery's light
  scrolling area is what set it off is a guess — nothing scrolled
  before 2d. Only the iPad can check this: desktop Chromium doesn't
  draw the status bar. iOS may keep manifest colors from when the app
  was added to the home screen, but re-adding it can delete her
  drawings, so never suggest that before she's backed up (step 6
  export).
- **iPadOS 26's frosted top edge (2e).** Even with the status text
  fixed (above), the top bar's contents went blurry after switching
  screens (either direction) and stayed blurry until relaunch — never
  at launch, whichever screen opened first. That's iPadOS 26's
  "scroll edge effect", which home-screen web apps get by default
  (Messages shows the same frost). No meta tag or CSS property turns it
  off. Per WebKit (`LocalFrameView::fixedContainerEdges`, as documented
  by other projects that hit it), it's skipped when a hit test just
  below the middle of the top edge lands in a `position: fixed` or
  `sticky` box at least 90% of the viewport wide, no more than 5%
  taller than it, with a plain `background-color` and no
  `backdrop-filter` on the way up — iOS then just extends that color.
  - **The fix (confirmed on the iPad; a first guess about an empty
    moment between screens didn't work):** every screen had
    its own fixed shell, and a switch deletes it. iPadOS appears to
    latch onto the first qualifying fixed box and not find a
    replacement. Now `#app` (created once in `index.html`) is the only
    fixed box and the shells inside are absolute, so the box iPadOS
    found at launch lives as long as the app.
  - **If it ever comes back:** first check nothing new replaced or
    covered `#app` at the top edge. Then try making iPadOS re-check
    after a switch (e.g. nudge the page a pixel and back). The custom
    dialog's backdrop is fixed, full-screen and semi-transparent —
    while a dialog is open the top edge doesn't qualify; suspect it if
    the blur starts after a dialog.
  - Only the iPad shows the effect; the e2e test guards the conditions
    above. Sources:
    [discpress #24](https://github.com/PowerBeef/discpress/pull/24),
    [folio #994](https://github.com/mbryantms/folio/pull/994).
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
  app-level actions behind one gear/wrench. Its Developer section
  holds dev-only tools (Fresh reload, the memory stress test).

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

## Reference image

- **Reference image vs. an image layer.** Sketchbook and Procreate turn
  an imported photo into a normal layer: you place it, it's baked, and
  you draw or erase on it. Flipaclip does much the same. She wants
  something to *trace over*, so it's a separate, non-destructive
  reference under the layers, closer to Rough Animator. This is a
  deliberate departure from most of her apps. It also doesn't use one
  of the 8 layer slots, and its transform stays editable. She has to
  try it before we know it feels right. If it doesn't, the fix is
  additive: a "Make into layer" action that draws the transformed image
  into a new layer. That way nothing gets rewritten. Keep the reference
  logic in one module so the code that reads it (`readVisible`,
  thumbnail, onion skin in step 4, export in step 6) calls one function
  each. That keeps any later change local.
- **Photo picker exception.** iPadOS only exposes Photos through
  `<input type="file">`. The "no native pickers" rule is about browser
  chrome that looks out of place, like `confirm()` or the color input.
  The system photo sheet is what every iPad app uses, so it's allowed.
- **Image controls live in a top-bar Image button with its own menu.**
  The first build put them in the frame menu, reasoning that the image
  belongs to a frame. A pinned "Reference" row in the layers panel had
  already been dropped, since that panel was filling up. On the iPad it
  felt hidden: nothing on screen said images existed. So 3a moved them
  to an Image button beside Layers. The options considered:
  - **Top bar (chosen):** placing a photo is occasional, like opening
    Layers, and doesn't change what her pen does. The top bar has room
    (Share joins it in step 6).
  - **Rail:** it's short on height in landscape, with symmetry and
    the mic (step 5) still to come.
  - **A single "image+" button with no menu:** it leaves Hide images and
    3b's actions without a home.

  Procreate (top-bar Actions → insert photo) and Sketchbook (toolbar)
  both keep image import visible. The frame menu kept no copy: images
  have one home, and the shortcut bar (later) is where second routes
  belong. The button shows state (dot = this frame has an image,
  slashed = hidden), so she can tell why a photo isn't showing.
  "Hide images" is worded so it's clear it covers every frame.
- **Adjust mode gestures.** Two fingers normally pan, zoom and rotate the
  view. In adjust mode they always transform the image instead, as
  Procreate's transform does. Two-finger double-tap still resets the
  view, so she can always get her bearings back. The alternative was
  two fingers *on* the image transform it and *off* it move the view.
  It was rejected for now, because a photo often fills the whole canvas,
  so the split would rarely help. Revisit if she misses panning while
  adjusting.
- **Import size, format and opacity.** Her iPad always runs near full,
  so imported images are compressed hard, like the photo-saving apps
  that shrink pictures:
  - **1× cap:** the long side is at most the canvas's (1920 px). 2× was
    the first plan. On iPad photos (4:3) it barely shrank a 12 MP photo
    (to 11 MP, about 44 MB decoded), and storage was the bigger worry
    anyway. At 1× a photo is about 3 MP and about 11 MB decoded. Cost:
    enlarging past the canvas size softens, which matters little for a
    traced reference at 50%.
  - **JPEG 0.7, PNG only if really transparent:** measured on one of
    her screenshots (the worst case for JPEG: flat color, hard edges),
    resized to 1920×1440:
    - PNG: 342 KB
    - JPEG 0.8: 113 KB
    - JPEG 0.7: 95 KB
    - JPEG 0.6: 83 KB

    A fill on the background differed from the PNG's by 0.7%, 0.8% and
    1.0% of pixels respectively, all along line edges. At 3× zoom, 0.6
    started to look blotchy at edges and 0.7 didn't. Below 0.7 the
    savings are tiny and the edges she traces get worse. Quality only
    changes storage, never memory (decoded size depends on pixel
    dimensions). Most PNGs (screenshots) have an alpha channel and use
    none of it, so transparency is checked on the pixels, not the file
    type.
  - **50% opacity on import,** because the point is tracing. Procreate
    starts at 100% because its photos are artwork.

  Her drawings (layer bitmaps) stay lossless PNG; JPEG would blur lines
  a little more on every save.
- **Per frame, with "use on all frames".** The schema already stores
  the image per frame (rotoscoping needs each frame to have its own).
  She also wants a background that spans the animation. "Use on all
  frames" references the same blob from every frame, so it's stored
  once. Each frame keeps its own transform, so nudging one frame later
  doesn't move the rest; she can apply to all again if she wants them
  matched. A new frame inherits the image only when every frame already
  shares it, meaning it's acting as a background. A rotoscope sequence
  doesn't carry a stale image onto new frames. No flag in the schema is
  needed to tell these apart.
- **3b decisions.**
  - **Confirm before replacing a different photo.** Use on all frames
    is undoable, so by the layer-delete rule it wouldn't ask. But undo
    history is dropped when she closes the project, and a rotoscope
    sequence is a lot of placing to lose. So it asks only when another
    frame has a *different* photo. Filling blank frames, or re-placing
    the same photo, doesn't ask.
  - **One frame counts as "every frame shares it."** Importing a
    background on frame 1 and then adding frames is likely her most
    common start, so frame 2 gets the photo. The cost is that a
    rotoscope's frame 2 starts with frame 1's photo until she taps
    Replace. Once frames have different photos, new frames start
    blank. The rule reads the frames, not a remembered "she chose all
    frames" flag, so there's no schema field to keep in sync.
  - **Flip ↔ and Flip ↕, both.** Procreate's and Sketchbook's
    transforms offer both, and matching her apps wins. Stored as
    booleans, not the negative scale first planned, because a negative
    scale fails `sanitizePlacement`'s `scale > 0` check and would
    silently reset her placement. It flips as seen on screen, even
    when the image is rotated: mirroring across a canvas axis equals
    mirroring across the image's own axis with the rotation negated.
  - **No frame-strip marker.** The wireframe had one, but her apps
    don't badge frames. In Flipaclip and Procreate's Animation Assist
    the photo is part of the frame, so the thumbnail shows it. Step 4's
    thumbnails include the reference image, which does the same job;
    until then the Image button's dot covers the frame she's on.
  - **Storage warning deferred to step 6.** 3b adds almost no storage
    (shared blobs). A warning should come with a remedy, and "export /
    back up" arrives at step 6. Save failures already raise a notice.
    It's also unclear off-device how well `storage.estimate()` tracks
    a nearly full iPad.
- **Reference vs. image-as-layer, revisited (3b).** If photos are mostly
  backgrounds, should they be layer pixels, as in her apps? Not for
  now:
  - The reference already acts as a background. It's in the
    thumbnail and the export (unless hidden) and can go to 100%.
  - Layers store pixels per frame, so a baked background across 24
    frames would be 24 lossless copies. The reference keeps one
    shared JPEG, which matters on her nearly full iPad.
  - Switching would rewrite 3a. "Make into layer" covers drawing on
    the photo additively.

  The real fork is export: a tracing photo usually shouldn't be in the
  video, but a background should (step 6). Ask her after 3b whether she
  wants to draw on the photo and whether 50% bothers her for
  backgrounds.

## Planned features

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

### After the main build (requested, deferred)

Moved out of step 3 so she reaches playback (step 4) sooner. None of
these forces a redo of what's built; each is additive.

- **Mirroring** means three different features. She chose flip
  drawing and symmetry. Flip view is not planned:
  - **Flip view:** a temporary horizontal mirror for checking
    proportions (Procreate, Sketchbook). View-only, never saved, resets
    with the view. If it's ever added, it's coupled to the viewport
    transform and the `toCanvasPoint` math, the same lesson as
    rotation.
  - **Flip drawing:** mirrors the active layer's pixels on this frame.
  - **Symmetry:** strokes mirror live across an axis.
- **Layer menu.** Flip would have pushed the layers panel footer to
  six actions, and merge down later to seven. Her apps put layer
  actions in a per-layer menu (Sketchbook, Flipaclip, and Procreate's
  tap-the-active-layer popover). The frame strip already works this way
  (tap the current tile), so the layer row does too. The footer keeps
  only the opacity slider, since a slider doesn't belong in a menu.
  Build it with whichever comes first, flip drawing or merge down.
- **Flip drawing lives in the layers panel.** It acts on the active
  layer, so it sits with the other layer actions (Clear, Copy). A
  top-bar button was suggested and rejected: it would separate a layer
  function from its siblings. Note that Procreate's "flip canvas"
  mirrors every layer. Ours is the active layer only, on this frame. If
  she ever expects the whole frame to flip, revisit.
- **Symmetry axis is fixed.** Sketchbook and Procreate let you drag the
  axis. She doesn't want anything on the canvas that competes with
  drawing; Sketchbook's on-canvas radial menu put her off. So the axis
  sits at canvas center, the guide line is display-only, and the toggle
  is on the rail. A movable axis would need a touch near the guide to
  become a drag instead of a stroke. That's a new input rule, so don't
  add it unless she asks.
- **Symmetry and brush variety go together.** Both change how stamps
  are drawn (`stamp()`, dirty rects — the code undo depends on), so
  doing them in one pass touches that code once. A directional tip
  (chisel) needs its mirrored stamps to mirror the tip's angle too, not
  just the position.
- **Adjustable shortcut bar (deferred to after step 6).** The idea is to
  let her put the actions she uses most in a bar, like Clip Studio's
  command bar. It takes:
  1. One registry of actions (id, label, icon, run, enabled, active)
     that every existing button calls. Today buttons are wired one at a
     time in `ui.js`, the layers panel and the frame menu, so this
     refactor is most of the work.
  2. Shortcut slots that are a *second* way to reach an action, not a
     new home for it.
  3. A custom edit sheet to add, remove and reorder; reordering may
     share code with step 4's frame-strip reordering.
  4. App-wide saving that drops unknown ids.
  5. Core controls stay fixed (Gallery, tools, color, Layers).

  It waits until after step 6 for two reasons: she can't know what she
  reaches for until the app is complete, and the action list keeps
  growing until then. Doing the refactor later is mechanical, not risky.
