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
  ↕). How each works is in docs/ARCHITECTURE.md; she mostly undoes with the
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
  is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Frame cache and playback, Playback, Onion
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
  blank over the drawing. The guard is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → Lost
  canvases. Cause (likely memory) unknown: **if the log shows
  `load-renewed`, `load-broken`, `save-refused`, `check-failed`,
  `hold-refused` or `recover`, get the log** — it says when and how
  often, and now also `canvases=<full-size>/<all>` (in the page;
  offscreen ones aren't counted), `play=` and `onion=`.
- **A layer encode that never finishes fails the save after 15 s**
  instead of locking the editor (see docs/ARCHITECTURE.md → Saving and storage); if the log
  shows `save-failed … timed out`, get the log.
- **Now: step 5 — audio**, in three parts, each confirmed on the iPad
  before the next: **5a** import, storage and playback in sync · **5b**
  the sound panel, waveform and trim · **5c** hold-to-record while
  playing. What's built is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → Sound; the format
  reasoning, step 6's export, and where her songs can come from are in
  [design notes](docs/DESIGN_NOTES.md#planned-features).
  - **5a: import confirmed on the iPad; sound was silent — she was in
    Silent mode.** Fixed (after 5b): the audio session is set to
    "playback", so sound plays in Silent mode like her apps'; Play
    pressed while a project's sound is still loading now starts it too;
    the log says whether each Play's sound started (`sound-start`,
    `sound-silent`, `sound-unlock-failed`; `play` lists `ctx=` and
    `session=`). **Not yet confirmed on the iPad.** Check: sound plays
    with Silent on; in time with the animation, from frame 1 and from a
    later frame, looping without a gap or drift; the first Play after
    opening a project with sound (also Play pressed during "Getting
    ready"); fps and loop changes while playing; hiding the app stops
    it; a song over 3 minutes (only its start is used). If sound is
    missing, get the log. Tell her up front: songs from Spotify/Apple
    Music/Amazon Music streams can't be imported — bought downloads can.
  - **Her choices:** **hold to record** (Flipaclip; let go to stop);
    **the animation plays while she records**, so she can time her
    voice to it; **the waveform shows only in the sound panel** —
    the canvas keeps its full height (no lane under the tiles);
    **she records over music** (after 5b's first iPad check).
  - **5b: built, not yet confirmed on the iPad** — waiting on sound
    (how it works: docs/ARCHITECTURE.md → Sound). Check: the track
    lines up with the tiles and scrolls with them smoothly; dragging a
    handle or the clip with her stylus (handles big enough? edge
    scrolling too fast or slow?); picking a part of a long song on the
    overview; the playhead line while playing; a touch on the panel
    while playing only stops; the onion badge above the panel; memory
    with a 3-minute song open (the waveform is worked out when the
    panel first opens — any pause?). Ask her whether the panel should
    reopen by itself next launch (it doesn't).
  - **5c: built, not yet confirmed on the iPad** — Music and Voice
    rows, hold-to-record over music; how it works and her choices are in
    docs/ARCHITECTURE.md → Sound (countdown 3 s, headphones tip, confirm
    before replacing an older Voice, take kept on any interruption). Also
    fixed with it: the panel's waveform could be missing right after
    opening (`ui.js` didn't pass `onOpenChange` on). **First, run gear →
    Developer → Mic delay test** a few times (speaker, volume up, no
    headphones, quiet room) and send the log's `mic-delay` lines — the
    number goes into `MIC_DELAY_SECONDS` once. Check: the first hold asks
    for the mic and the banner says to hold again; the countdown and the
    hold with her finger and stylus (no callout or text selection on the
    held button); letting go during the countdown; recording from a later
    frame, playing to the last frame; music audible while recording
    (volume? speaker or earpiece?); the voice lining up with the
    animation on playback; with headphones vs without (does the song get
    into the voice?); AirPods; Silent mode; the headphones tip and
    "Don't show again"; replacing an older voice asks; Delete on each
    row; the panel's height with one and two rows. If anything's off,
    get the log (`rec-*`, `recorded`, `mic-delay`).
  - **After the first iPad round (2026-10-25):** takes recorded and
    played back, but **her voice was very quiet**, and the Mic delay
    test never found its click (the recording was too quiet for its
    fixed threshold — the click was heard in the room). Changed, **not
    yet on the iPad:** each take is leveled (a stored `gain`, up to 8×);
    automatic gain is asked for (`rec-start` logs whether Safari
    applied it: `agc=`); the test plays three clicks and finds them
    above the room's noise; record mode's paused sound is asked to run
    (`rec-start ctx=`). Check: is her voice loud enough now, and is
    there hiss? Run the Mic delay test again and send the `mic-delay`
    lines. Try a take **with music** and send its `rec-start` and
    `sound-start`/`sound-silent` lines — does the music play while she
    records?
  - **Out unless she asks** (Flipaclip has them): more than two rows,
    slicing, looping past the end, volume (song vs voice balance is the
    likely ask), a sound library, scrubbing sound while stepping
    frames.
  - **Device-only:** mic permission in the installed app (iOS may ask
    every launch), recording latency, the echo with and without
    headphones, playback volume and routing while the mic is on,
    AirPods dropping to call quality while recording.
- **Lost canvas seen again (log from 2026-10-25, before 5c) — look
  into it after 5c.** She keeps getting "This frame's drawing stopped
  showing…". The log: 16 s into a new one-layer project (just after
  closing another), `copy-renewed` (undo's committed copy emptied),
  then 0.8 s later `save-refused … had=1327 lost=976 canvases=1/4` →
  `recover`. The guard worked; only the stroke drawn on the blank
  canvas was lost. Two canvases emptied within a second points at iOS
  memory pressure. Leads: the undo history's ~150 MB in memory, what a
  closed project leaves behind, the frame cache's in-memory PNGs. Ask
  for more logs; note what she did just before each.
- **Layers panel → a menu that closes itself (her request, Procreate's
  way) — after 5c.** Opens from the top-bar button as now; a canvas
  tap only closes it (joins "a canvas tap with a menu open only closes
  it" — `anyMenuOpen`); not reopened at launch (`uiState.layersPanelOpen`
  retired). Decide when building: picking a layer keeps it open
  (Procreate) unless she wants otherwise; a canvas tap mid-rename keeps
  the typed name. The collapse-to-thumbnails version (Flipaclip) was
  offered and not chosen.
- **A canvas tap with a menu open only closes it (after 5b): built,
  not yet confirmed on the iPad.** Check with her stylus and fingers:
  open the color picker (and the Image, layer, frame, onion, fps and
  gear menus), tap the canvas — the menu closes, no dot; the next tap
  draws.
- **Robot test seed 115 loses a mark — found after 5b, not yet
  investigated.** `HUNT_SEED=115` fails every time it gets past the
  sandbox stall: frame A's first mark is gone on screen at the end.
  It fails the same on the 5a commit (before 5b and the menu change),
  so it's older; CI only runs seeds 101–103. Its steps include "canvas
  loses its pixels" — check the lost-canvas recovery first.
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

## Architecture (core)

Applies to the whole app. How each area works is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — see [Areas](#areas).

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
- **Defaults:** canvas 1920×1080 landscape, 12 fps — both stored per
  project, not hardcoded.
- **Planned** ([details](docs/DESIGN_NOTES.md#planned-features)):
  export to video + Web Share,
  then share links and Krita import via Worker + R2; storage warning at
  ~80% quota (with step 6).

## Global rules

Rules any change can run into, whatever area it's in. Area-specific
rules are in each area's **Don't break** in `docs/ARCHITECTURE.md`.

- **The picker opens inside the tap:** `ui.pickImage()` and
  `ui.pickAudio()` (5a) must run synchronously from a click (Image
  menu item, Replace, Import sound). An `await` before it and iOS
  won't open the picker. Likewise **`audio.unlock()` runs
  synchronously in the Play tap** — iOS starts sound only from one.
- Text inputs ≥ 16px font.
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
  or the launch sweep deletes it (Saving and storage).
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
| [Frames, playback and onion skin](docs/ARCHITECTURE.md#frames-playback-and-onion-skin) | `timeline/*`, `canvas/render-frame.js`, `frame-tiles.js`, `playback-frames.js`, `onion-view.js`, `thumbnail.js`, `ui/onion-badge.js` |
| [Reference image](docs/ARCHITECTURE.md#reference-image) | `canvas/reference.js`, `transform.js`, `ui/image-menu.js`, `reference-bar.js` |
| [Sound](docs/ARCHITECTURE.md#sound) | `audio/*`, `ui/sound-panel.js` |
| [Colors and tool settings](docs/ARCHITECTURE.md#colors-and-tool-settings) | `ui/color-picker.js`, `storage/colors.js` |
| [Editor UI, menus and screens](docs/ARCHITECTURE.md#editor-ui-menus-and-screens) | `ui/ui.js`, `gallery.js`, `confirm-dialog.js`, `icons.js`, `settings-panel.js`, `dev-log-view.js` |
| [PWA, layout and updates](docs/ARCHITECTURE.md#pwa-layout-and-updates) | `index.html`, `manifest.json`, `style.css`, `sw.js`, `updater.js` |

`main.js` is the glue between areas — read the section for whatever
it's wiring. `export/` is a placeholder for step 6. Tests: `tests/unit/`,
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
      audioClips: [ { id, kind, blobRef, trimStart, trimEnd, offset, gain } ]
                                              // 5a; seconds; offset = where it starts, missing = 0;
                                              // 5c: kind 'music' | 'voice' (missing = 'music'), at most
                                              // one of each, Music first; gain (a take's leveling,
                                              // ≤ 8) missing = 1; missing = [] (sanitizeAudioClips)
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
`thumb-<projectId>`), `meta` (`lastProjectId`, `toolSettings`,
`uiState` = `{ layersPanelOpen, screen: 'gallery' | 'editor',
hideHeadphonesTip }` (5c; missing = false);
`recentColors` = `['#rrggbb', …]` newest first).
`bitmapRef` is assigned when a frame or layer is created and never
changes; no blob under it means blank. Adding a layer adds a ref to
every frame record. Undo is never stored.

**Version 2 migration** (`migrateToSharedLayers`, pure and
unit-tested): the first frame's layers become the project's, ids and
bitmapRefs kept, so no pixels move. Version 1 had `frame.layers[]` +
`frame.activeLayerId`.

## Testing

**Add tests for new logic. Run them in three tiers — not the full
suite after every small change:**
1. **While working:** `npm run test:unit` (seconds) plus only the e2e
   spec files for the area being changed, e.g.
   `npx playwright test sound` (the area's Testing tips are in
   ARCHITECTURE.md). Stress-run a timing spec once it passes.
2. **Once, before handing off for a push:** the full suite — a change
   in one area can break another (5b's menu change broke the robot
   test). Sandbox failures may be the known `toBlob` stall (below).
3. **On every push:** CI runs everything on 4 workers and blocks the
   deploy on any failure — the real gate.

**Hand-off checklist, every step:** full suite passes → the area
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
