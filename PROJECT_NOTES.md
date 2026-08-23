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

## Working agreements with this user

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

## What's realistically next

Agreed build order (core app before backend, since the backend is the
most optional piece):

1. Drawing engine prototype (Pointer Events, stroke smoothing, no
   Pencil-specific logic yet) — get input feel right before anything
   else, since a bad drawing feel undermines everything built on top
   of it.
2. Frame/project data model + IndexedDB storage layer.
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
      canvas/         pointer input, brush engine, rendering
      timeline/        frame array, thumbnails, reorder logic, playback loop
      storage/          IndexedDB wrapper, schema, undo/redo (raster snapshots)
      export/           GIF/WebM stitching, Web Share
      audio/            record/import, trim, Web Audio playback
      ui/               toolbar, buttons, DOM glue
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
      strokeLayer: bitmapRef,   // single composited raster layer (draw/erase/fill/smudge all paint here)
      undoStack: [ snapshotRef, ... ],  // capped depth, per-frame
      image: {
        blobRef, x, y, scale, rotation, opacity
      } | null
    }

Nothing here has been built or tested yet — this file will be updated
as decisions get made and code starts shipping.
