# Project Notes — Parapara!

**Required reading before any work.** Who this is for, how we work,
current state, global rules, schema and testing. Three files:

- **`PROJECT_NOTES.md`** (this file) — read in full, every
  conversation.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — how each area
  works and its don't-break rules. **Before editing a file, read its
  area's section** (index under [Areas](#areas)).
- **[`docs/DESIGN_NOTES.md`](docs/DESIGN_NOTES.md)** — the *why* and
  lessons learned; read the relevant section when a decision needs
  revisiting.

**Keeping these notes healthy:**
- Rules a conversation must follow live here or in ARCHITECTURE.md,
  as short rules with a one-line reason. Reasoning goes in
  DESIGN_NOTES.md. Play-by-play history goes in git commits, nowhere
  else. If files disagree, this one wins, then ARCHITECTURE.md.
- **This file stays around 600 lines.** Current state holds only
  what's in progress, what to check on the iPad, and what's next — a
  finished step collapses to one line. How a feature works goes in its
  ARCHITECTURE.md section (rules, data shapes and her decisions; UI
  specifics belong in code comments).

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
  - **Files to delete go first in the message, in bold** — a zip
    can't delete, and a missed one broke CI after 7b push 1.
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
  inputs are fine. **Two exceptions:** image import uses
  `<input type="file" accept="image/*">` and sound import (step 5) a
  file input too, because iPadOS offers no other way into Photos or
  Files. **The sound input's `accept` lists extensions
  (`SOUND_FILE_TYPES` in `ui.js`), never `audio/*`** — iOS treats
  `audio/*` like video and shows Photo Library / Take Video / Choose
  File (seen on her iPad); extensions should open Files directly.
  7a's Import (a project file) is a file input too, with **no
  `accept`** (iOS may grey out the unknown `.parapara`); the contents
  decide. On her iPad it shows Photo Library / Take Photo or Video /
  Choose File before Files — accepted (2026-11-01), leave it.
- **Third-party code — none, with one agreed exception:** gifenc
  (MIT), only if GIF export is ever built — copied into the repo at a
  pinned version, never loaded from a CDN ([plan](docs/DESIGN_NOTES.md#planned-features)
  → "GIF and PNG sequence"). Any other library needs the same
  discussion first.
- **He's comfortable with vanilla JS**, knows Vue but chose not to use
  it here. Skip deep terminal hand-holding; don't assume tooling
  fluency beyond that.

## Current state

- **Done and confirmed on the iPad:** steps 1–6 — drawing, saving,
  undo, layers, gallery, 2e's requests, reference image, frame cache,
  playback, onion skin, frame editing, menus closing on a canvas tap,
  sound (import, sound panel, hold-to-record over music, mixer,
  Listen/Set start) and export (MP4 with sound through the share
  sheet, Include images per project); **7a** project files (gallery ⋯
  → Save as file, top bar → Import); **7b** automatic backup to
  Cloudflare and restore (both verified 2026-11-02); **8a** stabilizer
  (as she expects, 2026-11-02); **8b-i** symmetry, stroke buffer and
  curved size (verified 2026-11-02). How each works is
  in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). She mostly undoes
  with the buttons, not gestures. She knows songs from streaming apps
  can't be imported (bought downloads can).

**Next** (his order, 2026-11-01: her requested extras before share
links):

1. **8b — symmetry + brush variety**, three pushes (scoped
   2026-11-02, [why](docs/DESIGN_NOTES.md#after-the-main-build-requested-deferred)),
   then flip drawing:
   - **8b-i — done**, with its QOL (layers panel stays open on frame
     taps, no long-press selection; verified 2026-11-02).
   - **8b-ii — built, not pushed** (checks below): brush panel (tap the selected Draw/Erase
     button; tips, size with the number shown, strength, Stabilizer
     moves here), with Pencil, Chalk/charcoal (canvas-fixed paper
     grain), Chisel (fixed angle), Paintbrush (soft and streaky, no
     wet mixing) and a Soft tip. **Erase can use any tip**, with its
     own strength (her "eraser that doesn't erase all the way").
     Decided 2026-11-02: today's hard round tip stays as **Pen**, the
     default, so nothing she has changes; size and strength are kept
     per tool *and* tip (Draw-Pencil ≠ Erase-Pencil); last tip per
     tool; Stabilizer stays per tool (Flipaclip has it per brush — a
     deliberate departure); strength applies per stroke (a stroke
     doesn't darken where it crosses itself, the next one does);
     the Draw/Erase buttons show the tip's name; no three-finger
     swipe for brushes; no panel for Smudge/Fill until 8b-iii.
   - **8b-iii:** smudge rebuilt for blending (she uses it to blend —
     any way that achieves it is fine) on the soft tip, with its own
     strength; stamps (a tap places one shape, a drag leaves a spaced
     trail; shapes drawn by us, e.g. a web, star, heart).
2. **Share links and Krita reference import** on the backup's
   Cloudflare backend — ask her first whether she still wants share
   links, now that video sharing works.
3. The rest of the requested extras under Open items.

Step 7's decisions (passkey with PRF instead of a recovery code,
encryption on the iPad, one invite per family, what's kept and for how
long, cost guards, the app staying at `bcrossley712.github.io`) are in
[design notes](docs/DESIGN_NOTES.md#planned-features) → "Backup (7b
scoping)"; how it works is in [ARCHITECTURE →
Backup](docs/ARCHITECTURE.md#backup).

**Open iPad checks** (send the activity log with any of them):
- **After 8b-ii, once pushed:** tapping Draw (or Erase) when it's
  already the tool opens the brush panel; a canvas tap closes it
  without drawing. Her old Pen size is unchanged. Each tip looks right
  to her — Pencil and Chalk's grain stays put on the paper; Chisel
  leans the other way across a symmetry axis; Paintbrush streaks; Soft
  fades. Erase at ~50% fades instead of clearing. Big (100+) Soft,
  Paintbrush and Chalk strokes keep up with her stylus. Tip, size and
  strength come back after closing the app. Expect a tuning round on
  default sizes and strengths.
- **Onion ghosts not showing (seen 2026-11-02, 8-layer project; cause
  unknown):** after the push, turn onion skin on in that project, step
  between a few frames (including one whose top layers are empty),
  and send the log. `onion-ghosts asked=/cached=` says whether the
  cache had pictures; `onion-draw` that they were drawn;
  `onion-failed step=` (decode, canvas, scratch, draw) or any `error`
  line says what broke. Drawn but unseen → a painted layer is covering
  them (ghosts sit under every layer; on frame 2 its top layer is
  ~600 KB of paint) — then ask her how her layers are arranged.
- **Whenever convenient:** a 48-frame export's time, with the editor
  fine after (no lost-canvas banner); a 1–3 fps video in Photos;
  sharing to Files; switching apps mid-export stops it with a
  message; from 5c:
  music while recording (`rec-start`, `rec-session`,
  `sound-start`/`sound-silent`), the first-hold mic prompt, dragging
  handles with her stylus, a 3-minute song's memory, whether the sound
  panel should reopen at launch (it doesn't).
- **When it happens:**
  - Play freezing after Bluetooth headphones connect: the drawings
    should keep moving with a "The sound stopped. Close Parapara!…"
    notice (confirmed for a background stall, 2026-10-31). Send
    `sound-stalled`, `sound-device-change`, `sound-state` and the
    `play` line.
  - Music during a take sounding ~½ s late: look for `out=5` in
    `rec-start` / `mic-delay` and rerun the Mic delay test
    (`MIC_DELAY_SECONDS` is -22 ms). iOS asking for the mic after each
    relaunch is its choice.
  - A lost-canvas banner (see Open items). The erase-then-switch fix
    should mean no "…loaded again" banner after erasing and tapping
    another frame.

**Ask her when there's a chance** ([why](docs/DESIGN_NOTES.md#reference-image)):
does she want to draw/erase on the photo itself (→ "Make into layer"),
and does starting a photo at 50% bother her when it's a background
(→ remember her last opacity, or a choice on import)?

**Watch the activity log** (gear → Developer → Activity log). Get it
if it shows:
- **lost canvas:** `load-renewed`, `load-broken`, `save-refused`,
  `check-failed`, `hold-refused`, `recover` (each line also gives
  `canvases=`, `play=`, `onion=`, `undo=`, `cache=`, `made=`);
- **saving:** `save-failed … timed out` (a layer encode that never
  finished; the save gives up after 15 s instead of locking the
  editor);
- **sound and export:** `sound-stalled`, `export-failed`,
  `export-audio-failed`, `share-failed`;
- **project files (7a):** `project-file-failed`,
  `project-import-failed`;
- **backup (7b):** `backup-failed` (with `error`, or `step` while
  turning on); `restore-failed` (with `step` and `error`).
- **onion skin and anything uncaught (after 8b-ii):** `onion-failed`,
  `error` (an error nothing else caught; at most 20 per launch).

**Open items**
- **Silent sound after the background — WebKit bug, worked around
  (confirmed 2026-10-31); watch.** If silence comes back, get the log;
  the fallback is an `<audio>` element playing the export's offline
  mix — a real project. Details: ARCHITECTURE → Sound.
- **GIF and PNG sequence export — cut from step 6 on purpose; revisit
  if she asks for either.** Start from the scoping in [design
  notes](docs/DESIGN_NOTES.md#planned-features) → "GIF and PNG
  sequence (6c, cut)".
- **Lost canvas — open bug, not recurring lately** (little use since
  the last fixes). She saw "This frame's drawing stopped showing…" now
  and then. Ask which ending she sees: "…loaded again" alone is the
  load check (the erase bug was one cause); "…from your last save" is
  the save check. One log (2026-10-25, before 5c): 16 s into a new
  one-layer project, just after closing another — `copy-renewed`, then
  0.8 s later `save-refused … had=1327 lost=976 canvases=1/4` →
  `recover`. Two canvases emptied within a second points at iOS memory
  pressure. Leads: undo's ~150 MB budget, what a closed project leaves
  behind, the frame cache's in-memory PNGs — `undo=`/`cache=`/`made=`
  show which grows. **Export (step 6) adds memory load — watch for it
  after.** Get logs and note what she did just before each.
- **Voice volume range** — he found the balance workable after 6b
  (lower Music to bring the voice forward); leveling left as is.
  Revisit only if she finds the voice hard to bring up: at 100% it
  sits near the ceiling (`MAX_LEVELED_PEAK`, take compressor, limiter),
  so 200% is mostly squashed — a fix changes how takes sound.
- **Listen** — tabled: should it play from the set start or the
  track's start, and does it need its own slider?
- **Parked from step 4, unless she asks:** frame holds (a drawing
  lasting several beats, Rough Animator — later an optional
  `frame.hold`, missing = 1, read only by `frameAtBeat`); showing the
  cached frame instantly on a frame switch, a scrubber, ping-pong loop,
  a play range, a clean fullscreen preview, a frame counter, zooming
  while playing.
- **Parked from step 5, unless she asks** (Flipaclip has them): more
  than two sound rows, slicing, looping past the end, a sound library,
  scrubbing sound while stepping frames, or while dragging the music
  bar (offered after 5c, not chosen: Set start covers it). Ask her:
  on Flipaclip's import screen, can she play the song while picking
  the part?
- **Onion skin default (40%)** — she's happy for now; if she keeps
  adjusting it, revisit the default.
- **Color picker layout** is a first try — adjust if she wants it
  different.
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
  - **Brush variety** — scoped into 8b (Current state → Next). A
    directional tip's mirrored stamp must mirror its angle too.
  - **Stabilizer — built in 8a.** Symmetry must mirror
    its output points, not the raw stylus.
  - **Erasers and bigger sizes** — in 8b: Erase uses any tip with a
    strength; sizes go to 1–200 on a curved slider (most of its length
    on small sizes), the norm in Procreate, rather than widening a
    linear slider.
- **Frame-cache encode timeout?** The cache flattens with `toBlob`
  (`encodePNG`); a `toBlob` that never calls back (seen on the sandbox
  build) would keep "Getting ready" up forever. Same fix as
  `exportPNG`'s if the log ever shows it; not done yet.
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
  asks. (8b's per-brush strength is a brush setting, as in Flipaclip's
  brush Opacity — the picker stays without it.)
- **Storage warning — dropped (6d scoping, 2026-10-29).** Without a
  project backup her only remedy is deleting drawings (a video can't be
  opened as a project again), and ~80% of Safari's quota likely never
  fires on her iPad — eviction follows the iPad's free space, not the
  app's quota. Instead each launch logs a `storage` line. **Her iPad
  (2026-10-31): ~34 MB used of a ~35 GB quota (0.1%), `persisted=yes`**
  — confirms the warning would never fire. **Revisit**
  after step 7's backup, or if the log shows usage climbing or
  `persisted=no`. ([why](docs/DESIGN_NOTES.md#planned-features))
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

## Architecture (core)

Applies to the whole app. How each area works is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — see [Areas](#areas).

- **Stack:** vanilla JS, native ES modules, no framework, no bundler.
  Nothing from npm ships (gifenc, if GIF export is ever built, is the
  one agreed exception — see Standing constraints); npm is test tooling
  only. CI tests, copies app files, and stamps the service-worker version — never compiles.
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
- **Defaults:** canvas 1920×1080 landscape, 12 fps — both stored per
  project, not hardcoded.
- **Backup (7b)** runs on a Cloudflare Worker + R2 (`worker/`,
  deployed by its own workflow, not part of the published site);
  restore (push 2) reads it back. **Planned**
  ([details](docs/DESIGN_NOTES.md#planned-features)): share links and
  Krita import on the same backend. The storage warning was dropped (Open items).

## Global rules

Rules any change can run into, whatever area it's in. Area-specific
rules are in each area's **Don't break** in `docs/ARCHITECTURE.md`.

- **The picker opens inside the tap:** `ui.pickImage()` and
  `ui.pickAudio()` (5a) must run synchronously from a click (Image
  menu item, Replace, Import sound). An `await` before it and iOS
  won't open the picker. Likewise **`audio.unlock()` runs
  synchronously in the Play tap** — iOS starts sound only from one.
- Text inputs ≥ 16px font.
- **Nothing is selectable** (`user-select: none` and
  `-webkit-touch-callout: none` on `html, body`, after 8b-i): a long
  press made iOS select a label and offer Copy. Inputs, textareas and
  `[contenteditable]` turn it back on (iOS won't type in a field
  otherwise); any other text she must copy needs `user-select: text`
  (the activity log has it).
- **No arrow or symbol characters as icons in labels** (↔, ↕, ✓, ★ …)
  — iOS may draw them as color emoji (↕ did, in 3b's flip button),
  and desktop Chromium won't show it. Use inline SVG with
  `currentColor`.
- Layouts must tolerate wider text than desktop Chromium shows — no
  `nowrap` on content that could grow.
- `sw.js` `APP_SHELL` lists every module reachable from `main.js`
  (a test enforces this). Pre-cache uses `cache: 'reload'`.
- **Shared origin:** all of the account's GitHub Pages projects share
  `bcrossley712.github.io`. Only ever touch `parapara-` caches and
  this scope's service-worker registration.
- **Schema and storage:** extend the schema additively; store/index
  changes need a `DB_VERSION` bump and a *new* upgrade branch. Any new
  kind of blob reference must be added to `mapBlobRefs` (`layers.js`)
  or the launch sweep deletes it (Saving and storage). A new storage
  write that changes a project must call `notifyChange`, or the
  backup misses it (Saving and storage).
- **Anything that changes layer pixels** — a new tool, flip, merge
  down — must mark the ink map and dirty rect (Canvas and drawing)
  and `frameCache.touch` the frame (Frames, playback and onion skin).

## Areas

**Before editing a file, read its area's section** in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Files, How it works,
Don't break, Testing tips, iPad-only checks).

| Area | Main files |
|---|---|
| [Canvas and drawing](docs/ARCHITECTURE.md#canvas-and-drawing) | `canvas/canvas.js`, `brush.js`, `gestures.js`, `region.js`, `ink-map.js` |
| [Layers, undo and copying](docs/ARCHITECTURE.md#layers-undo-and-copying) | `storage/layers.js`, `history.js`, `ui/layers-panel.js` |
| [Saving and storage](docs/ARCHITECTURE.md#saving-and-storage) | `storage/storage.js`, `autosave.js`, `dev-log.js` |
| [Backup](docs/ARCHITECTURE.md#backup) | `backup/*`, `ui/backup-sheet.js`, `worker/` |
| [Frames, playback and onion skin](docs/ARCHITECTURE.md#frames-playback-and-onion-skin) | `timeline/*`, `canvas/render-frame.js`, `frame-tiles.js`, `playback-frames.js`, `onion-view.js`, `thumbnail.js`, `ui/onion-badge.js` |
| [Reference image](docs/ARCHITECTURE.md#reference-image) | `canvas/reference.js`, `transform.js`, `ui/image-menu.js`, `reference-bar.js` |
| [Sound](docs/ARCHITECTURE.md#sound) | `audio/*`, `ui/sound-panel.js` |
| [Export and sharing](docs/ARCHITECTURE.md#export-and-sharing) | `export/*`, `ui/export-sheet.js` |
| [Colors and tool settings](docs/ARCHITECTURE.md#colors-and-tool-settings) | `ui/color-picker.js`, `ui/brush-panel.js`, `storage/colors.js` |
| [Editor UI, menus and screens](docs/ARCHITECTURE.md#editor-ui-menus-and-screens) | `ui/ui.js`, `gallery.js`, `confirm-dialog.js`, `icons.js`, `settings-panel.js`, `dev-log-view.js` |
| [PWA, layout and updates](docs/ARCHITECTURE.md#pwa-layout-and-updates) | `index.html`, `manifest.json`, `style.css`, `sw.js`, `updater.js` |

`main.js` is the glue between areas — read the section for whatever
it's wiring. Tests: `tests/unit/`,
`tests/e2e/` (see Testing). Test tooling: `package.json`,
`playwright.config.js`.

**Dev-only, remove before calling the app done:** the gear menu's
Developer section (Fresh reload, and from 2c a fill-all-layers
memory stress test; from 4a-i the Playback speed and Frame memory
tests — `timeline/dev-stress.js`, its import and launch call in
`main.js`, its `sw.js` entry and its `.pp-dev-report` CSS); from 5c the
**Mic delay test** (its button in `settings-panel.js`, `micDelayTest`
in `ui.js` and `main.js`, `devMicDelayTest`); after 4b,
the **Activity log** — `storage/dev-log.js`, `ui/dev-log-view.js`,
their `sw.js` entries, `tests/unit/dev-log.test.js`,
`tests/e2e/dev-log.spec.js`, the `devLog.add` calls, `guardContext`
and the `showNotice` wrapper in `main.js` (and the guard-context
assertions in `canvas-loss.spec.js`), `frameCache.memory`,
`liveCanvasCount` and its counter in `render-frame.js`, `canvasApi.onDebug`,
`storageLogFields` in `storage.js` (6d; keep `storageEstimate` if a
storage warning is ever built), the onion lines (`onion`,
`onion-ghosts`, `onion-draw`, `onion-failed`: `log` in
`onion-view.js`, `onionLogged` and the `onion=` field in `main.js`),
`logUncaught` in `main.js`, and the
`.pp-dev-log` CSS. It keeps 300 lines in localStorage
(`parapara-dev-log`); Copy takes the last 60 (`DEV_LOG_COPY_LINES`).

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
      exportImages: false,                    // 6d, Include images in the video; missing = false
      symmetry: 'off' | 'vertical' | 'horizontal' | 'both',   // 8b-i; missing = 'off' (sanitizeSymmetry)
      // no thumbnail field: its blob id is derived, thumb-<projectId>
      audioClips: [ { id, kind, blobRef, trimStart, trimEnd, offset, gain, leveling, volume } ]
                                              // 5a; seconds; offset = where it starts, missing = 0;
                                              // 5c: kind 'music' | 'voice' (missing = 'music'), at most
                                              // one of each, Music first; gain (a take's leveling,
                                              // ≤ 8) missing = 1; after 5c: leveling 'loudness'
                                              // (missing = 'peak'), volume (Music ≤ 1, Voice ≤ 2)
                                              // missing = 1; missing = [] (sanitizeAudioClips)
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
type, buffer }` — layer bitmaps, reference images, the sound file
(5a, its own MIME type) and the gallery thumbnail
`thumb-<projectId>`), `meta` (`lastProjectId`,
`toolSettings` = `{ tool, color, brushSizes: { draw, erase, smudge },
stabilizer: { draw, erase }, tips: { draw, erase },
tipSettings: { draw: { [tip]: { size, strength } }, erase: … } }`
(8a: stabilizer 0–10, missing = 5; 8b-ii: tips from brush.js `TIPS`,
missing = 'pen'; strength 1–100; missing tipSettings = defaults with
the old draw/erase sizes on Pen; `sanitizeToolSettings`), `uiState` = `{ screen: 'gallery' | 'editor',
hideHeadphonesTip }`
(5c; missing = false; `layersPanelOpen` retired after 5c, ignored);
`recentColors` = `['#rrggbb', …]` newest first).
`bitmapRef` is assigned when a frame or layer is created and never
changes; no blob under it means blank. Adding a layer adds a ref to
every frame record. Undo is never stored.

**Version 2 migration** (`migrateToSharedLayers`, pure and
unit-tested): the first frame's layers become the project's, ids and
bitmapRefs kept, so no pixels move. Version 1 had `frame.layers[]` +
`frame.activeLayerId`.

## Testing

**Add tests for new logic. Run them in three tiers — the sandbox
never runs the full suite (slow on 2 CPUs, and its `toBlob` stall
fails a random set each run; CI is the full check):**
1. **While working:** `npm run test:unit` (seconds) plus only the e2e
   spec files for the area being changed, e.g.
   `npx playwright test sound` (the area's Testing tips are in
   ARCHITECTURE.md). Stress-run a timing spec once it passes.
2. **Once, before handing off for a push:** `npm run test:unit`, the
   e2e specs of **every area touched**, and the robot test
   (`npx playwright test hunt` — it catches one area breaking
   another, as 5b's menu change did). **Failures: rerun only them,
   once** (`npx playwright test --last-failed`); a test that passes on
   the rerun was the stall. Investigate only one that fails twice.
3. **On every push:** CI runs the full suite on 4 workers and blocks
   the deploy on any failure — the real gate. A cross-area failure
   caught here costs one fix-and-push; nothing broken reaches the
   iPad.

**Hand-off checklist, every step:** tier 2 passes → the area
section in ARCHITECTURE.md is updated (rules and decisions only) →
Current state here says what's built and what to check on the iPad,
with no story of how it got there.

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
  different set each time — nothing to do with the app. **If saves run
  slow** (save-waiting tests time out at 5 s), add `E2E_SLOW_WAIT=20000`
  to the e2e command (CI never sets it); "hiding the app saves
  immediately" still fails there (it needs a save within 300 ms). So **a sandbox run is a pre-check; CI
  (pinned image) is the real check**: judge sandbox failures by
  whether they're this stall — rerun with `--last-failed` rather than
  rerunning everything.
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
  - **A check the notes tell a later conversation to rerun must be a
    committed spec** (skipping, with its reason, where it can't run —
    CI lacks ffmpeg and H.264/AAC encoders), never a throwaway: a
    deleted one has to be rebuilt from a description.
  - `openApp` (helpers) starts from the empty gallery on a fresh
    install and taps New animation; specs that need the gallery go
    through the Gallery button.
  - Each test gets its own browser context (own IndexedDB), so tests
    must not depend on order or on each other. ~3.2 min after the
    lost-canvas guard.
  - **The robot test** (`hunt.spec.js`): seeded random use with a
    model; checks every mark on screen and after a reload. **When it
    fails in the sandbox, read the message:** a timeout can be the
    stall, but "mark … should be there/gone" is a real mismatch —
    compare against a run without the change. (After 5b a menu-closing
    tap broke it in CI this way; its model now knows a tap with the
    frame menu open only closes it.) Since 4d it
    also deletes and drags frames and copies/pastes drawings; after a
    drag it reads the order back from the strip (auto-scroll can move
    the drop). CI runs 3
    seeds × 40 steps; locally `HUNT_SEEDS=16 HUNT_STEPS=80`, or
    `HUNT_SEED=<n>` to rerun a failure (the log is attached).
    `canvas-loss.spec.js` simulates the lost canvas (cleared, or
    ignoring `drawImage`).
- **CI:** test → build → deploy; a failing test stops the deploy.
  Failure reports are kept 7 days as a workflow artifact.
- **Published site = app files only.** The build job copies the repo
  *excluding* dev files. **Add any new dev-only top-level file or
  folder to that exclude list** in `deploy.yml`.
- **Device-only (say so at handoff):** iOS storage eviction, stylus
  feel, iPadOS gesture conflicts, Safari-only rendering, iOS
  suspend/relaunch behavior — plus each area's **iPad-only checks** in
  ARCHITECTURE.md for the areas a change touched.
