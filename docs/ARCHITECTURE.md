# Architecture — Parapara!

How each area works and the rules that keep it from breaking.
**Before editing a file, read its area's section** (the file → area
index is in [PROJECT_NOTES.md](../PROJECT_NOTES.md#areas)); rules that
apply everywhere are in PROJECT_NOTES.md → Global rules. The *why*
behind decisions is in [DESIGN_NOTES.md](DESIGN_NOTES.md).

Each section: **Files**, **How it works** (rules, data shapes and her
decisions — UI specifics belong in code comments), **Don't break**
(each rule is here because breaking it caused, or would cause, a real
bug), and where useful **Testing** tips and **iPad-only checks**.

Sections: [Canvas and drawing](#canvas-and-drawing) · [Layers, undo and copying](#layers-undo-and-copying) · [Saving and storage](#saving-and-storage) · [Frames, playback and onion skin](#frames-playback-and-onion-skin) · [Reference image](#reference-image) · [Sound](#sound) · [Colors and tool settings](#colors-and-tool-settings) · [Editor UI, menus and screens](#editor-ui-menus-and-screens) · [PWA, layout and updates](#pwa-layout-and-updates)

---

## Canvas and drawing

**Files:** `js/canvas/canvas.js` (input dispatch, tools, viewport, layer
surfaces, committed copy — its returned API is the only way other
modules touch the canvas), `brush.js` (brush-tip seam:
`stamp(ctx, point, size)`), `gestures.js` (pure pan/zoom/rotate math,
tap/swipe classifiers), `region.js` (dirty rects, `inkBounds`),
`ink-map.js` (lost-canvas rule).

**Constants:** `MAX_BRUSH_SIZE` (60) and `DEFAULT_COLOR` are exported
from `canvas.js` as the single source of truth. Gesture thresholds in
`gestures.js`: 150 ms / 8 px window; zoom 0.25–8× (fit = 1×);
double-tap gap 350 ms; third finger joins within 200 ms; three-finger
tap ≤ 350 ms / 20 px; swipe ≥ 60 px, mostly horizontal.

### How it works

- **Gestures — match Sketchbook defaults**
  ([why](DESIGN_NOTES.md#gestures)): three-finger tap = undo;
  three-finger swipe left/right = undo/redo; two-finger double-tap =
  reset view; two-finger single tap does nothing; two-finger drag/pinch/twist =
  pan/zoom/rotate; visible undo/redo buttons too. Later, with a brush
  library: three-finger swipe up = color, down = brushes.
- **Lost canvases (after 4c)** ([why](DESIGN_NOTES.md#lost-canvases))
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

### Don't break

- The wrapper's (`.pp-canvas`) `transform-origin` is `0 0`, set in JS
  where it's created — the gesture math depends on it. The transform
  goes on the wrapper, never on a layer canvas.
- Layer canvases are `pointer-events: none`; pointer listeners and
  capture belong to the canvas area (`.pp-canvas-area`), never the
  page or a layer — fingers off the page must still count.
- **`canvasApi.getLayerImage` is read-only** — drawing into it skips
  undo and saving.
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
- Fill's region comes from the visible-layer composite, its pixels go
  to the active layer only — never write the composite back.
- `toCanvasPoint` is computed analytically from viewport state, never
  from `getBoundingClientRect()` (wrong once rotated). Every tool
  routes through it.
- Rotation accumulates frame to frame (`shortestAngleDelta`), never
  diffed against the start angle.
- **A layer's context keeps the last stroke's blending mode** — erase
  leaves `destination-out` set. Anything that draws onto a layer
  outside a stroke (paste, 4d; loads through `drawInto`) sets
  `source-over` and alpha 1 itself inside `save()`/`restore()`, or it
  erases instead (the robot test caught both — a load right after an
  erase showed blank, and a tiny drawing could then be saved over).
- Fill applies immediately but is a gesture candidate like draw/erase:
  a second finger in the window reverts it from the committed copy. It
  commits on pointerup.
- Every paint operation marks the dirty rect (`stamp()`, smudge step,
  fill bounds) — a mark outside it won't be undoable or revertible.
- Anything that replaces layer pixels outside a stroke (`setImage`,
  `swapRegion`, `clear`) must also update the committed copy.
- No `willReadFrequently: true` on the main canvas context.
- The canvas re-measures via `ResizeObserver` on the canvas area, not
  window resize.

### iPad-only checks

Stylus feel, iPadOS gesture conflicts, whether iPadOS's real lost canvas behaves like the simulations in `canvas-loss.spec.js`.

---

## Layers, undo and copying

**Files:** `js/storage/layers.js` (pure layer-list and bitmap-slot ops,
`MAX_LAYERS`, `mapBlobRefs` / `referencedBlobIds`, copy record
builders), `storage/history.js` (undo/redo stack, caps, byte budget —
in memory), `ui/layers-panel.js` (layers panel + layer menu, UI only),
and the glue in `main.js`.

### How it works

- **Layers** ([why](DESIGN_NOTES.md#layers-and-undo)):
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
  - **Layer menu (4d)** ([why](DESIGN_NOTES.md#after-the-main-build-requested-deferred)):
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
- **Undo/redo** ([why](DESIGN_NOTES.md#layers-and-undo)):
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

### Testing

- **Layer actions in e2e** go through the layer menu: `helpers.js`
  `layerMenu(page, item)` / `openLayerMenu` / `layerMenuItem`; wait
  for the panel to settle with `layersSettled` (the opacity slider is
  off while busy).

---

## Saving and storage

**Files:** `js/storage/storage.js` (IndexedDB wrapper + schema factories),
`storage/autosave.js` (save timing only: debounce 500 ms drawing /
300 ms settings, no overlap, flush), `storage/dev-log.js` (DEV ONLY).
The schema itself is in [PROJECT_NOTES.md → Schema](../PROJECT_NOTES.md#schema).

### How it works

- **Storage:** IndexedDB, fully client-side. Layer bitmaps as PNG.
  Autosave after a stroke ends, never mid-stroke. Requests
  `navigator.storage.persist()`. ([why](DESIGN_NOTES.md#storage))

### Don't break

- **Autosave exports every unsaved layer in the same tick and saves
  each to the ref of the frame it was exported from** (`session.frame`
  captured before any await). Reading the ref after awaiting the
  encode could put one frame's pixels under another frame's ref.
- **`exportPNG` gives up after `EXPORT_TIMEOUT_MS` (15 s)** with a
  `TimeoutError` (step 5). Every save and frame switch waits on it, so
  a `toBlob` that never calls back would otherwise lock the editor
  with no message. Autosave shows its own notice for it (not "out of
  space"); the layer stays unsaved and the next edit retries.
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
  that if thumbnail ids change. Sound files and photos count in it; skip
  them too if a sound/photo test ever uses it.

### iPad-only checks

IOS storage eviction, suspend/relaunch behavior.

---

## Frames, playback and onion skin

**Files:** `js/timeline/frames.js` (pure frame-order ops; reference image
across frames), `frame-strip.js` (strip + frame menu, long-press drag;
`timeline` geometry for the sound panel), `clock.js` (elapsed time →
frame; fps rules), `frame-cache.js` (cache bookkeeping),
`playback.js` (pure playback loop), `transport.js` (transport, fps
panel, "Getting ready"), `onion.js` (onion rules), `dev-stress.js`
(DEV ONLY); `js/canvas/render-frame.js` (`renderFrame`, the one
"frame, flattened" rule), `frame-tiles.js`, `playback-frames.js`,
`onion-view.js`, `thumbnail.js` (gallery thumbnail);
`ui/onion-badge.js`.

### How it works

- **Frame cache and playback (4a)**
  ([why](DESIGN_NOTES.md#playback-and-the-frame-cache)):
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
- **Playback (4b)** ([why](DESIGN_NOTES.md#playback-and-the-frame-cache)):
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
- **Onion skin (4c)** ([why](DESIGN_NOTES.md#onion-skin)):
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

### Don't break

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

### iPad-only checks

Playback smoothness at 24–30 fps with real line art, the stop tap with her stylus, the moment of frame loading after a stop, how onion ghosts read over her line art and how soon they appear after a frame switch, the long-press feel on tiles, the strip letting go of its scroll once a tile lifts, no callout on a held tile.

---

## Reference image

**Files:** `js/canvas/reference.js` (on-screen view, `drawReference`,
`prepareImport`), `canvas/transform.js` (pure placement math),
`ui/image-menu.js` (top-bar Image button + menu),
`ui/reference-bar.js` (adjust bar).

### How it works

- **Reference image (3a)** ([why](DESIGN_NOTES.md#reference-image)):
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
    (a failed load turns saving off — see Don't break, below).
  - Import: fit, centered, 50% opacity; long side ≤ the canvas's;
    JPEG 0.7 unless pixels are actually transparent (then PNG). Space
    wins over sharpness — her iPad runs near full.
  - Everything that shows "the frame" includes it via one path:
    `readVisible`, the thumbnail, and later export; Hide images drops
    it from all of them. **Onion-skin ghosts never include it** (4c;
    a ghosted photo is busy).

### Don't break

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

### Testing

- **Images in e2e:** make the test image in the page (a canvas →
  PNG buffer) and feed it through `page.waitForEvent('filechooser')`
  so the real picker path runs (`reference.spec.js`).

### iPad-only checks

The photo picker (Photos vs Files, HEIC arriving as JPEG), memory with large photos, adjusting and flipping an image by finger and stylus.

---

## Sound

**Files:** `js/audio/clip.js` (pure clip rules, import caps, move/trim/slip,
the recorded clip), `audio/peaks.js` (waveform peaks), `audio/audio.js`
(AudioContext, decode, the audio clock, the audio session),
`audio/recorder.js` (the mic and MediaRecorder, `micSettings`, 5c),
`ui/sound-panel.js` (Sound button + panel, UI only), `ui/countdown.js`
(the countdown before recording); the hold and the take in `main.js`.

### How it works

- **Sound (5a, 5b, 5c)** ([why](DESIGN_NOTES.md#planned-features)):
  - **Two rows: one Music clip and one Voice clip** in
    `project.audioClips`, each with `kind` (`'music'` | `'voice'`;
    missing = `'music'`, as 5a/5b saved it), Music first. Rules pure in
    `audio/clip.js` (`clipOfKind`, `withClip`); bad records dropped on
    open, never a failed open. `trimStart`/`trimEnd` pick the part of
    the file, `offset` where it starts in the animation — all seconds.
    Import fills Music and recording fills Voice; neither touches the
    other. More rows only if she asks.
  - **A file is stored exactly as picked or recorded, never
    re-encoded** (`saveAudioBlob`: ArrayBuffer + its MIME type, before
    the project points at it), and kept only if it decodes here — so
    playback and step 6's export can always read it. Imports over
    **20 MB** refused before reading; longer than **3 min**, only the
    first 3 min are decoded and used (banner). Only the current clips'
    decoded sound is in memory.
  - **The audio clock** (`audio/audio.js`) drives playback when
    there's sound: playback hands it each run's start (frame time,
    fps, frame count, loop, and `skip` — kinds left out) and stops it;
    its time is the AudioContext's minus the output delay, so frames
    follow what she hears. It schedules each clip on that clock — this
    pass at once, each loop pass ~1 s ahead — so loops are seamless and
    never drift. **The animation's length wins:** only the part inside
    frames ÷ fps plays. Nothing to play, or a context that doesn't
    start within 1 s: the wall clock, silently.
  - **Plays in Silent mode:** the audio session (Safari's
    `navigator.audioSession`) is `'playback'` before the context
    starts — iOS otherwise mutes web sound in Silent mode (seen on her
    iPad) — and `'play-and-record'` while the mic records. The Play tap
    resumes the context even while the sound is still loading
    (`unlock({ expectSound })`). Whether each run's sound started goes
    to the activity log (`onEvent`).
  - **Sound button** (top bar, before Image; a dot when there's
    sound) toggles the **sound panel** over the canvas area's bottom,
    above the tiles — covers, never shrinks; not remembered across
    launches. Import while playing only stops (picker inside the tap).
    Import/Replace, a recording, each row's Delete and each trim/move
    drag are one `'audio'` undo entry (`{ before, after }` clip lists);
    files stay in storage for undo and the sweep.
  - **Panel:** each row has its controls on the left (over the
    transport) and a track at the tiles' scale (one frame = a tile +
    its gap, `strip.timeline`), scrolling with them. Rows are 48 px; an
    **empty row stays slim** (40 px, a line saying what fills it), so
    the panel is ~100–145 px. Its height is copied to the canvas area's
    `--pp-sound-panel-height`, so the onion badge and "Getting ready"
    sit above it; the layers panel ends above it. Drag a clip to move it
    — left past frame 1 grows `trimStart` (offset stays ≥ 0); handles
    trim; an end pulled back to the animation's end plays to the file's
    end. Above the Music row, an **overview of the whole file** (not in
    Flipaclip — she can't reach a song's middle at tile scale): drag or
    tap it to pick which part plays (`slipClip`). No snapping; min
    length one frame. A touch on a track or the overview while playing
    only stops. Peaks are worked out when the panel first shows a clip.
  - **Recording (5c)** — hold the mic (Voice row, red):
    - **Before the hold:** fewer than two frames → a banner. Replacing a
      Voice not recorded since the panel opened asks first (custom
      confirm; retakes don't). With Music, the headphones tip shows once
      per panel opening unless she chose "Don't show again"
      (`uiState.hideHeadphonesTip`). Each popup stands in for the hold;
      she holds again.
    - **The hold:** a **3-second countdown** (`COUNTDOWN_SECONDS`) over
      the canvas, silent, while the mic opens (`recorder.open`, echo
      cancellation off). Letting go during it, or any other touch,
      records nothing ("Keep holding…"). Then the recorder starts, and
      once it says so, playback runs from her frame (the last frame →
      frame 1) **without looping, Music playing, the old Voice
      silent** (`skip: ['voice']`). A red bar grows on the Voice row.
    - **Ends** on letting go, at the last frame, after 3 minutes, on any
      other touch (canvas, transport, a track, a button), or when the app
      is hidden — **the take is kept** in each case. She lands on the
      frame showing, as after playback; actions tapped meanwhile wait for
      the take to be saved (they wait on `landing`).
    - **The take → Voice:** `recordedClip` — `offset` = the start
      frame's time; `trimStart` = the lead-in (the recorder's start to
      the first frame shown, both on `performance.now()`) +
      `MIC_DELAY_SECONDS`; shorter than a frame → not kept (banner).
      The mic closes after every take.
    - **Leveling:** with echo cancellation off, iOS doesn't boost the
      mic, and her first takes were very quiet. Automatic gain is asked
      for (Safari may ignore it; `rec-start` logs what it applied), and
      each take gets a **`gain`** stored on the clip — missing = 1. 5c's
      takes: `takeGain` (loudest point to 0.7). **After 5c, by
      loudness** (`loudnessGain`; her test with headphones: still far
      under the music): the speech's RMS, pauses left out
      (`speechLoudness`), lifted to `TAKE_TARGET_LOUDNESS`, at most 8×,
      never below 1, its loudest instant at most `MAX_LEVELED_PEAK`;
      marked `leveling: 'loudness'`, which plays through a compressor
      (`TAKE_COMPRESSOR`). Older takes keep theirs. The waveform is drawn
      with gain × volume. The file is never changed. `recorded` logs
      `peak`, `loudness` and `gain`.
    - **Record mode may pause the sound:** as a take starts the engine
      is asked to run again (`audio.wake()`); `rec-start` logs its
      state, and the take's music logs `sound-start` / `sound-silent`.
    - **First hold:** iOS's mic prompt takes the touch; once she allows
      it, a banner says to hold again. Refused → a notice pointing to
      Settings.
    - **Mic delay:** measured with the dev "Mic delay test" (gear →
      Developer: three clicks on the speaker, 0.4 s apart, each found in
      the recording as a jump above the room's noise and compared with
      when it was heard) and set once in `MIC_DELAY_SECONDS`: -22 ms on
      her iPad (2026-10-25).

  - **The mixer (after 5c, her request):** each row's label is its
    volume button ("MUSIC 100%"), opening a slider — **Music 0–100%,
    Voice 0–200%**, 5% steps — saved as the clip's `volume` (missing =
    1; `withVolume`, `clipVolume`). It works while sound plays and never
    stops playback (she mixes by ear): `audio.setVolume` moves the row's
    bus live, release is one `'audio'` undo step (`commitVolume`). A
    menu (`isMenuOpen`): a tap outside closes it, a canvas tap only
    closes it. **The mix** (`buildMix` in `audio.js`): source → take
    leveling → compressor (loudness-leveled takes) → row bus (volume) →
    a limiter (`LIMITER`) → speaker; the limiter keeps a boost from
    distorting. Settings are first tries, to tune by ear.
  - **Listen / Set start (after 5c, her request):** beside the
    overview; the song alone (`audio.listen`), from the part's start,
    no animation. **Listen** leaves the start alone (a line runs across
    the overview); **Set start** moves the part with the song
    (`slipClip` to `audio.listenPosition()`), and wherever it stops —
    Stop, a tap away, the song's end, hiding the app or closing the
    panel — is the new start, one undo step (`finishListen`). No
    reaction-delay allowance (her choice; revisit if she corrects
    every time). Either button reads Stop while playing; **any tap
    outside the two buttons and the volume controls stops it**, a
    canvas tap only stops it (`isListening` in `anyMenuOpen`). While
    the animation plays, the buttons only stop it (like Import).
    Scrubbing (sound while dragging) was offered and not chosen.
  - **Moving the song under a Voice asks first** (after 5c): the take
    was recorded against the song's timing. Dragging the overview, Set
    start, or moving the Music clip (not trimming — that keeps the rest
    in place) asks "Move the song?" once per panel opening
    (`canRetimeMusic`); the asking touch does nothing, she does it again
    (like the mic's popups). A new take resets it.

### Don't break

- **Step 6's export mixes through `buildMix`** on an
  OfflineAudioContext — leveling, compressor, volumes and limiter —
  or the file won't sound like playback.
- **Volume never stops playback**, and its commit is allowed while
  playing (`commitVolume` checks only busy) — unlike every other sound
  edit (`changeClip` refuses while playing).
- **The sound panel stops its own pointer events** (like the onion
  badge) — it's inside the canvas area, which would take a touch on it
  for a stroke or a playback stop. **Its waveform canvases are only as
  wide as the track**, redrawn on scroll — never one canvas the length
  of the song (iOS canvas limits and memory).
- **`audio.unlock()` stays synchronous in the Play tap and the mic
  press, before any await**, and is called even when the sound is still
  loading — a touch is the only chance iOS gives to start the context.
- **Any way playback stops ends a recording** — `endTake` hangs off
  playback's `'idle'` report, not off each stop path; the countdown
  (not playing yet) is ended by `interruptTake`, which `afterPlayback`,
  Play, the step buttons, a canvas tap and hiding the app call.
- **`exclusive()` drops a task while another runs** — a finished take
  must not be dropped, so it waits its turn (`exclusiveTask`).
- **Back to playback mode only after the mic has closed**
  (`setMicMode(false)` once the recorder's stop resolves) — switching
  earlier left the first loops after a take in record mode's quieter
  output on her iPad. Every switch is logged (`rec-session`).
- **The countdown overlay never takes touches** (`pointer-events:
  none`) — it would steal the held mic's pointer.

### Testing

- **Sound in e2e** (`sound.spec.js`): a WAV built in Node, fed
  through the file chooser; `AudioBufferSourceNode.start` wrapped to
  see what the audio clock schedules. Headless Chromium runs the
  AudioContext after the Play click. Blobs come back from
  `page.evaluate` as byte arrays (ArrayBuffers don't survive it).
  Panel drags (5b) grab the clip's *visible* part (the track clips
  it when scrolled) and start from frame 1 — a drag ending near the
  track's left end edge-scrolls and moves the clip further. Row
  locators are scoped (`.pp-sound-panel__row--music` / `--voice`).
- **Recording in e2e** (`recording.spec.js`): Chromium's fake mic
  (`--use-fake-device-for-media-stream`, allowed by
  `--use-fake-ui-for-media-stream`) records WebM/Opus. The countdown
  runs in real time (3 s a hold). A take lands where it stopped, so a
  retake goes back to frame 1 first or it may finish before the test
  looks. A second pointer while the mouse holds the mic is a CDP touch.

### iPad-only checks

(after 5c) the voice/music balance with headphones — loudness target,
compressor and limiter by ear, hiss on a boosted quiet take; Listen and
Set start starting from the tap (and with the screen's output delay,
where Set start lands vs. what she heard); the volume slider with her
stylus. Sound in sync by ear, Safari's output delay, which files the picker offers, Silent mode, sound starting on the first Play after opening, dragging the clip and handles with her stylus, the track scrolling smoothly with the tiles, memory/pause with a long song's waveform; (5c) mic permission in the installed app and the interrupted first hold, the countdown and hold with her finger/stylus (no callout or text selection), recording latency and the Mic delay test, echo with and without headphones, music volume and routing while the mic is on, AirPods' call-quality drop, the recorded file decoding.

---

## Colors and tool settings

**Files:** `js/ui/color-picker.js` (HSV picker, eyedropper button, recents,
palette — UI only), `storage/colors.js` (pure list rules,
`MAX_RECENTS`, `MAX_PALETTE`); tool-settings validation in
`canvas.js` (`sanitizeToolSettings`).

### How it works

- **Colors (2e)** — all in the color picker (UI in `color-picker.js`,
  list rules in `storage/colors.js`):
  - **Eyedropper** samples what she sees (`readVisible`, over white),
    is a one-shot mode, not one of `TOOLS`, never saved, and works on
    locked/hidden layers. A second finger makes it a gesture.
  - **Recent colors:** app-wide, 8, added when a draw or fill
    *commits* (not on picker moves or picks); `meta.recentColors`.
  - **Palette:** per project, 10, saved on the project record; edits
    aren't undoable (as in Procreate).
- **Tool settings** (tool, color, per-tool sizes) are remembered
  app-wide, not per project, and carry from one project into the next.
  Per project: the open frame and active layer. App-wide: whether the
  layers panel was open, which screen she was on, and the last
  project. The view (pan/zoom/rotation) resets on launch and on every
  open.

### Don't break

- Tool-settings validation lives in `canvas.js`
  (`sanitizeToolSettings`); bad fields fall back individually.

---

## Editor UI, menus and screens

**Files:** `js/ui/ui.js` (editor: top bar, tool rail, toasts/banners, menu
dismissal, destroy), `ui/gallery.js`, `ui/confirm-dialog.js`
(`showConfirm` / `showPrompt`), `ui/icons.js`,
`ui/settings-panel.js` (gear menu; its Developer section is
temporary), `ui/dev-log-view.js` (DEV ONLY); screen routing in
`main.js`.

### How it works

- **Menus vs the canvas** (after 5b, Procreate's way): a touch on the
  canvas while a menu or popover is open (color picker, Image, layer,
  frame, onion settings, fps, gear) only closes it — no stroke, fill or
  pick, and fingers joining it are ignored until all are up (the
  playback-stop swallow). **The layers panel counts too** (after 5c,
  her request — Procreate's popover): any tap outside it closes it
  (and its layer menu) — `ui.js`'s tap-outside listener, after the
  dismiss listener so a canvas tap is still swallowed; its Layers
  button toggles it; picking a layer keeps it open; it isn't
  reopened at launch (`uiState.layersPanelOpen` retired — an old saved
  value is ignored); closing it mid-rename keeps the typed name. The
  sound panel, which she works with open, doesn't count. Taps on other
  controls still act and close the menu.
- **Dialogs** (`confirm-dialog.js`): a tap on the dim area cancels,
  except with `dismissConfirms` (5c's headphones tip, where the second
  button — "Don't show again" — is the unusual choice).
- **Messages:** information that isn't a problem (locked/hidden
  layer, layer cap) is a fading banner that never blocks touches
  (`showBanner`); real problems (couldn't save) are a toast that waits
  for OK (`showNotice`).
- **Projects and screens** ([why](DESIGN_NOTES.md#gallery)):
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

### Don't break

- **The menu-dismiss listener in `ui.js` is registered before any
  menu is created** (document, capture): it must see the menu still
  open, and menus close themselves in their own capture listeners. It
  marks the touch with `canvasApi.dismissTouch(id)`, which the canvas's
  pointerdown consumes and clears every time — a leftover id would
  swallow the next mouse tap (a mouse's id never changes). A new menu
  needs an `isMenuOpen` getter added to `anyMenuOpen()`.
- **The Sound and Image buttons have separate class names**
  (`.pp-sound-btn…`, `.pp-image-btn…`; shared rules list both). Tests
  find the Image button by class — sharing one broke every reference
  test (5a).
- **Names she types wrap but clamp at two lines** (layer rows, gallery
  cards) and have a length cap (`MAX_LAYER_NAME` 40 in `layers.js`,
  `MAX_PROJECT_NAME` 60 in `storage.js`) that copies keep to too
  (`copyName`) — an unclamped name grew the row without limit.
- **Anything an editor screen hooks up outside its own elements**
  (document listeners, observers) must be undone by `destroy()` —
  `ui.js` and `gallery.js` route document listeners through an
  `AbortController`. `canvas.destroy()` shrinks every canvas to 0×0 so
  iOS frees that memory before the next project loads.
- Screen switches save `uiState` immediately, not debounced, so
  closing the app straight after still reopens the right screen.

### Testing

- **Find the gear button with `exact: true`** (`name: 'Settings'`)
  — "Onion skin settings" matches a loose lookup too.

### iPad-only checks

Gallery touch scrolling, canvas memory release between projects, a canvas tap closing a menu without drawing (with her stylus).

---

## PWA, layout and updates

**Files:** `index.html`, `manifest.json`, `style.css` (app shell), `sw.js`
(service worker; `VERSION` stamped by CI), `js/updater.js` (SW
registration, update checks/apply, version, fresh reload — no UI).

### How it works

- **Updates:** a new version waits for the user (toast or gear menu),
  never swaps silently. Every reload the app causes flushes unsaved
  work first. ([why](DESIGN_NOTES.md#pwa-layout-and-updates))

### Don't break

- `#app` is `position: fixed; inset: 0`; each screen's shell inside it
  is `position: absolute; inset: 0` — never `vh`/`dvh` units for
  full-screen layout without testing on the iPad.
- Safe-area padding needs `viewport-fit=cover`,
  `black-translucent`, and global `box-sizing: border-box` — keep all
  three.
- **Anything at the top edge stays dark**, including `theme-color`,
  the manifest's `theme_color`/`background_color`, and the `html, body`
  background — iPadOS restyles the status bar from them.
  ([why](DESIGN_NOTES.md#pwa-layout-and-updates))
- **`#app` is the one fixed box at the top edge, and it's never
  replaced** — screens inside it are absolute, not fixed, and swap
  with no empty moment (load the next screen's data first). No
  `backdrop-filter`, gradient or see-through bar at the top. Otherwise
  iPadOS 26 blurs the top of the app until relaunch.
  ([why](DESIGN_NOTES.md#pwa-layout-and-updates))
- First install must not reload the page (`clients.claim()` fires
  `controllerchange` then too).

### iPad-only checks

The iPadOS 26 top-edge blur (desktop Chromium never draws it), Safari-only rendering.
