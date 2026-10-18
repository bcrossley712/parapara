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
- **Remembered state is part of any persistence decision.** When
  scoping anything that saves, ask what else her other apps keep
  across launches (tool, color, sizes, last-open project, view) and
  raise it then — tool settings were missed in 2a and caught on the
  device instead.
- **Hold files until a push is due.** Don't hand over files after each
  change; keep working in the cloned repo and send files only when
  it's time to push to GitHub — either ask if he's ready to push,
  recommend pushing, or wait for him to ask. This includes
  `PROJECT_NOTES.md` edits: they ride along with the next push rather
  than being sent on their own.
- **When sending, state each file's repo path** (e.g.
  `js/storage/autosave.js`), not just its name — several files share
  names across folders, and new files have no obvious home.
- **When packaging, include only files changed since the last actual
  delivery** (last time files were handed over for download) — not
  since the last git push. Those are different events.
- User deploys via GitHub Pages, using GitHub Actions for the build/
  deploy pipeline. Comfortable with vanilla JS; familiar with Vue but
  deliberately chose not to use it here (see architectural decisions).
  Okay to skip deep terminal hand-holding, but don't assume framework/
  tooling fluency beyond that.
- **Stack: vanilla JS with native ES modules, no bundler/build step
  for the app code itself.** GitHub Actions runs the tests, copies the
  app files into the published site, and stamps a cache-busting
  version into the service worker — it never compiles or bundles
  anything. npm exists only for test tooling (see "Testing"); the app
  has no runtime dependencies and nothing from npm ships to the iPad.
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
  - **Layer bitmaps are saved as PNG blobs** (`canvas.toBlob`), not
    raw pixel data — roughly 10–50× smaller for line art.
  - **Autosave runs shortly after a stroke ends**, never mid-stroke,
    so encoding a PNG can't cause drawing lag.
  - **The app requests persistent storage**
    (`navigator.storage.persist()`) so iOS is less likely to evict her
    work under storage pressure. Not guaranteed to be granted; the
    storage warning (below) is still needed.
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
  - **Undo/redo:** one raster-snapshot undo model for everything
    (originally "whole-stack snapshot per edit"; narrowed to
    "only what changed" for memory — see the undo/redo decision
    below). **Confirmed:** layer structure
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
  - **Revised before building (step 2 planning), for memory and
    convention:**
    - **One project-wide history, not one stack per frame.** Undo
      reverses the most recent action wherever it happened and jumps
      to that frame — how animation apps generally behave. Per-frame
      stacks would make undo on frame 5 skip what she just did on
      frame 6. Entries are tagged with their `frameId`.
    - **In memory only, never saved.** Almost no drawing app keeps
      undo across a relaunch, and persisting snapshots would eat
      storage. History is lost when the app closes or the project
      changes — expected behavior.
    - **Entries store only what changed:** usually one layer, cropped
      to the stroke's bounding box. Only structural ops (add/delete/
      reorder layers) capture more. Each 1920×1080 layer is ~8 MB
      raw, and iPad Safari caps canvas/tab memory hard, so whole-stack
      before/after snapshots would crash the 9th-gen iPad long before
      30 steps.
    - **Only the "before" patch is stored.** On undo, the current
      pixels in that region are captured as the redo patch, then the
      before patch is restored. Halves memory versus storing both.
    - **Caps: 30 steps *and* a ~150 MB memory budget**, oldest dropped
      first when either is exceeded. The budget is what actually
      protects the iPad — a typical stroke entry is ~0.5–1 MB, but a
      full-canvas fill or Clear is ~8 MB. 30 is conservative next to
      Procreate's default; raise it if she runs out.
    - **Layer count is capped per frame** (exact number TBD in 2c) for
      the same memory reason. Procreate also caps layers by canvas
      size and device memory, so a cap isn't a convention deviation.
- **Touch gestures match Sketchbook defaults**, the app she's using
  most right now (per [Sketchbook's gesture guide](https://help.sketchbook.com/docs/gestures)).
  Sketchbook differs from Procreate, which uses two-finger tap = undo
  and three-finger tap = redo:
  - Three-finger tap = undo.
  - Three-finger swipe left / right = undo / redo.
  - Two-finger double-tap = reset/fit view. **Replaces today's
    two-finger single tap** (change lands with undo in step 2b).
  - Two-finger single tap does nothing, so Procreate habits don't
    misfire.
  - Two-finger drag/pinch/twist = pan/zoom/rotate (already built).
  - Visible undo/redo buttons as well.
  - Later, once a brush library exists: three-finger swipe up =
    color editor, down = brush library.
  - **To check with her:** Sketchbook lets users remap these, so
    confirm what *she* actually does. **To check on device:** iPadOS
    has a system three-finger-swipe undo for text editing; it
    shouldn't fire on the canvas, but that's unverified.
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
- **Tests gate every deploy, and only app files are published.** See
  "Testing" below.

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

**Status: build step 1 (drawing engine) is functionally done and
deployed.** It's running on the real target device (9th-gen iPad,
installed PWA). `canvas/` and `ui/` have real logic (draw/erase/fill/
smudge, color picker, two-finger pan/zoom/rotate, update prompt), and
`storage/` has the 2a saving layer; `timeline/`, `export/`, and
`audio/` are still placeholder entry points. Deploy pipeline and app
icon set are done. Step 2 is in progress (see "Next" below).
Details of everything built are under "Built so far."

**iPad test results so far:** fill speed and palm rejection both work
fine in real use. Pan/zoom/rotate and tap-to-reset work. The viewport
fix is confirmed on the device. Smudge feel is still off (see below).

**Next: step 2, split into four pieces**, each tested on the iPad
before the next starts:

- **2a. Saving.** Schema + IndexedDB wrapper; one project, one frame,
  autosaves and survives relaunch. **Built** (see "Storage" under
  Built so far). Drawing persistence **confirmed on the iPad**; the
  follow-up that remembers tool settings is built and tested, awaiting
  iPad confirmation.
- **2b. Undo/redo** per the revised design (see architectural
  decisions), plus the Sketchbook gesture mapping and buttons. Clear
  becomes undoable here.
- **2c. Layers panel** — add/delete/reorder/visibility/opacity/lock,
  with a per-frame layer cap.
- **2d. Project gallery** — list, create, open, delete (custom
  confirm dialog).
- **Pulled forward from step 4: a bare-bones frame strip** (add frame,
  tap to switch) lands during step 2, so multi-frame saving, the
  "new frames copy the layer structure" rule, and cross-frame undo can
  be tested now instead of two steps later. Playback and onion skin
  stay in step 4.

**Known open items:**
- **Smudge feel** — works, but not what she expects. She showed that
  some brush styles in other apps inherently blend/soften the edges of
  the stroke, which suggests the smudge feel is tied to having a
  broader brush set. Deliberately deferred until more brushes and
  erasers exist (the `brush.js` tip seam is there for it) — don't
  retune smudge in isolation before then.
- **Brush variety** — she noticed the range of brush sizes, tips
  (e.g. chisel), and edge-blending styles in other apps. Not
  scheduled yet; revisit after step 2 so it doesn't pull focus from
  persistence.

## Built so far

Grouped by subsystem: how it works now, and why. The history of how
each piece got here lives in git.

### Drawing engine (`canvas/canvas.js`, `canvas/brush.js`)

- **One in-memory 1920×1080 bitmap**, letterboxed at 16:9 and
  CSS-scaled to fit. It doesn't read the frame/project schema yet
  (that's step 2); when storage exists it should paint the active
  layer's bitmap instead of owning its own.
- **Tools: draw, erase, fill, smudge.** Draw and erase share one brush
  path (erase is `globalCompositeOperation = 'destination-out'`).
- **Brush-tip seam.** Draw/erase don't call `ctx.stroke()`; they
  *stamp* the active brush along the smoothed path. `brush.js` holds
  the tip interface (`stamp(ctx, point, size)` plus `spacingRatio`);
  only `roundBrush` exists, and `canvas.js` exposes `setBrush()`.
  Adding a chisel/textured/edge-blending tip means adding a brush
  object, not touching input or smoothing.
- **Smoothing:** quadratic curve through midpoints of consecutive
  samples, plus coalesced pointer events so fast strokes keep detail.
- **Palm rejection:** first pointer down wins; any pointer landing
  while a stroke is active is ignored. Works in real use on the iPad.
  It doesn't handle every ordering (e.g. palm first).
- **Pressure/tilt are deliberately not read**, so Apple Pencil support
  later is additive, not a rework.
- **Brush size is remembered per tool** (`brushSizes` for draw, erase,
  smudge), matching other apps. Fill has no size, so the slider
  disables itself while Fill is active. `MAX_BRUSH_SIZE` and
  `DEFAULT_COLOR` are exported from `canvas.js` as the single source
  of truth for `ui.js` and the picker.
- **Fill:** tap-only flood fill, iterative (not recursive) so a large
  region can't blow the stack, with a color tolerance
  (`FILL_TOLERANCE = 32`) so anti-aliased edges don't leave a fringe.
  Reads and writes the whole canvas buffer per tap. Speed is fine on
  the iPad.
- **Smudge:** samples a small patch behind the stroke and blends it
  forward, interpolated along the segment (`smudgeAlongLine`) like
  draw/erase, using a reused scratch canvas. Overlapping steps
  *multiply* rather than average, so strength and spacing are tuned
  together (`SMUDGE_STRENGTH = 0.18`, `SMUDGE_SPACING_RATIO = 0.5`,
  separate from `roundBrush.spacingRatio`) to land one pass near ~30%
  blend. **The feel is still not what she expects** — deferred until
  there are more brushes (see Current state).
- **The canvas context deliberately does not set
  `willReadFrequently: true`**, even though smudge and fill call
  `getImageData`. That flag tends to force the whole canvas onto a
  slower CPU path, hurting draw/erase (constant use) to help
  smudge/fill (rare). If those two need help, bound fill's
  read/write region instead.

### Storage (`storage/storage.js`, `storage/autosave.js`) — step 2a

- **Four object stores:** `projects`, `frames`, `blobs` (layer
  bitmaps), `meta` (last-opened project). `frames` and `blobs` have a
  `projectId` index already, so 2d's project delete needs no schema
  upgrade. Store/index changes need a `DB_VERSION` bump and a new
  upgrade branch — never edit the version-1 branch.
- **`bitmapRef` is assigned when a layer is created and never
  changes;** no blob under it means "blank." So a stroke save only
  writes the blob store, never the frame record.
- **Bitmaps are stored as ArrayBuffer + MIME type, not Blob** — older
  WebKit had bugs storing Blobs in IndexedDB.
- **`withTransaction` resolves on transaction *complete*,** so "saved"
  means committed. Don't await non-IndexedDB work inside one (it
  auto-commits early); `saveLayerBitmap` reads the blob first.
- **Autosave (`autosave.js`) is pure timing, no canvas/schema
  knowledge:** debounced 500 ms after the last edit, saves never
  overlap (an edit mid-save gets exactly one follow-up save), and
  `flush()` saves immediately. A failure shows a notice and leaves the
  work unsaved for the next edit to retry — no automatic retry loop.
- **Wiring lives in `main.js`.** It loads and *decodes* the saved PNG
  before the canvas exists (so a late load can't wipe a fresh stroke),
  then hooks `canvas.onChange()` → autosave, and flushes on
  `visibilitychange` → hidden (iPadOS can kill backgrounded apps).
- **If loading fails, autosave stays off** and a notice says so —
  saving a blank canvas over a drawing that merely failed to load
  would destroy it.
- **The canvas still stands in for "Layer 1".** Its persistence seam
  is `onChange` / `exportPNG` / `setImage`; real per-layer surfaces
  come in 2c.
- **Clear is saved like any edit**, so until undo exists (2b) it
  wipes the saved drawing for real.
- **Tool settings are remembered across launches** — active tool,
  color, and per-tool brush sizes. Added after 2a shipped, when she'd
  have had to re-pick her color every launch (a miss: Sketchbook and
  Procreate both remember these, and it should have been raised when
  2a was scoped).
  - **App-wide, not per project** (one `meta` record,
    `toolSettings`): her brush and color follow her into another
    drawing, as in Sketchbook/Procreate.
  - **Pan/zoom/rotation are not remembered** — the view resets on
    launch.
  - **Validation lives in `canvas.js` (`sanitizeToolSettings`)**, since
    that's where tools and size limits are defined; storage saves and
    loads the record as-is. Each field falls back independently, so a
    bad value can't break startup or discard the good ones.
  - `ui.js` starts its controls from `canvas.getSettings()` after
    `applySettings()`, and calls `onSettingsChange` on user changes
    only; `main.js` saves via its own autosaver (300 ms) and flushes
    on hide. A settings load/save failure is only logged — it never
    turns off drawing saves or shows a notice.
- **Tests:** `tests/unit/storage.test.js`, `autosave.test.js`,
  `tool-settings.test.js`, and `tests/e2e/saving.spec.js`,
  `tool-settings.spec.js` (see "Testing"). Device-only and
  unverified: iOS keeping the data across a full relaunch, whether
  `persist()` is granted, and whether the hide-flush finishes before
  iPadOS suspends the app.

### Color picker (`ui/color-picker.js`)

- Custom HSV picker: a saturation/value square (two gradient overlays
  on its own small canvas, dragged with Pointer Events and capture), a
  hue slider, and a hex input. **No native `<input type="color">`** —
  the same reasoning as the ban on native dialogs.
- The hue slider is a native `<input type="range">` (range inputs
  aren't covered by the ban). The hex input validates on `change` and
  snaps back to the last valid color on bad input.
- Opens as a floating panel from a swatch in the rail, positioned from
  the swatch's rect on open; tapping anywhere outside closes it.
- Not built, on purpose: preset/recent swatches, eyedropper, opacity.
  Revisit if she asks.

### Pan / zoom / rotate (`canvas/gestures.js` + dispatch in `canvas.js`)

- **Why before storage:** the cost lives in `canvas.js`'s
  pointer-coordinate mapping. Building storage, layers, and image
  transforms on top of a no-zoom assumption would have meant
  retrofitting all of them. Works on the iPad: zoom follows the
  pinch point, rotation works, two-finger tap resets.
- **Mechanism:** a CSS `translate() rotate() scale()` on the canvas
  element; the bitmap never changes. `gestures.js` is pure math (no
  DOM), `canvas.js` does the dispatch and state.
- **`transform-origin` must be `0 0`.** The anchor math assumes it,
  and CSS defaults to the center, so it's set in JS right where the
  canvas is created — don't move it to CSS without that dependency
  being obvious.
- **`toCanvasPoint` is computed analytically** from the viewport state
  (`screenToNaturalPoint` in `gestures.js`), not from
  `getBoundingClientRect()`. The bounding rect of a rotated element is
  the axis-aligned box *around* it, so it gives wrong coordinates once
  rotated. Every draw/erase/fill/smudge action routes through this
  function — change it carefully.
- **Rotation is accumulated frame to frame** (`shortestAngleDelta`),
  not diffed against the start angle, because `atan2` jumps ~2π at
  ±180° and a long twist would visibly snap. Scale and translate are
  recomputed from the gesture's start values each move, which avoids
  drift.
- **Pinch vs. stroke.** Her stylus almost certainly reports
  `pointerType: 'touch'`, same as a finger. So a touch starts drawing
  immediately (no added latency) but stays a gesture candidate for
  ~150 ms (`GESTURE_WINDOW_MS`) while it has moved under 8 px
  (`GESTURE_MOVEMENT_THRESHOLD_PX`). If a second touch joins in that
  window, the first touch's dot is reverted from a saved pixel patch
  and both become a gesture. `pen` and mouse skip all of this and draw
  immediately, which is also why a real Apple Pencil will slot in
  cleanly. The thresholds are the original reasoned defaults, not
  tuned against her stylus — retune there first if it misfires.
- **Fill is exempt from the revert** (it commits immediately); a
  flood-filled region isn't a cheap patch to restore.
- Lifting either finger ends the gesture; drawing doesn't resume with
  the other finger. Zoom is clamped 1×–8×. A quick two-finger tap
  (≤300 ms, ≤12 px movement) resets pan, zoom, and rotation —
  **changing to a two-finger double-tap in 2b** to match Sketchbook
  (see the gestures decision). A canvas-area size change also resets
  the viewport.

### Layout and PWA

- **Updates (`js/updater.js`, no UI).** `sw.js` doesn't call
  `skipWaiting()` on install, so a new version waits until the page
  asks. The updater notices a waiting worker (already waiting at load,
  mid-install at load, or found later) and `main.js` shows the toast
  (`ui.showUpdatePrompt`). Refresh → `applyUpdate()`: flush unsaved
  work, post `SKIP_WAITING`, reload on `controllerchange` (3 s fallback
  reload if that never fires). A first-ever install doesn't prompt or
  reload: `clients.claim()` fires `controllerchange` then too, so a
  reload only follows if a worker controlled the page at load or an
  update was explicitly requested.
  - **Checks on return to the foreground** (at most once a minute),
    not just on launch — iPadOS keeps home-screen apps suspended for
    days. Added after an update toast vanished on the iPad without the
    update landing. The exact iOS cause wasn't pinned down: this gap
    is real and test-verified; the "mid-install at load" watch is
    defensive (Chromium handled that case anyway; WebKit untested).
  - **Every reload the app causes flushes autosave first**
    (`beforeReload`, capped at 3 s so a stuck save can't block it).
  - **Version:** the page asks the *controlling* worker (`GET_VERSION`
    message in `sw.js`), since that's what decides which files it got.
    `formatVersion` shows `<sha7> · <local date/time>`; "Development
    build" when unstamped; "Unknown" for builds before this existed.
- **Shared origin — scope everything to this app.** GitHub Pages
  serves every project on the account from `bcrossley712.github.io`,
  and caches and service-worker registrations are per-origin. `sw.js`
  activate used to delete *every* cache but its own, which wiped other
  apps' offline caches on each Parapara! update — fixed to delete only
  old `parapara-` caches. Fresh reload likewise touches only
  `parapara-` caches and this scope's registration. (Worth checking
  other projects that copied the old activate handler.)
- **Gear menu (`js/ui/settings-panel.js`)**, bottom of the rail,
  floating panel styled like the color picker; tap outside closes.
  Matches Sketchbook/Procreate keeping app-level actions behind one
  gear/wrench. Contents:
  - Version, and **Check for updates** (permanent) — applies a found
    update immediately; otherwise "You're up to date." / "Couldn't
    check. Are you online?".
  - **Developer section (temporary, remove before calling the app
    done):** *Fresh reload* — unregisters this app's service worker,
    deletes its caches, re-fetches every loaded file with
    `cache: 'reload'` (a plain reload can still hit GitHub's 10-minute
    HTTP cache), then reloads. IndexedDB (drawings, settings) is never
    touched. *Clear drawing* — moved off the rail since there's no
    undo until 2b.
- **App shell sizing.** `.pp-app-shell` is `position: fixed;
  inset: 0`, not `100vh`/`100vw`. In an installed iPad PWA with
  `black-translucent`, `100vh` doesn't match the visible area, which
  pushed the bottom of the rail off-screen (two earlier fixes seemed
  not to work, likely because the old SW pre-cache could serve the
  previous deploy's CSS — see "Service worker pre-cache" below).
  Confirmed working on the iPad. Don't reintroduce `vh` (or `dvh`)
  units for full-screen layout without testing on the device.
- **Safe area.** iOS extends a standalone PWA under the status bar.
  The shell pads with `env(safe-area-inset-*)` on all four sides,
  which only works because of two other settings: global
  `box-sizing: border-box` (otherwise the padding makes the shell
  taller than the screen) and
  `apple-mobile-web-app-status-bar-style: black-translucent` (under
  `default`, iOS reserves the bar and the insets resolve to `0`).
  `black-translucent` draws white status-bar text over whatever is at
  the top edge; that's fine while the rail and stage are dark there.
- **Text inputs stay at `font-size: 16px` or larger.** Below that,
  iOS zooms the page on focus and the zoom can stick.
- **Canvas re-measures with a `ResizeObserver`** on the canvas area,
  not `window` resize. iOS layout (safe area, rotation) can settle
  without a resize event, which would leave `toCanvasPoint`'s
  reference box stale and offset strokes.
- **Service worker pre-cache.** Install uses `cache: 'reload'` so a
  new version never captures the previous deploy's files from the
  HTTP cache. `APP_SHELL` must list every ES module reachable from
  `main.js`; a missing one isn't versioned and can mismatch the rest.
  Add new modules there as they're imported.
- **Tool rail** is bare-bones: Draw / Erase / Fill / Smudge, color
  swatch, size slider, and the gear at the bottom. Clear is in the
  gear's Developer section (no confirm dialog — undo in 2b becomes its
  safety net, as in other apps; until then it wipes the saved
  drawing). Image-import, mic, and the rest land with their own
  steps.

Agreed build order (core app before backend, since the backend is the
most optional piece):

1. Drawing engine prototype (Pointer Events, stroke smoothing, no
   Pencil-specific logic yet) — get input feel right before anything
   else, since a bad drawing feel undermines everything built on top
   of it.
2. Frame/project data model + IndexedDB storage, undo/redo, layers
   UI, project gallery, and a bare-bones frame strip — split into
   2a–2d (see "Next" under Current state).
3. Image import + adjustable image-layer transform per frame.
4. Playback loop + onion skinning (plus fleshing out the frame strip
   started in step 2: reorder, delete, thumbnails).
5. Audio import/record + single-clip trim.
6. Export (ffmpeg.wasm) + native share sheet.
7. Cloudflare Worker + R2 backend (Krita reference import, shareable
   links).

Decided since wireframing:
- **Toolset for the drawing engine: draw, erase, fill, smudge/
  shading (blend tool).** Brush size is remembered per tool for
  draw/erase/smudge (originally planned as one shared control;
  changed to match other apps — see "Built so far"). (See undo/redo
  note above — smudge is why undo is raster-snapshot-based rather
  than command-replay-based.)
- **Default fps: 12** (see architectural decisions above).
- **Multiple drawable layers per frame** (see architectural decisions
  above) — schema locked in, UI deferred to step 2.

Still open:
- Default export format specifics (container/codec) — not needed
  until step 6.

Decided during step 2 planning:
- **Step 2 runs on a higher-capability (Opus-class) model.** Dense,
  interdependent state where a subtle bug is expensive to find late.
  The switch already paid off once: it found the stale SW pre-cache
  bug behind the viewport issue. Still worth comparing the bug-report
  rate on step 2 against step 1's.

## Testing

Tests live in the repo so each new conversation inherits them instead
of re-creating throwaway scripts. **Run them before handing off any
change, and add tests for new logic** (per "Match verification effort
to the change": real logic gets tests; CSS/copy/layout doesn't).

- **Commands:** `npm install` once, then `npm run test:unit`
  (seconds), `npm run test:e2e` (headless Chromium, ~15 s), or
  `npm test` for both.
- **In a Claude sandbox:** a matching Chromium is usually preinstalled
  at `/opt/pw-browsers`; run e2e with
  `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e`.
  `@playwright/test` is pinned to exactly `1.56.0` because that's the
  version matching that browser build — bump the pin only alongside a
  browser that matches it. CI downloads its own browser either way.
- **Unit tests (`tests/unit/`)** use Node's built-in runner (no
  framework) and `fake-indexeddb` for storage. They import the real
  app modules directly — keep logic in modules that don't touch the
  DOM at import time, so they stay testable this way.
  `sw-precache.test.js` enforces the pre-cache rule: it fails if any
  module reachable from `main.js` is missing from `APP_SHELL`, and
  names the file to add.
- **E2E tests (`tests/e2e/`)** run the real app in headless Chromium
  at the iPad's 1080×810 viewport, served by `tests/e2e/serve.js` (no
  Python/extra deps). Each test gets a fresh browser context (empty
  database, no service worker). Mouse input is used for strokes
  because it draws immediately; touch-gesture logic isn't covered by
  e2e yet.
  - **Simulated deploys:** `serve.js` stamps `sw.js` with a version
    that `GET /__test__/state?version=…&slowInstallMs=…` changes
    mid-test (`slowInstallMs` delays install fetches to hold a worker
    mid-install). Test-server only; never on the real site. Because of
    this shared server state, Playwright runs with `workers: 1`.
  - **When adding a test for a fix, check it fails without the fix.**
    The mid-install update test passes in Chromium even without its
    fix — kept as a behavior guard, but it proves nothing about that
    line (see Updates above).
- **CI (`.github/workflows/deploy.yml`):** test job → build job →
  deploy job. A failing test stops the deploy; installed iPads keep
  the last good version. On failure, the Playwright report is uploaded
  as a workflow artifact for 7 days.
- **Published site = app files only.** The build job copies the repo
  into `_site/` *excluding* dev files (tests, npm files, notes,
  README, `.github`). Exclude-list on purpose: a forgotten exclusion
  only leaks a harmless dev file, whereas a forgotten inclusion would
  silently break the app. **New dev-only files at the repo root should
  be added to that exclude list.**
- **Can't be tested outside the device:** real iOS storage eviction,
  touch/stylus feel, iPadOS gesture conflicts, Safari-only rendering
  quirks. Say so when handing off.

## File layout (confirmed)

    index.html
    manifest.json
    sw.js             service worker (version stamped by GH Actions)
    style.css
    README.md
    PROJECT_NOTES.md
    package.json      test tooling only (see "Testing")
    playwright.config.js
    tests/
      unit/           Node built-in runner + fake-indexeddb
      e2e/            Playwright specs + serve.js static server
    js/
      canvas/         pointer input, brush engine, rendering, pan/zoom
                        (canvas.js + brush.js + gestures.js, split as
                        each became a real seam/subsystem of its own —
                        see architectural decisions)
      timeline/        frame array, thumbnails, reorder logic, playback loop
      storage/          IndexedDB wrapper + schema (storage.js), autosave
                        timing (autosave.js); undo/redo history lands
                        here in 2b (in-memory only)
      export/           GIF/WebM stitching, Web Share
      audio/            record/import, trim, Web Audio playback
      ui/               toolbar, buttons, DOM glue
                        (ui.js + color-picker.js + settings-panel.js,
                        same splitting
                        reasoning as canvas/ above)
      main.js           app entry, screen routing (gallery <-> editor)
      updater.js        service-worker registration, updates, version,
                        fresh reload (no UI; main.js wires it)
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
      image: {
        blobRef, x, y, scale, rotation, opacity
      } | null   // reference image — separate from layers, see architectural decisions
    }

    // bitmapRef / blobRef point at entries in a separate blob store
    // (layer bitmaps as PNG blobs), so project/frame records stay
    // small and cheap to read and write.

**Removed in step 2 planning: `frame.undoStack`.** Undo is now one
project-wide history held in memory only, never saved (see the
undo/redo decision). Nothing had been built on the field yet.

Nothing here has been built or tested yet — this file will be updated
as decisions get made and code starts shipping.
