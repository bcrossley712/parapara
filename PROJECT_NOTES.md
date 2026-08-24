# Project Notes — Parapara!

Read this first if you're picking this project up in a new chat. It's
context for you (the next Claude), not end-user documentation.

**App name: Parapara!** (パラパラ, from parapara manga — the Japanese
term for a flipbook). Chosen by the primary user (the developer's
13-year-old daughter), who wanted something "cute" with a Japanese/
anime feel. The exclamation point is part of the name, not
incidental punctuation — keep it in the app title, icon, manifest
`name`/`short_name`, and repo-facing copy.

## Usage-efficiency expectations for Claude

- **Assume the code in this conversation is current** unless told
  otherwise. Don't re-pull the repo if it's already been fetched this
  session — re-fetch only when told something changed outside the
  conversation, or at the start of a new session.
- **Pull or view only what the task touches.** Grep for the specific
  function/module/section first, then view a targeted range — don't
  read whole files to make a small, well-scoped change.
- **Match verification effort to the change.** Only meaningfully test
  logic changes (e.g. onion-skin compositing, audio trim/sync, the
  undo/redo command stack). Skip deep verification for CSS/copy/layout
  changes.
- **Don't build throwaway sandboxes** to check something reasoning
  from the code can already answer. The wireframing phase (HTML
  mockups) is done — it was for layout/flow decisions only and is not
  part of the real codebase, which is vanilla JS.
- **Keep this file lean.** Current state and the *why*, not a
  session-by-session diary — that belongs in git commits.
- **Deliver only the files that actually changed**, not a full re-zip.
- **Check in before packaging/shipping** — confirm the plan or show
  the diff before finalizing files, even for a single-file change,
  unless clearly told to just go ahead.
- **Batch related changes** into one pass rather than iterating
  file-by-file across separate turns once scope is clear.

## Habits worth keeping

Small, cheap-now/expensive-later scaffolding is worth doing on sight,
even before it's strictly needed — the CSS custom-properties pass
below is the example that prompted writing this down:

- `style.css` had `#3a3226` and `#f2a65a` hardcoded in multiple
  selectors. Trivial to fix while there are only two colors and a
  handful of selectors; each one added afterward (gallery, timeline,
  audio-trim UI, real toolkit look) would have meant either repeating
  the hex value again or a riskier find-and-replace across a much
  bigger file. Named as `--pp-ink`, `--pp-accent`, etc. in `:root`
  instead — this is also most of what a real color/design-token system
  would need later, not thrown-away work.
- The general shape of the tradeoff: if something is a five-minute fix
  today and a real refactor once three more features depend on the
  unfixed version, do it now rather than deferring it to "when it
  actually hurts" — waiting doesn't save the work, it just moves it to
  a more expensive moment and adds risk of missing a spot.
- This is about small structural habits (naming repeated values,
  keeping the frame/project schema additive, the scope-specific file
  layout), not scope creep — it's not license to build speculative
  features or infrastructure ahead of need. The distinguishing
  question: does this make a *near-certain* future change cheaper
  without adding real complexity now? If yes, do it now. If it's
  hedging against a feature that might not happen, that's still scope
  creep and still needs confirming first, per the working agreement.

## Working agreements with this user

- **Flag deviations from drawing/animation-app conventions,
  proactively.** The user isn't an experienced user of apps like this
  himself; his daughter is, and usability against what she's used to
  (Sketchbook, Procreate, Clip Studio, Flipaclip, Rough Animator, etc.)
  matters more than it would for a from-scratch user. Whenever a
  decision — mine or his — departs from how those apps typically
  behave, say so explicitly, ideally *before* building it, so it's a
  deliberate choice rather than an accidental surprise for her
  workflow. Example of this already happening: per-tool brush size
  memory vs. one shared size (see "Built so far") and layer operations
  being undoable (see architectural decisions) were both caught this
  way — worth rechecking new decisions against this as a matter of
  habit, not just when explicitly asked.
  - **Sharpened after a real miss:** rotation is part of the standard
    two-finger gesture (Procreate/Clip Studio twist-to-rotate), and
    was only ever mentioned once in passing, early on — not raised
    again as its own decision point when "two-finger pinch+pan
    gesture" was actually chosen as the interaction model, even though
    it's architecturally coupled to that exact choice (same file, same
    transform math). It ended up needing a real rework
    (`gestures.js`'s anchor math, plus a full `toCanvasPoint` rewrite)
    to retrofit. The lesson: when a standard feature is coupled to
    something already being built — same gesture, same transform,
    same code path — flag it explicitly as part of *that* decision, at
    the moment the coupled thing is being decided, not as a general
    mention earlier or later in the conversation.
- **Explain before touching code, and wait for a go-ahead — for any
  change, not just new-scope ones.** This is stricter than it sounds:
  explaining a diagnosis/plan and then editing in the same turn isn't
  enough, even for a clear bug fix. Lay out what's wrong and what the
  fix will be, then stop and let the user respond, before any
  create_file/str_replace/bash edit to the repo.
- **Confirm before starting new builds/changes** — don't proceed on a
  feature without checking scope/direction first, especially where
  there's real design ambiguity.
- **Confirm before packaging/sending files** — and when sending, only
  include files actually touched by the change, not the whole project.
- **When packaging, include only files changed since the last actual
  delivery** (last time files were handed over for download) — not
  since the last git push. Those are different events.
- User deploys via GitHub Pages, using GitHub Actions for the build/
  deploy pipeline. Comfortable with vanilla JS; familiar with Vue but
  deliberately chose not to use it here (see architectural decisions).
  Okay to skip deep terminal hand-holding, but don't assume framework/
  tooling fluency beyond that.
- **Stack: vanilla JS with native ES modules, no bundler/build step
  for the app code itself.** GitHub Actions is only used to stamp a
  cache-busting version into the service worker at deploy time — not
  to compile or bundle anything.
- **Scope-specific file structure, on purpose.** This is an explicit
  requirement, not just good practice: keep `canvas/`, `timeline/`,
  `storage/`, `export/`, `audio/`, and `ui/` cleanly separated so a
  request to fix one feature (e.g. onion skinning) only requires
  opening one or two files, not tracing logic through the whole app.
  Don't let modules reach into each other's internals — communicate
  through the shared `frame`/`project` data shapes.
- **The frame/project data schema is the one thing to get right early.**
  Everything else (timeline, playback, export, undo/redo) reads from
  it, so changes here ripple further than changes elsewhere. Extend it
  additively (new optional fields) rather than restructuring, wherever
  possible.
- **Primary user is the developer's daughter, drawing on iPad with no
  Apple Pencil (uses a capacitive/mixed-results stylus).** Palm
  rejection and stroke smoothing matter more here than they would for
  Pencil-first input. Build against Pointer Events (not legacy Touch
  Events) throughout so Apple Pencil support later is additive, not a
  rework — see architectural decisions.
- **No native browser dialogs** (`confirm()`, `alert()`, default
  `<input type="date">` chrome where avoidable) — custom-styled
  equivalents only, for visual consistency and to control contrast.
- Preference for validating code before handing it off, and being
  upfront about anything that can't be verified outside a real
  deployed environment (e.g. real iOS storage-eviction behavior,
  actual `MediaRecorder`/mic-permission flow on a real device, Web
  Share API file-sharing behavior across apps).

## What this is

**Parapara!** — a PWA for freehand frame-by-frame animation on iPad —
think Flipaclip/Rough Animator. Built by the user for his daughter.
Drawing, onion skinning, a frame timeline, imported reference images
per frame, audio recording/import with trim, and export/share of the
finished animation. Single known user (plus friends as share
recipients) — not a public product, low-stakes threat model.

## Key architectural decisions (and why)

- **Vanilla JS + native ES modules, no Vue, no bundler.** The hard
  parts of this app (canvas drawing, frame compositing, playback loop)
  are imperative by nature; a reactive framework doesn't help there
  and adds a mental-model split for little benefit at this scope. Also
  matches the user's preference to avoid an npm build/deploy step.
- **Pointer Events, not Touch Events, for all drawing input.** Apple
  Pencil and a finger/stylus arrive through the same API — a Pencil
  touch just carries extra `pressure`/`tilt` data and
  `pointerType: "pen"`. Building on Pointer Events from the start
  means Pencil support later is a few conditionals and some brush-curve
  logic, not an architecture change.
- **No pressure/tilt assumptions baked into the brush engine.**
  Treated as optional inputs so stylus-only drawing works today and
  Pencil data can be read later without touching the core engine.
- **IndexedDB for all project data, fully client-side.** Drawings,
  imported images, and audio blobs all live in IndexedDB. No backend
  is required for the core app to function.
- **Imported images sit as an adjustable layer, not a baked-in
  background.** Each frame is a small stack: an imported-image layer
  (position, scale, rotation, opacity) plus the drawn strokes on top,
  so she can move/scale a reference image and still freely erase/
  redraw her own linework without touching it. Onion skinning renders
  the composite (image + strokes) of neighboring frames.
  - Image blobs are stored once and referenced by frame; each frame
    only stores a small transform record (x, y, scale, rotation), not
    a duplicate copy of the image.
- **One project-wide audio clip for now, modeled as an array.** She
  wants to trim (in/out points) a single voice/music clip against the
  animation, not a multi-track editor. Data model is `audioClips: []`
  even though only one entry is used today, so adding a second clip
  later doesn't require restructuring. Trimming is non-destructive —
  the original file is kept, only `trimStart`/`trimEnd` (seconds) are
  stored, and playback uses the Web Audio API to play just that slice.
- **Canvas default: 1920×1080, landscape, stored per project.** Chosen
  to match how short animations typically get shared/viewed. Stored as
  a project setting rather than hardcoded, so changing the default or
  offering per-project choice later is a config change, not a rebuild.
- **User-facing drawable layers (multiple layers per frame), reversing
  the earlier single-bitmap decision below.** Reopened because the
  primary user is used to how Sketchbook and similar apps work, and
  matching that matters more than the simplicity the single-bitmap
  model bought. Caught in time — storage/undo (step 2) hadn't been
  built yet, so nothing gets thrown away reversing it now rather than
  later.
  - **v1 feature set:** add/delete, reorder, visibility toggle,
    opacity, and per-layer lock (so a reference/lined-paper-style
    layer can't be accidentally drawn on). No blend modes, groups, or
    clipping masks yet.
  - **New frames copy the previous frame's layer structure** (same
    layers — id/name/order/visibility/opacity/lock — but blank
    bitmaps), not a blank single layer. Keeps a consistent stack
    (e.g. "sketch" / "line" / "color") across the whole animation
    without her rebuilding it every frame.
  - **The imported reference image stays separate**, as originally
    documented below — not folded into the new layer list. It already
    has its own transform model (position/scale/rotation) that
    doesn't map cleanly onto a stroke layer.
  - **Undo/redo:** whole-stack raster snapshot (all layers in the
    frame, before/after an edit), not per-layer. Keeps one undo model
    instead of two, matching why raster snapshots were chosen over
    vector replay in the first place. **Confirmed:** layer structure
    changes (add/delete/reorder/visibility/opacity/lock) are undoable
    too, on the same stack as drawing operations — matching how
    Procreate/Photoshop/Krita behave (an accidental layer delete is
    Cmd/Ctrl+Z-able there, and the working assumption of "only strokes
    are undoable" would have been a real, surprising gap for someone
    used to those apps). Revisits the earlier "working assumption, not
    yet confirmed" note — resolved now, not deferred.
- **Undo/redo via a command history, built in from the start.** Every
  stroke, transform, or frame edit is recorded as an undoable action.
  This was deliberately front-loaded because it's the one piece that's
  genuinely painful to retrofit after the fact.
  - **Implemented as raster snapshots, not replayable vector commands.**
    Decided when adding a smudge/shading tool (drag to blend existing
    strokes) — smudge has no clean "recipe" to replay like a draw
    stroke does, only a pixel result. Rather than run two undo code
    paths (vector commands for draw/erase/fill, pixel diffs for
    smudge), each frame's stroke layer is treated as one bitmap, and
    undo/redo stores before/after snapshots (capped history depth,
    snapshot taken on stroke-end, not per pointer-move). Keeps
    `storage/` uniform at the cost of heavier undo entries than pure
    vector replay.
    - **Superseded by the layers decision above** for what counts as
      "the bitmap" — now the whole layer stack per frame, not a single
      stroke layer. The reasoning for snapshot-over-replay still
      holds; only the unit being snapshotted changed.
- **Default fps: 12, "on twos."** Standard beginner-friendly rate for
  hand-drawn/flipbook animation, matches Flipaclip/Rough Animator
  defaults. Stored per-project, adjustable, not hardcoded.
- **Multiple projects via a project list/gallery screen, one project
  open at a time.** Simpler than juggling multi-project state at
  runtime, and maps cleanly onto IndexedDB with each project's data
  namespaced by project ID.
- **Storage-used indicator with a warning threshold.** iOS Safari can
  evict PWA storage under pressure, and images/audio eat quota fast.
  At an estimated-quota threshold (e.g. ~80%), the app should prompt
  her to export/back up rather than silently risking data loss.
- **Export/share is tiered, and the heavier tiers are deferred:**
  1. **Export to video (ffmpeg.wasm) + native Web Share API.** No
     backend required. Covers "send what I made to a friend" via
     Messages/AirDrop/social, which is expected to be the main use
     case.
  2. **Shareable link, via a Cloudflare Worker + R2.** Needed for
     "friend opens a link, no app required." Deferred until the core
     app is proven — see build order below.
  3. **Full project file export/import** (zipped frames + audio) for
     remixing between installs of the app. Stretch goal, not initial
     scope.
- **Cloudflare Worker + R2 also planned for one-way Krita reference
  import**, reusing the same backend as link sharing rather than
  building two separate pieces of infrastructure. `.kra` files are
  ZIP archives with an embedded merged-preview image — the plan is to
  pull that preview in as a reference/starting layer, not to build a
  full Krita layer-stack parser. This is one-way (PC → iPad reference),
  not bidirectional sync.
- **GitHub Actions stamps a version into the service worker on every
  deploy**, same pattern as prior projects — so aggressive PWA caching
  doesn't make a real deploy invisible to an already-installed device.
  No other build step; this is a text substitution, not a compile.

## Current state

Planning/scoping phase, plus early low-fidelity wireframes (HTML
mockups, sandbox-only — not the real codebase) to confirm the main
screen layout: canvas + tool rail, transport controls, and frame
timeline. Confirmed in wireframing:

- Tool rail placement (draw/erase/color/shape, image import, mic
  record, pan) down the left edge.
- Playback transport (skip/play/skip + fps readout) between canvas and
  timeline.
- Horizontally scrolling frame strip below transport, with a
  dashed "add frame" tile and a small indicator on frames that carry
  an imported image.
- Onion-skin toggle shown as a badge on the canvas.
- Share icon in the top bar as a first-class action, not buried in a
  menu.

Initial repo scaffold built: root files (index.html, manifest.json,
sw.js, style.css, README.md, PROJECT_NOTES.md) plus placeholder
entry-point files for each js/ module (canvas, timeline, storage,
export, audio, ui) — no real logic yet, just documented responsibility
and TODOs per module. GitHub Actions deploy workflow included. App
icon set finalized (512/192/32/16 + apple-touch-icon + transparent/
flat source masters, corners flood-filled from an AI-generated draft
image). Schema drafted (above) — not yet built/tested against real
code.

## Built so far

- **PWA update-refresh prompt.** Added ahead of the drawing engine
  since testing happens on the deployed GitHub Pages URL from the
  start, and it's easy to mistake stale cache for a bug otherwise.
  `sw.js` no longer calls `self.skipWaiting()` automatically on
  install — a new version now sits in "waiting" until the page tells
  it to take over. `main.js` registers the service worker and detects
  a waiting update (both "arrived while this tab was open" and
  "already waiting at load"); `ui/ui.js` owns the actual prompt
  (`showUpdatePrompt`) — a small custom-styled toast, not a native
  dialog, per the working agreement. Clicking refresh posts
  `SKIP_WAITING` to the new worker, which then triggers a
  `controllerchange` → automatic page reload. Styling is intentionally
  minimal for now (dark toast, orange button) — not yet matched to any
  real design system since one doesn't exist yet.

- **Drawing engine prototype: draw + erase.** First real pass at step
  1 of the build order — fill and smudge are deliberately deferred
  until draw/erase feel is confirmed on the actual iPad/stylus.
  `canvas/canvas.js` owns Pointer Events input and rendering; it
  doesn't read/write the frame/project schema yet (storage/ is step
  2) — for now it just owns one in-memory canvas at the default
  1920×1080, wired directly into `ui/ui.js`'s tool rail. Draw and
  erase are the same brush engine (erase uses
  `globalCompositeOperation = 'destination-out'`), matching the
  planned single-bitmap `strokeLayer` model. Notable choices, revisit
  once tested on her actual iPad/stylus:
  - **Smoothing:** quadratic-curve-through-midpoints (draw a curve
    between the midpoints of consecutive sampled points, not straight
    segment-to-segment lines). Standard technique for reducing the
    jagged look of raw pointer samples; cheap, no library.
  - **Palm rejection:** "first pointer down wins" — only one pointer
    can be drawing at a time; a second pointer going down while a
    stroke is active is ignored. Catches a palm landing *after* the
    stylus already touched down; does not handle every ordering (e.g.
    palm first). This is the one piece most likely to need real
    tuning once she's actually using it — flagged as unverified
    outside a real device, per the working agreement.
  - **Pressure/tilt:** intentionally not read yet, even though
    available on PointerEvent — matches the architecture decision to
    keep the brush engine unaware of them until real Pencil support
    is added.
  - `ui/ui.js` tool rail is bare-bones on purpose: Draw/Erase toggle,
    a brush-size slider (shared control, per the toolset decision),
    and a dev-only Clear button (no confirm dialog — nothing durable
    to lose yet, no storage/ until step 2). Fill/smudge/image-import/
    mic/pan buttons land with their own build steps.
  - Canvas is letterboxed at a fixed 16:9 (1920×1080 backing store,
    CSS-scaled to fit) — not yet reading a per-project canvas size
    from storage, since storage doesn't exist yet.

- **Drawing engine: full toolset now built — draw, erase, fill,
  smudge.** Second pass, after draw/erase feel was confirmed good.
  - **Brush-tip seam introduced.** Draw/erase no longer call
    `ctx.stroke()` directly — `canvas/brush.js` is new, holding a
    small `stamp(ctx, point, size)` interface (only `roundBrush`
    exists today), and `canvas.js` samples points along the smoothed
    path (straight segment for the first, quadratic-midpoint curve
    after) and stamps the active brush at each one, instead of one
    native stroke call. This is what makes tip variety (chisel,
    textured, etc.) a later "add a brush object" change instead of a
    rendering rewrite — no new tip shapes were added now, this is
    purely the seam. `canvas.js` exposes `setBrush()` for this even
    though nothing calls it yet. Switching from native strokes to
    stamping is a real rendering change (not just a refactor) — worth
    a specific re-check that it still feels as good as the
    already-confirmed native-stroke version, since spacing/density
    tuning (`roundBrush.spacingRatio`) could subtly change the feel.
  - **Fill:** tap-only flood fill (not a drag), iterative/stack-based
    (not recursive, to avoid stack depth issues on a 1920×1080
    region), with a color-distance tolerance (`FILL_TOLERANCE = 32`)
    so anti-aliased stroke edges don't leave an unfilled fringe.
    Always fills with the current draw color — no separate
    "erase-fill" mode. Reads/writes the full canvas pixel buffer per
    tap (~8MB at 1920×1080); unverified how this performs on the
    actual iPad, flagging per the working agreement on unverifiable-
    outside-a-real-device items.
  - **Smudge:** drag-based, samples a small patch of existing pixels
    behind the stroke and blends it forward at each step
    (`SMUDGE_STRENGTH = 0.5`, fixed, not yet a control) — this is what
    "drags" color rather than stamping flat color like draw/erase.
    Uses a small reused offscreen scratch canvas (sized to
    `MAX_BRUSH_SIZE`) rather than allocating one per stroke or per
    step. Calls `getImageData` every drag step, so the main canvas
    context is created with `willReadFrequently: true`.
  - `MAX_BRUSH_SIZE` now lives in `canvas.js` and is imported by
    `ui.js` for the size slider's `max`, instead of the same number
    being hardcoded in both places.
  - `ui/ui.js` tool rail now has all four: Draw/Erase/Fill/Smudge.
- **Brush size: per-tool memory, not one shared value.** Caught during
  a standards check (see "Habits worth keeping" below) — sharing one
  size across draw/erase/smudge doesn't match how Procreate/
  Sketchbook/etc. behave (each tool remembers its own last-used size
  independently). `canvas.js` now keeps `brushSizes = { draw, erase,
  smudge }`; `setBrushSize()` writes to the active tool's slot,
  `getBrushSize()` reads it back so `ui.js` can sync the slider's
  displayed value whenever the active tool changes. Fill has no size
  concept (a flood fill has no radius) — not tracked, and the slider
  disables itself while Fill is active rather than showing a
  meaningless number.
- **Smudge interpolates along the drag path, tuned for a gentle
  single-pass blend.** Smudge samples pixels near the previous point
  and blends them at the new one (`smudgeStep`), interpolated along
  the segment (`smudgeAlongLine`) the same way draw/erase fill gaps
  between far-apart pointer samples — without that, fast drags left
  isolated blobs instead of a continuous smear. Blend strength
  (`SMUDGE_STRENGTH = 0.18`) and step spacing (`SMUDGE_SPACING_RATIO =
  0.5`, separate from draw/erase's `roundBrush.spacingRatio`) are
  tuned together so one pass lands around ~30% effective blend rather
  than compounding toward solid color — consecutive overlapping steps
  multiply, not average, so this took two rounds of retuning to get
  right. Feel judgment, not device-tested — a couple of deliberate
  passes should be needed to really homogenize an area, matching how
  smudge tools elsewhere behave.
- **Main canvas context intentionally does not set
  `willReadFrequently: true`,** even though smudge/fill call
  `getImageData`. That flag tends to push the whole canvas onto a
  slower software (CPU) rendering path — which would hurt draw/erase
  (used constantly) to help smudge/fill (used rarely), the wrong
  trade. If smudge/fill specifically turn out to need it, that's a
  narrower fix (e.g. bounding fill's read/write to the affected
  region) rather than a whole-canvas one.
- **Color picker: custom HSV square + hue slider + hex input.**
  Flagged first — a drawing app with no way to change color at all is
  itself a deviation from every app in this category, not just a
  missing nice-to-have; it was simply unreached in build order rather
  than deliberately deferred. Chose the full custom-picker route over
  a quick preset-swatch row, matching standard-app-grade expectations
  rather than a placeholder. New file `js/ui/color-picker.js` (same
  reasoning as `canvas/brush.js` splitting out of `canvas.js` — a
  gradient canvas with pointer dragging and hex parsing is a real
  subsystem, not a few lines in `ui.js`). No native
  `<input type="color">` — same reasoning as the existing ban on
  native `confirm()`/`alert()`/date-input chrome, extended here.
  - SV square uses the standard two-gradient-overlay technique (fill
    hue → white-to-transparent horizontal overlay → transparent-to-
    black vertical overlay) rendered on its own small canvas, dragged
    via Pointer Events with capture, consistent with how the drawing
    canvas itself handles pointer input.
  - Hue slider is a native `<input type="range">` (0–360, styled with
    a rainbow gradient track) — range inputs aren't part of the
    native-chrome ban, unlike color/date inputs, so no need to build a
    custom drag control for it.
  - Hex input is a native `<input type="text">`, validated on
    `change` (invalid entries snap back to the last valid color rather
    than being accepted).
  - Opens as a floating panel anchored to a new swatch button in the
    rail (shows current color), positioned via `getBoundingClientRect`
    on open rather than a fixed offset. Closes on tapping anywhere
    outside it, including the canvas.
  - `canvas.js` now exports `DEFAULT_COLOR` (`'#2b2b2b'`) as the single
    source of truth for the starting color, imported by both the
    drawing engine and the picker's initial state — same pattern as
    `MAX_BRUSH_SIZE`.
  - Not included, on purpose, to avoid scope creep beyond what was
    asked: recent/preset swatches, eyedropper, opacity control. Worth
    revisiting later if she wants them, not assumed now.
- **Two-finger pan/zoom gesture.** Flagged proactively, not requested
  first — pan/zoom is close to universal in this app category
  (Procreate/Sketchbook/etc. and animation-specific apps alike), and
  wasn't in the original toolset planning at all (pan was listed in
  early wireframing, zoom wasn't mentioned anywhere). Placed before
  storage/step 2 on purpose, even though that delays real persistence
  a bit further — the complexity lives entirely in `canvas.js`'s
  pointer-coordinate mapping, which storage/layers/image-transform
  would otherwise build on top of unaware of pan/zoom, meaning a later
  retrofit would likely touch three subsystems instead of one.
  - New file `js/canvas/gestures.js` — pure transform math only (no
    DOM/pointer handling), so the fiddly part (keeping a pinch anchor
    point visually fixed while scale changes) can be reasoned about
    independent of dispatch logic.
  - Pan/zoom is a CSS `transform: translate() scale()` on the canvas
    element — the backing-store bitmap stays 1920×1080 always.
    `toCanvasPoint()` already read the canvas's live bounding rect on
    every call, so it needed *zero* changes to keep working correctly
    at any zoom level — a fortunate consequence of how it was already
    written, not something added for this.
  - **The real problem was disambiguating a pinch from a draw
    stroke,** not the transform math. Her stylus very likely reports
    `pointerType: 'touch'`, indistinguishable from an actual finger —
    the same ambiguity already flagged as unverified for palm
    rejection, surfacing again here. Resolved by: a touch always
    starts drawing immediately (no added latency for the common
    single-finger case), but stays a "pending" gesture candidate for
    ~150ms (`GESTURE_WINDOW_MS`) as long as it's moved less than 8px
    (`GESTURE_MOVEMENT_THRESHOLD_PX`). If a second touch joins within
    that window, it's retroactively treated as a gesture — the first
    touch's just-drawn mark is reverted from a saved pixel patch
    (captured before drawing, same idea as smudge's sample/restore,
    just used to undo instead of blend). If the window expires with no
    second touch, nothing happens — it was just a normal stroke that
    was never delayed. `pointerType === 'pen'` (and mouse, for desktop
    testing) bypasses this entirely and draws immediately, no
    candidacy — this is also what keeps a real Apple Pencil seamless
    later: it reports `'pen'` reliably, so it was always the simple
    code path this was built around, not a special case to add.
  - Fill is exempt from the revert mechanism — it commits immediately
    regardless of pointer type, since reverting an arbitrary
    flood-filled region isn't a cheap small-patch operation.
  - Ending the gesture via either finger lifting ends it completely —
    drawing doesn't resume with whichever finger is still down, to
    avoid a stray mark right as a pinch/pan ends.
  - Zoom clamped to 1x (can't zoom out past fit-to-screen) – 8x. A
    quick two-finger tap (short duration, minimal movement) resets to
    fit — the common reset convention, and also the safety net for
    "panned it somewhere I can't find my way back from."
  - A window resize (e.g. iPad rotation) resets pan/zoom rather than
    trying to preserve the transform math across a layout change —
    simplest safe behavior, not a sophisticated one.
  - Untested outside a real device, same caveat as the smudge tuning
    above: the 150ms/8px thresholds are reasoned defaults, not
    measured against her actual stylus's touch-reporting behavior.
- **Bug fix: Clear button (and rail generally) pushed off-screen on
  the actual iPad (9th gen).** iOS extends a standalone PWA under its
  status bar — the manifest already had `viewport-fit=cover` and
  `display: standalone` set correctly for that, but nothing in the CSS
  accounted for `env(safe-area-inset-top)` anywhere except the update
  toast's bottom inset. The whole app shell started at y=0 under the
  status bar, so everything below was pushed down by that unaccounted
  height — the rail's last item (Clear, pinned to the bottom via
  `margin-top: auto`) paid for it by falling off-screen. Fixed with
  `padding-top`/`padding-bottom: env(safe-area-inset-*, 0px)` on
  `.pp-app-shell`. That padding only works because `box-sizing:
  border-box` was also added globally — without it, padding would've
  added to `.pp-app-shell`'s fixed `height: 100vh` and made the box
  taller than the screen instead of shrinking its usable content area,
  actively worse than doing nothing. Bottom inset mainly matters for
  devices with a home-indicator gesture bar rather than the 9th-gen's
  physical home button — kept generic rather than hardcoded to this
  specific iPad.
- **Bug fix: zoom anchored to the canvas center instead of the pinch
  point.** The `computeGestureTransform` math in `gestures.js`
  requires `transform-origin` pinned at the canvas's own top-left
  corner `(0, 0)` — the whole anchor-point formula is built on that
  assumption — but nothing ever actually set it. CSS defaults
  `transform-origin` to `50% 50%` (center), so `scale()` had been
  scaling around the canvas's center the entire time regardless of
  where the gesture was, which is exactly "doesn't zoom where you're
  pinching." Fixed with `canvas.style.transformOrigin = '0 0'` in
  `canvas.js`, set right where the canvas element is created — kept
  in JS next to the code that depends on it (rather than in the CSS
  file) since it's a hard requirement of the gesture math, not a
  stylistic choice, and shouldn't be editable without that dependency
  being obvious.
- **Canvas rotation added to the two-finger gesture.** Raised as a
  standard-deviation flag that should have been caught earlier — see
  "Working agreements" above for the sharpened habit this prompted.
  Free rotation (no snapping), matching Procreate/Clip Studio; the
  existing two-finger-tap-to-reset now zeroes rotation too, not just
  pan/zoom.
  - This wasn't a small addition — it broke a load-bearing assumption
    in already-shipped code. `toCanvasPoint` (every draw/erase/fill/
    smudge action routes through it) previously read
    `canvas.getBoundingClientRect()` to map a touch to a canvas pixel.
    That's only correct for an unrotated element — `getBoundingClientRect()`
    on a rotated element returns the axis-aligned box that merely
    *contains* the rotated shape, not its true tilted frame. Left
    alone, every stroke placed while rotated would have landed in the
    wrong spot.
  - Rewritten to compute the mapping analytically instead: `canvas.js`
    now tracks `viewportRotation` alongside scale/x/y, and
    `gestures.js` exports `screenToNaturalPoint`, the inverse of the
    on-screen transform (`translate(x,y) rotate(r) scale(s)` around
    the canvas's own top-left, per the transform-origin fix above).
    `toCanvasPoint` uses this instead of reading the DOM. Confirmed
    the general (rotation-aware) formula reduces exactly to the
    already-validated rotation-free version when rotation is 0 — a
    generalization, not a behavior change for the existing case.
  - **Rotation tracking is incremental, not baseline-diffed like
    scale/pan are.** Scale and translate are safely recomputed from
    the gesture's start values every move event (avoids drift). A raw
    `currentAngle - startAngle` can't use the same approach: `atan2`
    jumps by ~2π when the two fingers' angle crosses ±180°, which
    would make a deliberate twist past 180° visibly snap instead of
    rotating smoothly. Fixed by accumulating `shortestAngleDelta`
    between consecutive frames (safe, since real finger movement
    between two pointermove events is always well under 180°) rather
    than diffing against the gesture's start angle. This accumulator
    lives in `canvas.js` (stateful, gesture-dispatch concern);
    `gestures.js`'s `computeGestureTransform` takes the resolved
    absolute rotation as an input rather than computing it internally,
    keeping that function stateless.
  - Untested outside a real device, same caveat as the rest of the
    gesture work: the math is verified by hand (including the
    reduces-to-the-old-formula check above), not by an actual twist
    gesture on her iPad yet.

Agreed build order (core app before backend, since the backend is the
most optional piece):

1. Drawing engine prototype (Pointer Events, stroke smoothing, no
   Pencil-specific logic yet) — get input feel right before anything
   else, since a bad drawing feel undermines everything built on top
   of it.
2. Frame/project data model + IndexedDB storage layer, including the
   layers UI (add/delete/reorder/visibility/opacity/lock) — schema is
   locked in (see architectural decisions + draft schema above), but
   the UI itself is intentionally deferred to this step rather than
   built into the current draw/erase-only prototype.
3. Image import + adjustable image-layer transform per frame.
4. Playback loop + onion skinning.
5. Audio import/record + single-clip trim.
6. Export (ffmpeg.wasm) + native share sheet.
7. Cloudflare Worker + R2 backend (Krita reference import, shareable
   links).

Decided since wireframing:
- **Toolset for the drawing engine: draw, erase, fill, smudge/
  shading (blend tool).** Brush size is a shared control across
  draw/erase/smudge. (See undo/redo note above — smudge is why undo
  is raster-snapshot-based rather than command-replay-based.)
- **Default fps: 12** (see architectural decisions above).
- **Multiple drawable layers per frame** (see architectural decisions
  above) — schema locked in, UI deferred to step 2.

Still open:
- Default export format specifics (container/codec) — not needed
  until step 6.

## File layout (confirmed)

    index.html
    manifest.json
    sw.js             service worker (version stamped by GH Actions)
    style.css
    README.md
    PROJECT_NOTES.md
    js/
      canvas/         pointer input, brush engine, rendering, pan/zoom
                        (canvas.js + brush.js + gestures.js, split as
                        each became a real seam/subsystem of its own —
                        see architectural decisions)
      timeline/        frame array, thumbnails, reorder logic, playback loop
      storage/          IndexedDB wrapper, schema, undo/redo (raster snapshots)
      export/           GIF/WebM stitching, Web Share
      audio/            record/import, trim, Web Audio playback
      ui/               toolbar, buttons, DOM glue
                        (ui.js + color-picker.js, same splitting
                        reasoning as canvas/ above)
      main.js           app entry, screen routing (gallery <-> editor)
    icons/            app icon set

NOTE: this corrects an earlier drift in this file, which had listed
`src/` and ffmpeg.wasm for export. The actually-agreed structure uses
`js/` at root (confirmed) and GIF/WebM stitching for export (as
originally discussed) — the ffmpeg.wasm mention under "Export/share is
tiered" above predates that and should be treated as superseded unless
you want ffmpeg.wasm reinstated specifically.

## Draft frame/project schema (working draft, extend additively)

    project = {
      id, name, createdAt, updatedAt,
      canvas: { width: 1920, height: 1080 },
      fps: 12,
      frames: [frameId, ...],
      audioClips: [
        { id, blobRef, trimStart, trimEnd }
      ]
    }

    frame = {
      id,
      layers: [
        { id, name, bitmapRef, visible: true, opacity: 1, locked: false },
        ...   // array order = stacking order, index 0 = bottom
      ],
      activeLayerId,   // which layer new strokes paint onto
      undoStack: [ snapshotRef, ... ],  // whole layer-stack snapshot, capped depth, per-frame
      image: {
        blobRef, x, y, scale, rotation, opacity
      } | null   // reference image — separate from layers, see architectural decisions
    }

Nothing here has been built or tested yet — this file will be updated
as decisions get made and code starts shipping.
