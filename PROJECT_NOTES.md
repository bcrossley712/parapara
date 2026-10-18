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
  inputs are fine.
- **He's comfortable with vanilla JS**, knows Vue but chose not to use
  it here. Skip deep terminal hand-holding; don't assume tooling
  fluency beyond that.

## Current state

- **Step 1 (drawing engine): done**, on the iPad. Draw / erase / fill /
  smudge, color picker, per-tool sizes, two-finger pan/zoom/rotate.
- **Step 2a (saving): done and confirmed on the iPad.** One project,
  one frame, one layer; autosaves and survives relaunch. Also
  remembered tool settings, and the gear menu (version, Check for
  updates, dev tools).
- **Step 2b (undo/redo): done and confirmed on the iPad.** Undo/redo
  buttons in a dark top bar; Sketchbook gestures (three-finger tap /
  swipe, two-finger double-tap reset), with iPadOS's own undo kept out
  of the way; Clear and fill undoable; fill is a gesture candidate;
  zoom out to 0.25× (was capped at fit). She mostly uses the buttons.
- **Next: 2c** — layers panel (add/delete/reorder/visibility/opacity/
  lock, per-frame cap) **plus the bare-bones frame strip** (add frame,
  tap to switch), so multi-frame saving and cross-frame undo get tested
  there. Then 2d project gallery (list/create/open/delete, custom
  confirm).
- **2c scoping — settle before building:**
  - Layer cap number, and where the layers panel and frame strip sit
    (wireframe: strip below the canvas, under the transport).
  - **Coupled standard features to flag:** duplicate layer, merge
    down, rename, layer thumbnails — standard in Sketchbook/Procreate,
    not in the v1 list. Decide in or deferred, deliberately.
  - **Remembered across launches:** active layer per frame
    (`activeLayerId` already in the schema) and which frame was open.
  - **Wiring already prepared:** history entries carry `frameId` /
    `layerId` and a `type` (add layer-structure types next to
    `'pixels'`); `main.js` `swapEntry` must switch to the entry's frame
    first and write to the entry's layer, which may not be active; the
    committed copy resyncs on any layer or frame switch.
  - **Memory:** each layer is its own ~8 MB surface; the cap protects
    the iPad. Consider whether non-current frames keep surfaces or
    reload from storage.
- **Build order after step 2:** 3 image import + per-frame image
  transform · 4 playback, onion skin, full frame strip (reorder,
  delete, thumbnails) · 5 audio record/import + single-clip trim ·
  6 export + native share sheet · 7 Cloudflare Worker + R2 (share
  links, Krita reference import).

**Open items**
- **Smudge feel** is off; deferred until more brushes exist (she ties
  it to brushes that soften their own edges). Don't retune it alone.
  ([why](docs/DESIGN_NOTES.md#drawing-engine))
- **Brush variety** (sizes, chisel tips, edge blending) — after step 2.
- **Color picker has no presets/recents, eyedropper or opacity** — on
  purpose; revisit if she asks.
- **Export format** (container/codec) — decide at step 6.
- **How-to / tutorials** reachable from the settings (gear) menu —
  later, once there's enough to explain (gestures, layers, frames).

**Planned UI layout** (from wireframes): tool rail down the left;
transport (skip / play / skip + fps) between canvas and timeline;
horizontally scrolling frame strip with a dashed "add frame" tile and
a marker on frames with an imported image; onion-skin toggle as a
badge on the canvas; Share as a first-class top-bar icon.

## Architecture

Short rules; reasoning in the linked sections.

- **Stack:** vanilla JS, native ES modules, no framework, no bundler.
  Nothing from npm ships; npm is test tooling only. CI tests, copies
  app files, and stamps the service-worker version — never compiles.
  ([why](docs/DESIGN_NOTES.md#stack))
- **Input:** Pointer Events only. Pressure/tilt deliberately unread, so
  Apple Pencil support is additive. **One deliberate exception:** a
  non-passive `touchstart`/`touchmove` listener on the canvas area that
  only calls `preventDefault()` with 3+ touches down, to keep iPadOS's
  own three-finger undo out of the way. No recognition logic in it.
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
- **Layers** ([why](docs/DESIGN_NOTES.md#layers-and-undo)): multiple
  per frame. v1 = add/delete, reorder, visibility, opacity, lock; no
  blend modes/groups/masks. New frames copy the previous frame's layer
  structure with blank bitmaps. The reference image is separate from
  layers. Per-frame layer cap (number TBD in 2c).
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
  - Layer structure changes are undoable on the same stack (2c: new
    entry `type` alongside `'pixels'`).
  - `history.js` is pure; `canvas.js` exposes `onChange({rect,
    before})`, `swapRegion`, `isBusy`, `onGesture`; `main.js` glues.
- **Gestures — match Sketchbook defaults**
  ([why](docs/DESIGN_NOTES.md#gestures)): three-finger tap = undo;
  three-finger swipe left/right = undo/redo; two-finger double-tap =
  reset view; two-finger single tap does nothing; two-finger drag/pinch/twist =
  pan/zoom/rotate; visible undo/redo buttons too. Later, with a brush
  library: three-finger swipe up = color, down = brushes.
- **Tool settings** (tool, color, per-tool sizes) are remembered
  app-wide, not per project. The view (pan/zoom/rotation) resets on
  launch.
- **Projects:** a gallery, one project open at a time.
- **Defaults:** canvas 1920×1080 landscape, 12 fps — both stored per
  project, not hardcoded.
- **Updates:** a new version waits for the user (toast or gear menu),
  never swaps silently. Every reload the app causes flushes unsaved
  work first. ([why](docs/DESIGN_NOTES.md#pwa-layout-and-updates))
- **Planned** ([details](docs/DESIGN_NOTES.md#planned-features)):
  reference image stored once, per-frame transform; one audio clip as
  `audioClips: []`, non-destructive trim; export to video + Web Share,
  then share links and Krita import via Worker + R2; storage warning at
  ~80% quota.

## Don't break these

Each is here because breaking it caused (or would cause) a real bug.

**Canvas** ([why](docs/DESIGN_NOTES.md#gestures))
- Canvas `transform-origin` is `0 0`, set in JS where the canvas is
  created — the gesture math depends on it.
- `toCanvasPoint` is computed analytically from viewport state, never
  from `getBoundingClientRect()` (wrong once rotated). Every tool
  routes through it.
- Rotation accumulates frame to frame (`shortestAngleDelta`), never
  diffed against the start angle.
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
- If loading saved work fails, saving stays off.
- Tool-settings validation lives in `canvas.js`
  (`sanitizeToolSettings`); bad fields fall back individually.

**Layout, PWA, updates** ([why](docs/DESIGN_NOTES.md#pwa-layout-and-updates))
- App shell is `position: fixed; inset: 0` — never `vh`/`dvh` units
  for full-screen layout without testing on the iPad.
- Safe-area padding needs `viewport-fit=cover`,
  `black-translucent`, and global `box-sizing: border-box` — keep all
  three.
- **Anything at the top edge stays dark** (the top bar paints under the
  status bar, whose text is white).
- Text inputs ≥ 16px font.
- Layouts must tolerate wider text than desktop Chromium shows — no
  `nowrap` on content that could grow.
- The canvas re-measures via `ResizeObserver` on the canvas area, not
  window resize.
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
      main.js             entry + glue: storage ↔ canvas ↔ ui, autosave,
                          updater ↔ toast/gear; screen routing (2d)
      updater.js          SW registration, update checks/apply, version,
                          fresh reload — no UI
      canvas/
        canvas.js         input dispatch, tools, viewport, committed copy;
                          API seams: onChange / exportPNG / setImage
                          (persistence), getSettings / applySettings,
                          swapRegion / isBusy / onGesture (undo)
        brush.js          brush-tip seam: stamp(ctx, point, size)
        gestures.js       pure pan/zoom/rotate math + tap/swipe classifiers
        region.js         pure dirty-rect helpers
      storage/
        storage.js        IndexedDB wrapper + schema factories
        autosave.js       save timing only (debounce, no overlap, flush)
        history.js        undo/redo stack, caps, byte budget (in memory)
      ui/
        ui.js             top bar (undo/redo), tool rail, toasts, DOM glue
        color-picker.js   custom HSV picker
        settings-panel.js gear menu (dev section is temporary)
      timeline/ export/ audio/   placeholders for later steps
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
Developer section (Fresh reload, Clear drawing).

## Schema

Built in 2a: `project`, `frame`, layer records. Planned fields are
marked. Extend additively.

    project = {
      id, name, createdAt, updatedAt,
      canvas: { width: 1920, height: 1080 },
      fps: 12,
      frames: [frameId, ...],                 // timeline order
      audioClips: [ { id, blobRef, trimStart, trimEnd } ]   // planned (step 5)
    }

    frame = {
      id, projectId,
      layers: [                               // index 0 = bottom
        { id, name, bitmapRef, visible: true, opacity: 1, locked: false },
      ],
      activeLayerId,
      image: { blobRef, x, y, scale, rotation, opacity } | null   // planned (step 3)
    }

**IndexedDB stores** (`parapara`, version 1): `projects`, `frames`
(index `projectId`), `blobs` (index `projectId`; `{ id, projectId,
type, buffer }`), `meta` (`lastProjectId`, `toolSettings`).
`bitmapRef` is assigned at layer creation and never changes; no blob
under it means blank. Undo is never stored.

## Testing

**Run tests before handing off any change; add tests for new logic.**

- **Commands:** `npm install` once; `npm run test:unit` (seconds),
  `npm run test:e2e` (~30 s), or `npm test`.
- **In a Claude sandbox:** Chromium is preinstalled — run
  `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e`.
- **Version pin:** `@playwright/test` is exactly `1.56.0`, matching
  the sandbox browser *and* CI's image
  `mcr.microsoft.com/playwright:v1.56.0-noble` in `deploy.yml`. Bump
  all three together.
- **Unit (`tests/unit/`):** Node's built-in runner + `fake-indexeddb`,
  importing real app modules — keep logic modules free of DOM access
  at import time. `sw-precache.test.js` enforces the `APP_SHELL` rule.
- **E2E (`tests/e2e/`):** real app in headless Chromium at 1080×810.
  `serve.js` serves the repo and simulates deploys
  (`/__test__/state?version=…&slowInstallMs=…`); because of that
  shared state, `workers: 1`. Mouse input for strokes; touch gestures
  go through CDP `Input.dispatchTouchEvent` (`undo.spec.js`) — pass
  explicit `timestamp`s when the page may be busy (e.g. mid-fill), or
  the gesture window expires before the second touch is sent.
- **Rules:**
  - **No fixed sleeps** — wait for the event (`helpers.js`:
    `waitForDrawingSave`, `waitForToolSettings`, `expect.poll`). Only
    exception: proving something *doesn't* happen.
  - **Check a new test fails without its fix**, or note that it
    doesn't.
  - **When e2e passes ~2 minutes,** parallelize — first isolating the
    update tests into their own serial group.
- **CI:** test → build → deploy; a failing test stops the deploy.
  Failure reports are kept 7 days as a workflow artifact.
- **Published site = app files only.** The build job copies the repo
  *excluding* dev files. **Add any new dev-only top-level file or
  folder to that exclude list** in `deploy.yml`.
- **Device-only (say so at handoff):** iOS storage eviction, stylus
  feel, iPadOS gesture conflicts, Safari-only rendering, iOS
  suspend/relaunch behavior.
