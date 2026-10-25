# Project Notes — Parapara!

**Required reading before any work.** Current state, rules, and where
things live. The reasoning behind decisions and lessons from past
mistakes are in [`docs/DESIGN_NOTES.md`](docs/DESIGN_NOTES.md) — read
the relevant section when working in that area (links below).

**Keeping these notes healthy:** anything a future conversation *must
follow* goes here, as a short rule with a one-line reason. Longer
reasoning and lessons go in `docs/DESIGN_NOTES.md`. Play-by-play
history goes in git commits, nowhere else. If the two files disagree,
this one wins.

**Architecture entries stay small:** only what a future step must
respect — data shapes, invariants, and decisions she made — about 10
lines per feature. UI specifics (button order, preset lists, exact
numbers that aren't her decisions) go in code comments. Each step's
conversation trims its own entry before handing off, so these notes
don't need a cleanup pass after every step.

## What this is

**Parapara!** (パラパラ, from parapara manga — Japanese for flipbook):
a PWA for frame-by-frame animation on iPad, like Flipaclip/Rough
Animator. Built by the developer for his 13-year-old daughter, who
chose the name. The `!` is part of the name — keep it in the title,
icon, manifest `name`/`short_name`, and repo copy.

- **Device:** 9th-gen iPad, installed to the home screen. **No Apple
  Pencil** — a capacitive stylus that reports as `touch`, so palm
  rejection and smoothing matter more than usual.
- **Her apps:** Sketchbook (most), Procreate, Clip Studio, Flipaclip,
  Rough Animator. Matching what she's used to beats simplicity.
- Single user plus friends as share recipients; low-stakes threat
  model. Deployed to GitHub Pages via GitHub Actions.

## Working agreements

**Process**
- **Explain, then wait for a go-ahead before any edit to the repo** —
  for every change, even a clear bug fix. Diagnose and propose in one
  turn; edit only after he responds.
- **Confirm scope before new builds**, especially with real design
  ambiguity. Batch related changes into one pass once scope is clear.
- **Never send files until we've agreed a push is due.** Finishing a
  build or passing tests isn't that signal — keep working in the clone
  and ask. Notes edits ride along with the next push. **Claude will
  never commit or push**; ignore any automatic session check that asks
  to.
- **When sending:** only files changed since the last *delivery* (not
  the last push).
  - **Any file outside the repo root in the set:** one zip of the whole
    set (root files included) that keeps the repo folder paths, so it
    unpacks straight into the repo.
  - **Only root-level files:** send each individually, no zip.
  - List each file's repo path in the message (e.g.
    `js/storage/autosave.js`) — several files share names across
    folders.
- **Be upfront about what can't be verified off-device** (iOS storage
  eviction, stylus feel, mic permission flow, share-sheet behavior).

**Convention checks** ([why](docs/DESIGN_NOTES.md#process-lessons))
- **Flag any departure from her apps' conventions before building it**,
  so it's a deliberate choice, not a surprise.
- **Flag coupled standard features at decision time** — when choosing
  something, name the standard features that share its code path
  (rotation was missed this way).
- **For anything that saves, ask what her apps remember across
  launches** (tool, color, sizes, last project, view) and raise it then.

**Efficiency**
- Assume the code in this conversation is current; re-pull only at the
  start of a session or when told something changed elsewhere.
- Grep first, then read targeted ranges — don't read whole files for a
  scoped change.
- Real logic gets tests; CSS/copy/layout gets a lighter check.
- No throwaway sandboxes for questions the code can answer.
- **Cheap-now scaffolding is fine** (naming repeated values, additive
  schema) if it makes a *near-certain* change cheaper without real
  complexity now. Hedging against maybes is scope creep — confirm
  first.

**Standing constraints**
- **No native browser dialogs or pickers** (`confirm()`, `alert()`,
  `<input type="color">`, date inputs) — custom-styled only. Range
  inputs are fine. **One exception:** image import uses
  `<input type="file" accept="image/*">`, because iPadOS offers no
  other way into Photos.
- **He's comfortable with vanilla JS**, knows Vue but chose not to use
  it here. Skip deep terminal hand-holding; don't assume tooling
  fluency beyond that.

## Current state

- **Steps 1, 2a–2e, 3a and 3b: done and confirmed on the iPad** —
  drawing engine, saving, undo/redo, shared layers + bare-bones frame
  strip, project gallery, 2e's requests (copy frame/layer, duplicate
  project, eyedropper, recent colors, palette, Clear layer, lock
  blocks delete), the reference image (3a: Image button, HEIC from
  Photos, large photos, adjusting by stylus all checked) and reference
  across frames (3b: Use on all frames, new frames inheriting, Flip ↔ /
  ↕). How each works is under Architecture; she mostly undoes with the
  buttons, not gestures. The color picker's layout is a first try —
  adjust if she wants it different.
- **Ask her when there's a chance** ([why](docs/DESIGN_NOTES.md#reference-image)):
  does she want to draw/erase on the photo itself (→ "Make into
  layer"), and does starting at 50% bother her when it's a background
  (→ remember her last opacity, or a choice on import)? Neither blocks
  step 5.
- **Step 4: done and confirmed on the iPad** — 4a frame cache and
  tile pictures, 4b playback + transport, 4c onion skin, 4d frame
  delete/reorder and the layer menu with Copy / Paste. How each works
  is under Architecture (Frame cache and playback, Playback, Onion
  skin, Frame strip editing, Layer menu); 4a's measurements are in
  [design notes](docs/DESIGN_NOTES.md#playback-and-the-frame-cache).
  Onion skin: she's happy with the colors and 40% for now; if she
  keeps adjusting the opacity, revisit the default.
  - **Frame holds** (a drawing lasting several beats, Rough Animator)
    are out unless she asks; adding them later is an optional
    `frame.hold` (missing = 1) read only by `frameAtBeat`.
  - **Out unless she misses them:** showing the cached frame
    instantly on a frame switch, a scrubber, ping-pong loop, a play
    range (in/out points), a clean fullscreen preview, a frame
    counter, zooming while playing.
- **The data-loss bug: guard built; no recurrence seen in the log
  since, but little use yet** — keep the activity log in and keep
  checking it. iOS emptied a layer's canvas while she drew (storage
  still held every frame); before the guard, her next stroke saved
  blank over the drawing. The guard is under Architecture → Lost
  canvases. Cause (likely memory) unknown: **if the log shows
  `load-renewed`, `load-broken`, `save-refused`, `check-failed`,
  `hold-refused` or `recover`, get the log** — it says when and how
  often, and now also `canvases=<full-size>/<all>` (in the page;
  offscreen ones aren't counted), `play=` and `onion=`.
- **A layer encode that never finishes fails the save after 15 s**
  instead of locking the editor (see Don't break these); if the log
  shows `save-failed … timed out`, get the log.
- **Now: step 5 — audio.** Decided (the reasoning, and what it means
  for step 6, is in [design notes](docs/DESIGN_NOTES.md#planned-features)):
  - **One clip:** record or import, non-destructive trim, and an
    `offset` (seconds, missing = 0) for where it starts in the
    animation. Seconds, not frames: the clock is time.
  - **Stored as recorded or imported, never re-encoded:** recordings
    in whatever Safari's MediaRecorder gives by default (AAC in MP4);
    imports (wav, mp3, m4a, aac) as their original bytes, accepted
    only if a test decode works on the iPad. A blob in `blobs`
    (ArrayBuffer + MIME), added to `mapBlobRefs`. No DB version bump.
  - **Caps:** 3 minutes per clip (it's held decoded, ~23 MB a minute);
    WAV accepted under a size cap (it's ~10 MB a minute).
  - **The animation's length wins:** audio past frames ÷ fps is cut,
    in playback and export. **Audio edits are undoable** (small
    `'audio'` records like `'image'`; blobs stay for the sweep).
    **Nothing new remembered** app-wide.
  - **Clock:** `AudioContext.currentTime` (corrected for output
    latency) through playback's `now` seam; wall clock with no clip.
    "Getting ready" waits for the clip to decode.
  - **Her choices:** **hold to record** (Flipaclip; let go to stop);
    **the animation plays while she records**, so she can time her
    voice to it; **the waveform shows only in the sound panel** —
    the canvas keeps its full height (no lane under the tiles).
  - **Recording:** starts from the frame she's on (`offset` = that
    frame's time); plays without looping and stops picture and
    recording at the last frame, even with loop on. A new recording
    or import **replaces** the clip (undoable); the old one is silent
    while she records. A hold under ~0.5 s records nothing ("Hold to
    record" banner). The first hold asks for the mic, which interrupts
    it — a banner says to hold again. Mic delay: measured on the iPad
    and corrected once in code, no setting.
  - **Sound panel:** a **Sound** button in the top bar (by Image and
    Layers), with a dot when the project has sound. The panel slides
    up over the bottom of the canvas, just above the tiles (covers,
    never shrinks it, like the layers panel): the waveform at the
    tiles' scale, scrolling with them; trim handles on its ends; drag
    its middle to move `offset`; hold-to-record, Import, Delete. Play
    works with it open (a line moves across the waveform); sound
    plays open or closed.
  - **Parts, each confirmed on the iPad before the next:** **5a**
    storage, import and playback in sync (no mic yet) · **5b** the
    sound panel, waveform and trim · **5c** hold-to-record while
    playing.
  - **Out unless she asks** (Flipaclip has them): more tracks,
    slicing, looping past the end, volume, a sound library, scrubbing
    sound while stepping frames.
  - **Device-only:** mic permission in the installed app (iOS may ask
    every launch), whether Silent mode mutes it, recording latency.
- **Build order after step 4:** 5 audio record/import + single-clip
  trim · 6 export + native share sheet · 7 Cloudflare Worker + R2
  (share links, Krita reference import) · then the requested extras
  under Open items.

**Open items**
- **Save the frame cache to IndexedDB?** Not yet. **Trigger:** she
  notices the wait when opening a project (every open rebuilds it —
  ~6–10 s for 48 frames). Saving it would make opens instant but costs
  storage on her near-full iPad (roughly 0.5–1 MB per frame for real
  line art) and adds a derived blob kind that the sweep and duplicate
  project must handle, like the thumbnail.
- **Merge down** — deferred on purpose (needs opacity-aware
  compositing and a two-layer undo entry). Revisit after step 4.
- **Fill sample toggle** (current layer vs all visible, as Sketchbook
  offers) — fill always samples all visible layers; add the toggle if
  she asks.
- **Smudge feel** is off; deferred until more brushes exist (she ties
  it to brushes that soften their own edges). Don't retune it alone.
  ([why](docs/DESIGN_NOTES.md#drawing-engine))
- **After the main build — requested, deferred so step 4 comes sooner**
  ([why](docs/DESIGN_NOTES.md#after-the-main-build-requested-deferred)):
  - **Flip drawing** (was 3c; the layer menu it goes in was built in
    4d): Flip H/V items in the layer menu. Flip = active layer, this
    frame, one `'pixels'` undo entry; lock/hide refuse it.
  - **Symmetry** (was 3d): rail toggle, vertical/horizontal/both,
    fixed axis at canvas center (not movable), saved per project; draw,
    erase and smudge mirror, fill doesn't. Mirrored stamps must grow the
    dirty rect.
  - **Brush variety** (sizes, chisel tips, edge blending) — **build
    with symmetry**: both change `stamp()`, and a directional tip's
    mirrored stamp must mirror its angle too.
  - **Stabilizer** (requested after 4c — Flipaclip's; smooths out the
    wobble as she draws): a strength setting that makes the line trail
    the stylus. **Build with the brush block** — same stroke path in
    `canvas.js` and the same tool-settings UI. Draw and erase, not fill
    (smudge: decide then); strength remembered app-wide like size; the
    line catches up to the stylus on lift; symmetry mirrors the
    stabilized points. Pull forward on its own if the wobble bothers
    her sooner. Today: fixed midpoint smoothing only.
  - **Erasers** (observed in 4a; she'll want them, not urgent): the
    eraser is the pen's round hard tip with the same 6 px default and
    1–60 range (its size is already remembered separately). She'll
    want softer edges and different sizes — part of brush variety.
    **Don't just widen the size slider:** the rail's slider is small,
    so a bigger range makes precise sizes harder to pick; bigger sizes
    need a different size control (or eraser presets) when this is
    built.
- **Small screens (phones) aren't workable** — seen on his Android
  phone, 4b build. The layout is sized for the iPad and nothing
  scrolls or reflows. **Landscape:** the rail runs out of height, so
  the size slider and gear are cut off. **Portrait:** the strip's row
  runs out of width, so the frame tiles and Add frame are cut off,
  and the canvas is a thin band. The onion badge (4c) will add to it.
  Not her device, so not blocking; if friends will use it on phones,
  plan a compact layout (a rail that scrolls or collapses, a strip
  that scrolls with the transport, smaller controls) as its own step.
- **Color opacity** — not in the picker on purpose; revisit if she
  asks.
- **Export format** (container/codec) — decide at step 6.
- **Step 6: does the reference image go into the export?** A tracing
  photo usually shouldn't, a background should. Today Hide images
  decides both what she sees and what exports; consider an "include
  images" choice when exporting.
- **Storage warning** (~80% of quota) — deferred to step 6, when
  export gives it a remedy to point at.
- **Onion skin extras — revisit in final touches**, once she knows
  onion skins (she's too new to judge them now): wrap-around with
  loop, ghosts of the active layer only.
- **Rename from the editor** (tap the title, as Procreate does) —
  gallery-only for now.
- **How-to / tutorials** reachable from the settings (gear) menu —
  later, once there's enough to explain (gestures, layers, frames).
- **Adjustable shortcut bar** (as in Clip Studio's command bar), after
  step 6, once she knows which actions she reaches for. It needs one
  registry of actions that every button calls. Shortcuts add a second
  way to reach an action; they don't move it out of its home. Core
  items stay fixed. Saved app-wide.
  ([details](docs/DESIGN_NOTES.md#after-the-main-build-requested-deferred))
- **"Make into layer"** (bake the reference image into a new layer) —
  only if she wants to draw/erase on the photo itself (see "Ask her").
  This is additive, not a rewrite.

**Planned UI layout** (from wireframes): tool rail down the left;
transport (prev / play / next / loop / fps) at the **left end of the
frame strip's row** (4b — the wireframe had it in its own row above
the strip; moved to save the canvas ~48 px, Flipaclip-style);
horizontally scrolling frame strip with a dashed "add frame" tile
(the wireframe's image marker was dropped in 3b — step 4's thumbnails
show the photo instead); onion-skin toggle as a
badge in the canvas area's bottom-left corner (4c); Share as a
first-class top-bar icon. Layers panel
on the right, over the canvas (doesn't shrink it), opened from a
top-bar button. Sound panel (step 5): slides up over the bottom of the
canvas above the frame tiles, opened from a top-bar Sound button.

## Architecture

Short rules; reasoning in the linked sections.

- **Stack:** vanilla JS, native ES modules, no framework, no bundler.
  Nothing from npm ships; npm is test tooling only. CI tests, copies
  app files, and stamps the service-worker version — never compiles.
  ([why](docs/DESIGN_NOTES.md#stack))
- **Input:** Pointer Events only. Pressure/tilt deliberately unread, so
  Apple Pencil support is additive. **Two deliberate exceptions**, both
  non-passive listeners that only call `preventDefault()`, with no
  recognition logic: `touchstart`/`touchmove` on the canvas area with
  3+ touches down (keeps iPadOS's three-finger undo out of the way),
  and `touchmove` on the frame strip while a tile is lifted (4d; the
  strip mustn't scroll under a drag).
  ([why](docs/DESIGN_NOTES.md#gestures))
- **Scope-specific folders** (`canvas/`, `timeline/`, `storage/`,
  `export/`, `audio/`, `ui/`); modules don't reach into each other's
  internals — they share the project/frame data shapes, and `main.js`
  is the glue.
- **Schema:** the thing to get right. Extend additively (new optional
  fields), never restructure. See [Schema](#schema).
- **Storage:** IndexedDB, fully client-side. Layer bitmaps as PNG.
  Autosave after a stroke ends, never mid-stroke. Requests
  `navigator.storage.persist()`. ([why](docs/DESIGN_NOTES.md#storage))
- **Layers** ([why](docs/DESIGN_NOTES.md#layers-and-undo)):
  - **Shared across the whole animation, Flipaclip-style:** the
    project owns the layer list and properties (name, order, visible,
    opacity, locked); each frame holds only its own pixels per layer.
    Hide/rename/add applies to every frame.
  - v1 = add/delete, reorder, visibility, opacity, lock, rename,
    thumbnails (in memory, refreshed when an edit commits); no blend
    modes/groups/masks. Cap **8 per project** (`MAX_LAYERS` in
    `layers.js`). The reference image is separate from layers.
  - A new layer goes directly above the active one, becomes active,
    and is named "Layer N". The last layer can't be deleted; after a
    delete the layer below becomes active. No delete confirm (undoable).
  - **Locked or hidden active layer:** strokes, fill and Clear are
    refused with a notice; a touch on it can still become a gesture.
    **Lock also blocks Delete** (2e) — lock protects the layer, not
    just its pixels. Rename, move, opacity and Duplicate stay allowed.
    The menu items stay tappable; the banner says why. Merge down
    (later) must respect lock too.
  - **Layer menu (4d)** ([why](docs/DESIGN_NOTES.md#after-the-main-build-requested-deferred)):
    tapping the **active** layer's row opens it (another row just
    selects). Items: Copy, Paste, Rename, Duplicate, Clear, Delete;
    Flip H/V and merge down join later. The footer keeps only opacity.
  - **Clear** (layer menu; 2e): the active layer on this frame only,
    undoable. Replaced the gear menu's dev "Clear drawing".
  - **Frames:** add frame inserts a blank frame *after* the current
    one, with a slot for every layer, and moves onto it. Tapping the
    current frame's tile opens the frame menu (Duplicate, Delete —
    4d). Moving to
    another frame saves the current one first, then reads the next
    one's layers from storage; a layer that can't be saved (or saving
    is off) is held in memory by bitmapRef until it can be.
  - **Rendering:** one `<canvas>` per layer stacked in a wrapper
    (`.pp-canvas`) that carries the view transform; visibility/opacity
    are CSS. Input is heard on the whole canvas area, so gestures work
    with fingers off the page and a stroke can start off it. Only the
    open frame's layers are in memory; changing frames reuses the same
    layer canvases.
  - **Fill reads every visible layer** (composited at opacity) and
    writes only the active one, so color fills up to line art on
    another layer. **Smudge reads and writes the active layer only.**
- **Undo/redo** ([why](docs/DESIGN_NOTES.md#layers-and-undo)):
  - Raster snapshots, not replayable commands.
  - One project-wide history (entries tagged with `frameId`; undo jumps
    to that frame), **in memory only, never saved**.
  - Entries store only what changed — usually one layer cropped to the
    stroke's bounds — and hold **one patch at a time** (undo swaps in
    "before" and keeps "after"; redo the reverse).
  - Caps: **30 steps and ~150 MB**, oldest dropped first. **The byte
    budget counts undo and redo together.**
  - Capture uses **one committed copy of the active layer only** (never
    one per layer); it follows the active layer — a layer switch
    resyncs it. The same copy reverts a touch that became a gesture.
  - Layer structure changes are undoable on the same stack (new entry
    `type`s alongside `'pixels'`): add, delete, reorder, opacity, add
    frame, `'frame-delete'` and `'frame-move'` (4d), `'image'` (3a),
    and `'image-all'` (3b, Use on all frames:
    keeps each changed frame's old image; undo jumps to the frame it
    was applied from). **Visibility, lock and Hide images are
    not undoable** (view state, as in Photoshop). Rename isn't either. An entry for another frame moves
    to that frame first. Undoing an add frame takes the frame out (its
    record is deleted, its pixels stay in storage for redo).
  - **Removing a layer** (delete, or undoing an add) saves its pixels
    first and leaves them in storage under the frames' old refs, which
    the entry keeps; bringing it back reloads them. Undo never holds a
    removed layer's pixels in memory (unless they couldn't be saved).
  - Anything async (layer add/remove, frame loads) runs one at a time;
    meanwhile undo/redo, panel actions and new touches are ignored.
  - `history.js` and `layers.js` are pure; `canvas.js` exposes the
    seams; `main.js` glues.
- **Copying (2e)** — copy frame (frame menu), copy layer (layer
  menu's Duplicate), duplicate project (gallery ⋯):
  - Record builders in `layers.js` are pure and return `pairs` of
    [fromBlob, toBlob]; **pixels are copied before anything points at
    the new refs**, one blob in memory at a time.
  - In the editor, the open frame is saved first, so a copy matches
    what she sees (unsaved pixels included).
  - Copy frame: whole record, new bitmapRefs, `frame.image` shared.
    Copy layer: "<name> copy", unlocked, directly above, active; counts
    toward the cap. Both undo as plain `'frame-add'` / `'layer-add'`.
  - Duplicate project: "<name> copy", new ids for project, frames and
    every blob (thumbnail → `thumb-<newId>`), layer ids kept; first in
    the gallery; she stays on the gallery. One transaction.
- **Colors (2e)** — all in the color picker (UI in `color-picker.js`,
  list rules in `storage/colors.js`):
  - **Eyedropper** samples what she sees (`readVisible`, over white),
    is a one-shot mode, not one of `TOOLS`, never saved, and works on
    locked/hidden layers. A second finger makes it a gesture.
  - **Recent colors:** app-wide, 8, added when a draw or fill
    *commits* (not on picker moves or picks); `meta.recentColors`.
  - **Palette:** per project, 10, saved on the project record; edits
    aren't undoable (as in Procreate).
- **Gestures — match Sketchbook defaults**
  ([why](docs/DESIGN_NOTES.md#gestures)): three-finger tap = undo;
  three-finger swipe left/right = undo/redo; two-finger double-tap =
  reset view; two-finger single tap does nothing; two-finger drag/pinch/twist =
  pan/zoom/rotate; visible undo/redo buttons too. Later, with a brush
  library: three-finger swipe up = color, down = brushes.
- **Tool settings** (tool, color, per-tool sizes) are remembered
  app-wide, not per project, and carry from one project into the next.
  Per project: the open frame and active layer. App-wide: whether the
  layers panel was open, which screen she was on, and the last
  project. The view (pan/zoom/rotation) resets on launch and on every
  open.
- **Messages:** information that isn't a problem (locked/hidden
  layer, layer cap) is a fading banner that never blocks touches
  (`showBanner`); real problems (couldn't save) are a toast that waits
  for OK (`showNotice`).
- **Projects and screens** ([why](docs/DESIGN_NOTES.md#gallery)):
  - The gallery or one project in the editor, never both. `main.js`
    routes: `mountEditor(session)` builds the editor; its Gallery
    button runs `close()`, which flushes, redraws the thumbnail, then
    `ui.destroy()` → `canvas.destroy()`. No page reload.
  - **Launch reopens where she left off** (`uiState.screen` +
    `lastProjectId`), like Procreate/Sketchbook. Installs from before
    2d have no `screen` and open the editor. No projects → the empty
    gallery (no auto-created project).
  - **Load before switching:** a project is fully loaded (including
    decoding frame layers) before the gallery is torn down; if it
    fails, she stays on the gallery with a notice.
  - Undo history is per open project and is dropped on close.
  - New project: one tap, named "Animation N" (one past the highest);
    size/fps defaults, no setup dialog. Rename doesn't bump
    `updatedAt`; drawing does (`saveLayerBitmap`), so newest-first
    means most recently drawn on.
  - **Thumbnail = frame 1**, visible layers at their opacity over
    white, 480 px wide PNG (`canvas/thumbnail.js`, drawn from saved
    bitmaps). Redrawn on close and on hide when something in frame 1
    changed; the gallery draws any that are missing.
  - Delete is a custom confirm and not undoable; it removes the
    project, frames and blobs in one transaction.
- **Defaults:** canvas 1920×1080 landscape, 12 fps — both stored per
  project, not hardcoded.
- **Updates:** a new version waits for the user (toast or gear menu),
  never swaps silently. Every reload the app causes flushes unsaved
  work first. ([why](docs/DESIGN_NOTES.md#pwa-layout-and-updates))
- **Reference image (3a)** ([why](docs/DESIGN_NOTES.md#reference-image)):
  - A separate, non-destructive image under every layer — never drawn
    on, not one of the 8 layers. `frame.image` (see Schema); frames may
    share one blob. Placement math is pure (`canvas/transform.js`);
    display and import live in `canvas/reference.js`.
  - Controls: the top-bar **Image** button (`ui/image-menu.js`) —
    Add/Adjust image, **Use on all frames** (3b; shown when this frame
    has one and there are other frames), and project-wide **Hide
    images** (`referenceHidden`, view state, not undoable). Adjust
    mode swaps the rail for a bar (opacity, Flip ↔, Flip ↕, Replace,
    Delete, Done); in it two fingers transform the image, not the
    view; undo/redo are off. No frame-strip marker.
  - **Flip (3b):** `flipX`/`flipY` booleans (missing = false), never a
    negative scale (`sanitizePlacement` would reset it to a fresh
    fit). Flips as seen on screen, whatever the rotation
    (`flipPlacement`: toggles the flag, negates rotation). Part of the
    adjust session's one undo step. Everything draws through
    `placementMatrix`, so view, `readVisible`, thumbnail, and later
    onion skin/export all get it.
  - **Use on all frames (3b):** copies this frame's image record
    (photo + placement + flips) onto every frame as one `'image-all'`
    entry; frames keep their own placement afterward. A custom confirm
    only when another frame has a *different* photo (blank frames and
    a re-placed copy of the same photo don't ask). Banner says how
    many frames. Rules are pure in `timeline/frames.js`
    (`imageForAllFrames`).
  - **New frames inherit (3b):** add frame copies the current frame's
    image when every frame has the same photo — including a project
    with one frame — else starts blank (`inheritedImage`). No schema
    flag. Copy frame already shares the image.
  - **While a picked photo is being prepared (Replace), the adjust
    bar's controls are disabled** and an outside tap doesn't commit
    (`onDone` ignored while busy). Otherwise Done commits the old
    photo and the new one reopens adjust mode a moment later.
  - One adjust session = one `'image'` undo entry (small records;
    blobs stay in storage for the sweep). Leaving the app commits too.
    **The commit queues its frame save on `frameSaves`; `flush()` and
    `close()` must wait on it.**
  - **A missing or undecodable image is skipped, never a failed load**
    (a failed load turns saving off — see Don't break these).
  - Import: fit, centered, 50% opacity; long side ≤ the canvas's;
    JPEG 0.7 unless pixels are actually transparent (then PNG). Space
    wins over sharpness — her iPad runs near full.
  - Everything that shows "the frame" includes it via one path:
    `readVisible`, the thumbnail, and later export; Hide images drops
    it from all of them. **Onion-skin ghosts never include it** (4c;
    a ghosted photo is busy).
- **Frame cache and playback (4a)**
  ([why](docs/DESIGN_NOTES.md#playback-and-the-frame-cache)):
  - **One `renderFrame`** (`canvas/render-frame.js`) flattens a frame
    for the gallery thumbnail, tiles, the cache, and later onion skin
    and export. Nothing else composites frames.
  - **The cache** (`timeline/frame-cache.js`): each frame flattened at
    **full size, layers only (transparent), as PNG, in memory only**.
    Paper and the reference image are added when shown, so Hide images
    and image edits never invalidate it. **Tiles show the frame's photo**
    (unless Hide images is on) — that's how she sees which frames have
    one; there's no separate marker. Playback decodes a small ring
    just ahead of the playhead — never every frame at once.
  - **Freshness:** an entry is stale when the *layer signature*
    (visible layers' ids + opacity, in order) or the frame's *content
    version* (bumped by commit, undo/redo, Clear, copy) changes. A
    signature change marks every frame stale at once, cheaply.
  - **Rebuild** runs in the background ~300 ms after changes settle,
    nearest the current frame first, one frame at a time, never
    mid-stroke; a result that went stale while building is dropped.
    Stale tiles stay up until replaced. Rebuilt on every project open.
  - **Clock** (`timeline/clock.js`): one animation loop asks a clock for
    elapsed time; `frameAtTime` picks the frame. Late frames are
    skipped, never slowed — aim at where the playhead will be, keep the
    last good frame up. Step 5 swaps in the audio clock without
    touching the loop.
- **Playback (4b)** ([why](docs/DESIGN_NOTES.md#playback-and-the-frame-cache)):
  - **Transport** (`timeline/transport.js`): prev / play / next, loop
    toggle, fps. **fps 1–30, default 12; loop on by default.** Saved on
    the project, apply at once (even mid-play), **not undoable**.
  - **Play** starts on her current frame; it never starts early — if
    frames still need flattening it shows "Getting ready" (the cache is
    rushed). A frame whose flatten failed doesn't hold it up.
  - **The loop** (`timeline/playback.js`, pure): frame from elapsed
    time, a small decoded ring ahead, late frames skipped. The picture
    is one canvas above the layers, at her current zoom/pan/rotation,
    existing only while playing.
  - **Stopping lands her on the frame that was showing** (a normal
    frame load); loop off stops on the last frame.
  - **While playing she can't draw:** a touch stops playback and is
    swallowed until every finger is up. **Anything that changes the
    project stops playback, lands, then acts** (`afterPlayback` in
    `main.js`). Settings (tool, color, size, fps, loop) don't stop it.
    **The Image button only stops** — iOS won't open the photo picker
    after a wait. Hiding the app stops it.
- **Onion skin (4c)** ([why](docs/DESIGN_NOTES.md#onion-skin)):
  - **Ghosts** are neighbors' cached pictures (layers only — **never
    the photo**, hidden layers out), tinted one color, on one canvas
    over the photo and under every layer. Previous red, next green,
    further ones fainter. **No wrap-around**, even with loop. Rules
    pure in `timeline/onion.js`; drawing in `canvas/onion-view.js`.
  - **Defaults (convention, not yet checked with her):** off; 1 before,
    1 after (0–3 each); 40% (10–80%). **Saved per project
    (`project.onionSkin`), not undoable**; bad fields fall back one by
    one.
  - A ghost not flattened yet is left out; a stale one shows until
    rebuilt. **Hidden while playing and landing.** The toggle and its
    settings are a badge on the canvas (`ui/onion-badge.js`); a
    setting, so it doesn't stop playback.
  - **Left out unless she asks:** wrap-around, active-layer-only
    ghosts, keyframe-only onion, per-frame ghost toggles.
- **Frame strip editing (4d)** — delete and reorder on the strip;
  copy/paste in the layer menu:
  - **Delete:** frame menu, no confirm (undoable), not on the last
    frame. `'frame-delete'` is `'frame-add'` run backwards; pixels stay
    in storage under the frame's refs for undo.
  - **Reorder:** long-press a tile and drag; she stays on her frame.
    Only `project.frames` changes; `'frame-move'` keeps `from`/`to`.
  - **Copy / Paste:** Copy takes the active layer's drawing on this
    frame (after `checkLayer` — a lost canvas would copy blank). Paste
    goes **on top** in **whichever layer is active** — her choice,
    never a new layer. One `'pixels'` undo entry; lock/hide refuse it.
    Clipboard lives in memory, open project only.
  - All three can change frame 1, so they mark the gallery thumbnail
    stale.
- **Lost canvases (after 4c)** ([why](docs/DESIGN_NOTES.md#lost-canvases))
  — iOS can empty a layer canvas without telling the page; saving it
  would write blank over her drawing.
  - **Ink maps** (`canvas/ink-map.js`, pure): a 1/8-scale grid of
    which cells have paint, per layer; edits mark the cells they touch.
    **Lost = ink gone from cells she didn't edit** (≥ 8 cells and ≥ half
    of them), so erasing — even everything — never trips it. A canvas
    losing only a few cells isn't caught (on purpose: no noise trips).
  - **On every load** (`loadFrame`, `setLayerImage` → `fillSurface`):
    the map comes from the decoded image; if the canvas doesn't hold
    it, the canvas element is swapped for a fresh one (and the
    committed copy too) and drawn again — a banner says so. Still not
    holding it → `broken`: painting refused, notice to reopen the app.
  - **Before every save** and when the app comes back into view
    (`checkLayer`): a lost layer isn't saved (or held in memory); it's
    reloaded from storage onto a fresh canvas (`recoverLayers`, one at
    a time, waits for a quiet moment) with a notice. Strokes since the
    last save are lost; the drawing isn't.
- **Planned** ([details](docs/DESIGN_NOTES.md#planned-features)):
  one audio clip as
  `audioClips: []`, non-destructive trim (step 5's decisions are under
  Current state); export to video + Web Share,
  then share links and Krita import via Worker + R2; storage warning at
  ~80% quota (with step 6).

## Don't break these

Each is here because breaking it caused (or would cause) a real bug.

**Canvas** ([why](docs/DESIGN_NOTES.md#gestures))
- The wrapper's (`.pp-canvas`) `transform-origin` is `0 0`, set in JS
  where it's created — the gesture math depends on it. The transform
  goes on the wrapper, never on a layer canvas.
- Layer canvases are `pointer-events: none`; pointer listeners and
  capture belong to the canvas area (`.pp-canvas-area`), never the
  page or a layer — fingers off the page must still count.
- **Anything that changes a frame's pixels must `frameCache.touch`
  that frame** (`main.js`): `markUnsaved` and `swapPixels` do. A
  change to what layers show goes through `layerSignature`, picked up
  in `refreshPanel`. Miss one and that frame's tile (and later its
  playback) shows old pixels until something else touches it.
- **The cache holds layers only** — no paper, no reference image.
  Paper and photo are added when it's shown (`drawFlattened`), so Hide
  images and image edits never invalidate it.
- **The open frame flattens from its live canvases, synchronously**
  (`layerSource` in `renderFrame`); others from storage. An await in
  the live path would let a stroke land halfway through.
- **Autosave exports every unsaved layer in the same tick and saves
  each to the ref of the frame it was exported from** (`session.frame`
  captured before any await). Reading the ref after awaiting the
  encode could put one frame's pixels under another frame's ref.
- **`canvasApi.getLayerImage` is read-only** — drawing into it skips
  undo and saving.
- **`exportPNG` gives up after `EXPORT_TIMEOUT_MS` (15 s)** with a
  `TimeoutError` (step 5). Every save and frame switch waits on it, so
  a `toBlob` that never calls back would otherwise lock the editor
  with no message. Autosave shows its own notice for it (not "out of
  space"); the layer stays unsaved and the next edit retries.
- **Every change to a layer's pixels marks its ink map** — through
  `notifyChange`, `swapRegion`, `revertUncommitted` (`noteEdit`), or
  a full refill through `fillSurface` (loads, `setLayerImage`). A new
  pixel path that skips this makes the save guard refuse her own edit
  (or miss a lost canvas).
- **Never save or hold a layer whose `checkLayer` fails** (autosave's
  save, `leaveFrame`). Any new path that writes layer pixels to
  storage from the live canvas goes through it too.
- **Layer canvas elements can be replaced** (`renewSurface`) — never
  keep a reference to a `.pp-layer` element or its context across
  calls; ask `canvasApi` each time. Same for the committed copy.
- **`readVisible(rect)` (`canvas.js`) is the one "what she sees"
  sampler** for fill and the eyedropper. The reference image (3a) is
  in it, under the layers, when showing (its single-layer fast path
  is skipped then). The onion skin's ghosts and the playback picture
  must stay out (they aren't her drawing).
- **The ghost canvas (`.pp-onion`) sits right after the reference
  holder and before every layer** (`reference.element.after(...)`;
  `applyLayers` appends layers after it). It isn't a `.pp-layer` —
  tests count those.
- **The onion badge stops its own pointer events** (`onion-badge.js`).
  It's inside the canvas area, whose pointerdown takes the pointer for
  a stroke: without the stop, the badge's buttons never get a click
  (and a tap during playback would stop it).
- **The playback picture (`.pp-playback`) stays the wrapper's last
  child** — `applyLayers` re-appends it after the layers.
- **The playback swallow runs before the `inputBlocked` check** in
  `onPointerDown`, and swallowed pointers are handled first in move
  and up. Otherwise a stop that lands on the same frame (no frame
  load, so no input block) lets the stop tap draw, and a finger
  joining it would start a stroke. A primary pointer with nothing
  playing clears stale entries.
- **The reference holder (`.pp-reference`) stays the wrapper's first
  child** (`prepend`; `applyLayers` appends layers after it), so it's
  under every layer. It and its image keep `transform-origin: 0 0`,
  and the holder is rescaled in `fitStack`. Otherwise the image drifts
  from where fill and the eyedropper think it is.
- **Adjust mode commits on outside taps in the capture phase, on
  `click` for buttons** (`ui.js`). The commit re-renders the frame
  strip, and a tile replaced between pointerdown and pointerup never
  gets its click. Sliders commit on pointerdown, since they never
  click. Disabled controls don't commit.
- **The picker opens inside the tap:** `ui.pickImage()` must run
  synchronously from a click (Image menu item, Replace). An `await`
  before it and iOS won't open the picker.
- Fill's region comes from the visible-layer composite, its pixels go
  to the active layer only — never write the composite back.
- `toCanvasPoint` is computed analytically from viewport state, never
  from `getBoundingClientRect()` (wrong once rotated). Every tool
  routes through it.
- Rotation accumulates frame to frame (`shortestAngleDelta`), never
  diffed against the start angle.
- **A layer's context keeps the last stroke's blending mode** — erase
  leaves `destination-out` set. Anything that draws onto a layer
  outside a stroke (paste, 4d) sets `source-over` and alpha 1 itself
  inside `save()`/`restore()`, or it erases instead (the robot test
  caught this).
- Fill applies immediately but is a gesture candidate like draw/erase:
  a second finger in the window reverts it from the committed copy. It
  commits on pointerup.
- Every paint operation marks the dirty rect (`stamp()`, smudge step,
  fill bounds) — a mark outside it won't be undoable or revertible.
- Anything that replaces layer pixels outside a stroke (`setImage`,
  `swapRegion`, `clear`) must also update the committed copy.
- No `willReadFrequently: true` on the main canvas context.

**Storage** ([why](docs/DESIGN_NOTES.md#storage))
- Store/index changes need a `DB_VERSION` bump and a *new* upgrade
  branch — never edit an existing branch.
- Bitmaps stored as ArrayBuffer + MIME type, not Blob.
- Don't await non-IndexedDB work inside `withTransaction` (it
  auto-commits early).
- Never save over work that failed to load: opening a project that
  fails leaves her on the gallery; if the database can't open at all,
  the editor runs on an unsaved in-memory project with no Gallery
  button.
- **The sweep (on every project open) deletes every blob of the
  project not listed by `referencedBlobIds` (`layers.js`).** Both it
  and duplicate project walk refs through **`mapBlobRefs`** — the one
  list of where blob refs live. Any new kind of blob reference (step 3
  images, step 5 audio) must be added there, or the sweep deletes it
  and a duplicate shares it with the original. The thumbnail
  (`thumbnailBlobId`) is derived, not a field; both handle it
  separately.
- `savedDrawingBytes` in the e2e helpers skips `thumb-` blobs — keep
  that if thumbnail ids change.
- Tool-settings validation lives in `canvas.js`
  (`sanitizeToolSettings`); bad fields fall back individually.

**Layout, PWA, updates** ([why](docs/DESIGN_NOTES.md#pwa-layout-and-updates))
- `#app` is `position: fixed; inset: 0`; each screen's shell inside it
  is `position: absolute; inset: 0` — never `vh`/`dvh` units for
  full-screen layout without testing on the iPad.
- Safe-area padding needs `viewport-fit=cover`,
  `black-translucent`, and global `box-sizing: border-box` — keep all
  three.
- **Anything at the top edge stays dark**, including `theme-color`,
  the manifest's `theme_color`/`background_color`, and the `html, body`
  background — iPadOS restyles the status bar from them.
  ([why](docs/DESIGN_NOTES.md#pwa-layout-and-updates))
- **`#app` is the one fixed box at the top edge, and it's never
  replaced** — screens inside it are absolute, not fixed, and swap
  with no empty moment (load the next screen's data first). No
  `backdrop-filter`, gradient or see-through bar at the top. Otherwise
  iPadOS 26 blurs the top of the app until relaunch.
  ([why](docs/DESIGN_NOTES.md#pwa-layout-and-updates))
- Text inputs ≥ 16px font.
- **No arrow or symbol characters as icons in labels** (↔, ↕, ✓, ★ …)
  — iOS may draw them as color emoji (↕ did, in 3b's flip button),
  and desktop Chromium won't show it. Use inline SVG with
  `currentColor`.
- Layouts must tolerate wider text than desktop Chromium shows — no
  `nowrap` on content that could grow.
- **Names she types wrap but clamp at two lines** (layer rows, gallery
  cards) and have a length cap (`MAX_LAYER_NAME` 40 in `layers.js`,
  `MAX_PROJECT_NAME` 60 in `storage.js`) that copies keep to too
  (`copyName`) — an unclamped name grew the row without limit.
- The canvas re-measures via `ResizeObserver` on the canvas area, not
  window resize.
- **Anything an editor screen hooks up outside its own elements**
  (document listeners, observers) must be undone by `destroy()` —
  `ui.js` and `gallery.js` route document listeners through an
  `AbortController`. `canvas.destroy()` shrinks every canvas to 0×0 so
  iOS frees that memory before the next project loads.
- Screen switches save `uiState` immediately, not debounced, so
  closing the app straight after still reopens the right screen.
- `sw.js` `APP_SHELL` lists every module reachable from `main.js`
  (a test enforces this). Pre-cache uses `cache: 'reload'`.
- **Shared origin:** all of the account's GitHub Pages projects share
  `bcrossley712.github.io`. Only ever touch `parapara-` caches and
  this scope's service-worker registration.
- First install must not reload the page (`clients.claim()` fires
  `controllerchange` then too).

## Where things live

    index.html, manifest.json, style.css
    sw.js                 service worker; VERSION stamped by CI
    js/
      main.js             entry + glue: screen routing (gallery ↔ editor),
                          storage ↔ canvas ↔ ui, autosave, thumbnails,
                          updater ↔ toast/gear
      updater.js          SW registration, update checks/apply, version,
                          fresh reload — no UI
      canvas/
        canvas.js         input dispatch, tools, viewport, layer surfaces,
                          committed copy; its returned API is the only
                          way other modules touch the canvas
        render-frame.js   renderFrame: the one "frame, flattened" rule
                          (gallery thumbnail, cache, tiles; later onion
                          skin, export); drawFlattened, loadReference
        frame-tiles.js    frame strip pictures: cached layers over
                          paper + the frame's photo (4a-ii)
        playback-frames.js  playback's decode (cached layers + photo,
                          shared by blobRef) and draw (4b)
        onion-view.js     onion skin's ghosts: decode cached pictures,
                          tint, draw onto the ghost canvas (4c)
        thumbnail.js      frame-1 gallery thumbnail from saved bitmaps
                          (reference image first, unless hidden)
        reference.js      reference image: on-screen view, drawReference,
                          prepareImport (3a)
        transform.js      pure placement math for the reference image
        brush.js          brush-tip seam: stamp(ctx, point, size)
        gestures.js       pure pan/zoom/rotate math + tap/swipe classifiers
        region.js         pure dirty-rect helpers; inkBounds (4d copy)
        ink-map.js        pure lost-canvas rule: ink maps, edited cells,
                          looksLost (after 4c)
      storage/
        storage.js        IndexedDB wrapper + schema factories
        autosave.js       save timing only (debounce, no overlap, flush)
        history.js        undo/redo stack, caps, byte budget (in memory)
        layers.js         pure layer-list + bitmap-slot ops, MAX_LAYERS,
                          mapBlobRefs / referencedBlobIds (launch
                          sweep), copy record builders
        colors.js         pure recents/palette list ops, MAX_RECENTS,
                          MAX_PALETTE, saved-list validation
        dev-log.js        DEV ONLY: activity log, 300 lines in
                          localStorage, written at most once a second
                          and on hide
      ui/
        ui.js             editor: top bar (Gallery, undo/redo, Image, Layers),
                          tool rail, toasts/banners, DOM glue, destroy
        gallery.js        gallery screen (UI only; intents via callbacks)
        confirm-dialog.js custom modal: showConfirm / showPrompt
        icons.js          icons shared by both screens
        layers-panel.js   layers panel + layer menu (4d) (UI only;
                          intents via callbacks)
        reference-bar.js  adjust-image bar that replaces the rail (UI only)
        image-menu.js     top-bar Image button + menu, state dot/slash
                          (UI only)
        onion-badge.js    onion skin's badge + settings panel (UI only)
                          (4c)
        color-picker.js   custom HSV picker + eyedropper button,
                          recents row, palette grid (UI only)
        dev-log-view.js   DEV ONLY: the activity log dialog (Copy, Clear)
        settings-panel.js gear menu (dev section is temporary);
                          attachSettingsMenu for either screen
      timeline/
        frames.js         pure frame-order ops (insert/remove/move);
                          reference image across frames (3b)
        frame-strip.js    frame strip + frame menu, long-press drag to
                          reorder (4d) (UI only; intents via callbacks)
        clock.js          pure elapsed time → frame (beatAtTime,
                          frameAtBeat, frameAtTime); fps rules
                          (sanitizeFps, MIN/MAX/DEFAULT_FPS, presets)
        frame-cache.js    pure flattened-frame cache bookkeeping:
                          layerSignature, freshness, rebuild order (4a-ii)
        dev-stress.js     DEV ONLY: playback speed + frame memory tests
                          (4a-i)
        playback.js       pure playback loop: getting ready, decode ring,
                          skip late frames, fps/loop re-anchor (4b)
        transport.js      transport row + fps panel + "Getting ready"
                          label (UI only) (4b)
        onion.js          pure onion-skin rules: settings defaults and
                          clean-up, which frames are ghosts (4c)
      export/ audio/      placeholders for later steps
    icons/                app icon set
    tests/unit/, tests/e2e/      see Testing
    docs/DESIGN_NOTES.md  reasoning and lessons
    package.json, playwright.config.js   test tooling only

**Notable constants:** `MAX_BRUSH_SIZE` (60) and `DEFAULT_COLOR` are
exported from `canvas.js` as the single source of truth. Autosave
debounce 500 ms (drawing), 300 ms (settings). Gesture thresholds in
`gestures.js`: 150 ms / 8 px window; zoom 0.25–8× (fit = 1×); double-tap gap
350 ms; third finger joins within 200 ms; three-finger tap ≤ 350 ms /
20 px; swipe ≥ 60 px, mostly horizontal. Undo caps in `history.js`.

**Dev-only, remove before calling the app done:** the gear menu's
Developer section (Fresh reload, and from 2c a fill-all-layers
memory stress test; from 4a-i the Playback speed and Frame memory
tests — `timeline/dev-stress.js`, its import and launch call in
`main.js`, its `sw.js` entry and its `.pp-dev-report` CSS); after 4b,
the **Activity log** — `storage/dev-log.js`, `ui/dev-log-view.js`,
their `sw.js` entries, `tests/unit/dev-log.test.js`,
`tests/e2e/dev-log.spec.js`, the `devLog.add` calls, `guardContext`
and the `showNotice` wrapper in `main.js` (and the guard-context
assertions in `canvas-loss.spec.js`), `canvasApi.onDebug`, and the
`.pp-dev-log` CSS. It keeps 300 lines in localStorage
(`parapara-dev-log`).

## Schema

Version 2 (2c): layers live on the project, frames map layer id →
bitmap. Planned fields are marked. Extend additively.

    project = {
      id, name, createdAt, updatedAt,
      canvas: { width: 1920, height: 1080 },
      fps: 12,                                // 1–30, picked in the transport (4b); sanitizeFps on open
      loop: true,                             // 4b; missing = true
      onionSkin: { on, before, after, opacity, tintBefore, tintAfter },
                                              // 4c; missing = off, 1, 1, 0.4, red, green (sanitizeOnion)
      layers: [                               // index 0 = bottom; shared by all frames
        { id, name, visible: true, opacity: 1, locked: false },
      ],
      activeLayerId,
      frames: [frameId, ...],                 // timeline order
      currentFrameId,                         // the frame she was on
      palette: [ '#rrggbb', ... ],            // 2e, max 10; older projects: missing = []
      referenceHidden: false,                 // 3a, Hide images; missing = false
      symmetry: 'off' | 'vertical' | 'horizontal' | 'both',   // planned (after main build); missing = 'off'
      // no thumbnail field: its blob id is derived, thumb-<projectId>
      audioClips: [ { id, blobRef, trimStart, trimEnd, offset } ]
                                              // planned (step 5): one clip; seconds;
                                              // offset = where it starts, missing = 0
    }

    frame = {
      id, projectId,
      bitmapRefs: { [layerId]: bitmapRef },   // one per project layer
      image: { blobRef, x, y, scale, rotation, opacity, flipX, flipY } | null
                                              // 3a; flipX/flipY 3b, missing = false
      // frames can share one image blob (copy frame, 3b's "all frames")
    }

**IndexedDB stores** (`parapara`, version 2): `projects`, `frames`
(index `projectId`), `blobs` (index `projectId`; `{ id, projectId,
type, buffer }` — layer bitmaps and the gallery thumbnail
`thumb-<projectId>`), `meta` (`lastProjectId`, `toolSettings`,
`uiState` = `{ layersPanelOpen, screen: 'gallery' | 'editor' }`;
`recentColors` = `['#rrggbb', …]` newest first).
`bitmapRef` is assigned when a frame or layer is created and never
changes; no blob under it means blank. Adding a layer adds a ref to
every frame record. Undo is never stored.

**Version 2 migration** (`migrateToSharedLayers`, pure and
unit-tested): the first frame's layers become the project's, ids and
bitmapRefs kept, so no pixels move. Version 1 had `frame.layers[]` +
`frame.activeLayerId`.

## Testing

**Run tests before handing off any change; add tests for new logic.**

**Hand-off checklist, every step:** tests pass (stress-run any timing
spec) → this step's Architecture entry trimmed to the size rule at the
top (≈10 lines; UI specifics in code comments) → Current state says
what's built and what to check on the iPad, with no story of how it
got there.

- **Commands:** `npm install` once; `npm run test:unit` (seconds),
  `npm run test:e2e` (~3.2 min), or `npm test`.
- **In a Claude sandbox:** after `npm install`, run
  `bash tests/sandbox-setup.sh` once, then e2e with
  `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`. The preinstalled
  Chromium is newer than the pin and keeps its executables in
  different folders; the script links them where the pin looks.
  **On that build, a canvas's `toBlob` sometimes never calls back**
  (traced in step 5's session): the autosave waits forever, the strip
  stays disabled, and the test times out waiting for a save or a frame
  switch (5 s waits, before the app's 15 s encode timeout fires).
  That's ~13–23 tests a full run, more when the machine is busy, a
  different set each time — nothing to do with the app. So **a sandbox run is a pre-check; CI
  (pinned image) is the real check**: judge sandbox failures by
  whether they're this stall, and compare against a run without the
  change when in doubt.
- **Version pin:** `@playwright/test` is exactly `1.56.0`, matching
  the sandbox browser *and* CI's image
  `mcr.microsoft.com/playwright:v1.56.0-noble` in `deploy.yml`. Bump
  all three together.
- **Unit (`tests/unit/`):** Node's built-in runner + `fake-indexeddb`,
  importing real app modules — keep logic modules free of DOM access
  at import time. `sw-precache.test.js` enforces the `APP_SHELL` rule.
- **E2E (`tests/e2e/`):** real app in headless Chromium at 1080×810.
  `serve.js` serves the repo and simulates deploys
  (`/__test__/state?version=…&slowInstallMs=…`). **Two projects** in
  `playwright.config.js`: `app` (everything else, fully parallel, 2
  workers — `E2E_WORKERS` overrides; CI sets 4 in `deploy.yml` for
  GitHub's 4-core runner, drop it if CI starts flaking) then `updates` (serial, after
  `app`, because changing the deploy version reaches every open page;
  a failing `app` test skips it). New specs that touch
  `/__test__/state` go in `updates`. Mouse input for strokes; touch gestures
  go through CDP `Input.dispatchTouchEvent` (`undo.spec.js`) — pass
  explicit `timestamp`s when the page may be busy (e.g. mid-fill), or
  the gesture window expires before the second touch is sent.
- **Rules:**
  - **A wait must prove the thing happened**, not check something that
    may already be true (the bar's "Opacity 50%" before a Replace
    lands — this broke CI twice). For photo imports use
    `replaceImage` / wait for the old `.pp-reference__image` to go.
    Brief states (one frame at 6 fps) need a slow fps or fast polling.
  - **Any spec involving timing (playback, saves, photo imports) gets a
    stress run before pushing:** `E2E_WORKERS=6
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test
    <spec> --repeat-each=8`. CI runs slower than the sandbox, so races
    show up there first (two failed deploys after 4c). For playback
    timing, try Playwright's clock control (`page.clock`) to step time
    exactly, rather than slowing fps down.
  - **No fixed sleeps** — wait for the event (`helpers.js`:
    `waitForDrawingSave`, `waitForToolSettings`, `expect.poll`). Only
    exception: proving something *doesn't* happen.
  - **Check a new test fails without its fix**, or note that it
    doesn't.
  - `openApp` (helpers) starts from the empty gallery on a fresh
    install and taps New animation; specs that need the gallery go
    through the Gallery button.
  - Each test gets its own browser context (own IndexedDB), so tests
    must not depend on order or on each other. ~3.2 min after the
    lost-canvas guard.
  - **Find the gear button with `exact: true`** (`name: 'Settings'`)
    — "Onion skin settings" matches a loose lookup too.
  - **The robot test** (`hunt.spec.js`): seeded random use with a
    model; checks every mark on screen and after a reload. Since 4d it
    also deletes and drags frames and copies/pastes drawings; after a
    drag it reads the order back from the strip (auto-scroll can move
    the drop). CI runs 3
    seeds × 40 steps; locally `HUNT_SEEDS=16 HUNT_STEPS=80`, or
    `HUNT_SEED=<n>` to rerun a failure (the log is attached).
    `canvas-loss.spec.js` simulates the lost canvas (cleared, or
    ignoring `drawImage`).
  - **Layer actions in e2e** go through the layer menu: `helpers.js`
    `layerMenu(page, item)` / `openLayerMenu` / `layerMenuItem`; wait
    for the panel to settle with `layersSettled` (the opacity slider is
    off while busy).
  - **Images in e2e:** make the test image in the page (a canvas →
    PNG buffer) and feed it through `page.waitForEvent('filechooser')`
    so the real picker path runs (`reference.spec.js`).
- **CI:** test → build → deploy; a failing test stops the deploy.
  Failure reports are kept 7 days as a workflow artifact.
- **Published site = app files only.** The build job copies the repo
  *excluding* dev files. **Add any new dev-only top-level file or
  folder to that exclude list** in `deploy.yml`.
- **Device-only (say so at handoff):** iOS storage eviction, stylus
  feel, iPadOS gesture conflicts, Safari-only rendering, iOS
  suspend/relaunch behavior, gallery touch scrolling, canvas memory
  release between projects, the iPadOS 26 top-edge blur (desktop
  Chromium never draws it), long-press feel, the photo picker (Photos
  vs Files, HEIC arriving as JPEG), memory with large imported photos,
  adjusting and flipping an image by finger and stylus, playback
  smoothness at 24–30 fps with real line art, the stop tap with her
  stylus, the moment of frame loading after a stop, how the onion
  ghosts read over her real line art, and how soon they appear after
  a frame switch, whether iPadOS's real lost canvas behaves like
  the simulations in `canvas-loss.spec.js`, and (4d) the long-press
  feel, the strip letting go of its scroll once a tile lifts, and no
  callout on a held tile.
