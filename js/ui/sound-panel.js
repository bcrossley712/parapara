// js/ui/sound-panel.js
//
// The top bar's Sound button and the sound panel it opens (5b; two rows
// in 5c). The panel slides up over the bottom of the canvas area, just
// above the frame tiles — it covers the canvas, never shrinks it (like
// the layers panel). Not remembered across launches: she opens it for
// a job.
//
//   - Two rows, each with its controls on the left (over the transport)
//     and its track lined up with the tiles (one frame = a tile and its
//     gap), scrolling with them:
//       Music — Import (Replace) and Delete; a slim overview of the
//         whole file above it.
//       Voice — the hold-to-record mic button and Delete (5c).
//     An empty row stays slim, saying what fills it, so the panel is
//     about 5b's height (agreed in 5c's scoping).
//   - The overview (Music only): the whole file (up to the 3-minute
//     cap), the part that plays highlighted. Drag it (or tap elsewhere
//     on it) to pick which part plays without moving it in the
//     animation (slipClip). Not in Flipaclip; agreed in 5b's scoping.
//   - On a track: drag the clip's middle to move it (left past frame 1
//     slides the sound's start under it, Flipaclip's way); drag a handle
//     to trim. A clip running past the last frame fades out at the
//     animation's end, where its right handle sits. A swipe on the empty
//     track scrolls the tiles; dragging near either end scrolls them
//     too. No snapping to frames.
//   - The mic (5c): press and hold. The panel only reports the press and
//     the release (onMicDown / onMicUp); main.js runs the countdown and
//     the recording, and tells the panel through render({ recording }).
//     While recording, the old Voice is dimmed and a red bar grows from
//     the frame she started on to the playhead.
//   - While playing, a line marks the frame showing. Touching a track
//     or the overview stops playback and does nothing else (anything
//     that changes the project stops playback first); Import only stops
//     it too (the file picker must open inside the tap, iOS).
//
// The waveforms are drawn on canvases only as wide as the track and
// redrawn as they scroll — never one canvas as long as the song (iOS
// caps canvas size and memory). Clips and handles are elements.
//
// Pure UI: main.js passes state in through render() and gets intents
// back through the callbacks. The edit rules are pure, in audio/clip.js.

import {
  animationSeconds,
  clipPlacement,
  clipVisibleEnd,
  minClipSeconds,
  moveClip,
  trimClipStart,
  trimClipEnd,
  slipClip,
} from '../audio/clip.js';
import { peakBetween } from '../audio/peaks.js';

// Dragging near either end of a track scrolls the tiles, like a lifted
// tile (frame-strip.js).
const SCROLL_EDGE = 48;
const MAX_SCROLL_STEP = 14; // px per animation frame

const ROW_TEXT = {
  music: {
    label: 'Music',
    empty: 'No music yet. Import a song from Files.',
    loading: 'Getting the music ready…',
    failed: "This music couldn't be played.",
  },
  voice: {
    label: 'Voice',
    empty: 'No voice yet. Hold the mic to record.',
    loading: 'Getting the voice ready…',
    failed: "This recording couldn't be played.",
    unsupported: "Recording isn't available here.",
  },
};

const EMPTY_ROW = { clip: null, duration: 0, peaks: null, loading: false };

// callbacks:
//   onImport() — must open the file picker synchronously (iOS)
//   onDelete(kind) — 'music' | 'voice'
//   onChange(kind, clip) — a drag ended with the clip changed (one undo step)
//   onMicDown() — the mic was pressed (5c)
//   onMicUp({ cancelled }) — and let go (cancelled: the touch was taken
//     away, e.g. by a system prompt)
//   onPlayingTouch() — a track or the overview was touched while playing
//   onOpenChange(open)
// options.container: the canvas area (the panel goes in it; its
//   --pp-sound-panel-height is kept up to date for what sits above).
// options.timeline: the frame strip's timeline API (geometry, scrollBy,
//   onScroll).
// options.signal: aborts listeners when the editor is torn down.
export function createSoundPanel(callbacks, { container, timeline, signal } = {}) {
  // --- the top bar button ---
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pp-icon-btn pp-sound-btn';
  button.setAttribute('aria-pressed', 'false');
  const icon = document.createElement('span');
  icon.className = 'pp-sound-btn__icon';
  icon.innerHTML = SOUND_ICON;
  const dot = document.createElement('span');
  dot.className = 'pp-sound-btn__dot';
  button.append(icon, dot);

  // --- the panel ---
  const panel = document.createElement('div');
  panel.className = 'pp-sound-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Sound');
  panel.hidden = true;
  // Keep the canvas area's stroke and playback-stop handling out of it
  // (like the onion badge).
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    panel.addEventListener(type, (event) => event.stopPropagation());
  }

  function textButton(label, onClick, className = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `pp-sound-panel__btn ${className}`.trim();
    btn.textContent = label;
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  function iconBtn(label, svg, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-sound-panel__btn pp-sound-panel__btn--icon';
    btn.setAttribute('aria-label', label);
    btn.innerHTML = svg;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function sideCell() {
    const side = document.createElement('div');
    side.className = 'pp-sound-panel__side';
    return side;
  }

  // Overview row: an empty side cell, the overview over the Music track.
  const overviewRow = document.createElement('div');
  overviewRow.className = 'pp-sound-panel__row pp-sound-panel__row--overview';
  const overview = document.createElement('div');
  overview.className = 'pp-sound-panel__overview';
  overview.setAttribute('aria-label', 'Whole song');
  const overviewCanvas = document.createElement('canvas');
  const windowBox = document.createElement('div');
  windowBox.className = 'pp-sound-panel__window';
  overview.append(overviewCanvas, windowBox);
  overviewRow.append(sideCell(), overview);

  // One row: its controls, then its track.
  function createRow(kind) {
    const element = document.createElement('div');
    element.className = `pp-sound-panel__row pp-sound-panel__row--${kind}`;
    const side = sideCell();
    const label = document.createElement('span');
    label.className = 'pp-sound-panel__label';
    label.textContent = ROW_TEXT[kind].label;
    side.appendChild(label);

    const track = document.createElement('div');
    track.className = 'pp-sound-panel__track';
    track.setAttribute('aria-label', `${ROW_TEXT[kind].label} track`);
    const waveCanvas = document.createElement('canvas');
    const clipBox = document.createElement('div');
    clipBox.className = 'pp-sound-panel__clip';
    clipBox.setAttribute('aria-label', kind === 'music' ? 'Music clip' : 'Voice clip');
    const startHandle = document.createElement('div');
    startHandle.className = 'pp-sound-panel__handle pp-sound-panel__handle--start';
    startHandle.setAttribute('aria-label', 'Trim start');
    const endHandle = document.createElement('div');
    endHandle.className = 'pp-sound-panel__handle pp-sound-panel__handle--end';
    endHandle.setAttribute('aria-label', 'Trim end');
    clipBox.append(startHandle, endHandle);
    const playheadLine = document.createElement('div');
    playheadLine.className = 'pp-sound-panel__playhead';
    playheadLine.hidden = true;
    const message = document.createElement('div');
    message.className = 'pp-sound-panel__message';
    track.append(waveCanvas, clipBox, playheadLine, message);

    element.append(side, track);
    return {
      kind, element, side, track, waveCanvas, clipBox, startHandle, endHandle, playheadLine, message,
    };
  }

  const rows = { music: createRow('music'), voice: createRow('voice') };

  // Music controls.
  const importBtn = textButton('Import sound', () => callbacks.onImport());
  const deleteMusicBtn = iconBtn('Delete sound', TRASH_ICON, () => callbacks.onDelete('music'));
  rows.music.side.append(importBtn, deleteMusicBtn);

  // Voice controls: the hold-to-record mic.
  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = 'pp-sound-panel__btn pp-sound-panel__mic';
  micBtn.setAttribute('aria-label', 'Hold to record');
  micBtn.innerHTML = `${MIC_ICON}<span class="pp-sound-panel__mic-text">Hold to record</span>`;
  const micText = micBtn.querySelector('.pp-sound-panel__mic-text');
  const deleteVoiceBtn = iconBtn('Delete voice', TRASH_ICON, () => callbacks.onDelete('voice'));
  rows.voice.side.append(micBtn, deleteVoiceBtn);
  // The red bar that grows while recording.
  const recordBar = document.createElement('div');
  recordBar.className = 'pp-sound-panel__recording';
  recordBar.hidden = true;
  rows.voice.track.insertBefore(recordBar, rows.voice.playheadLine);

  panel.append(overviewRow, rows.music.element, rows.voice.element);
  container.appendChild(panel);

  let state = {
    music: EMPTY_ROW, voice: EMPTY_ROW,
    fps: 12, frameCount: 1, busy: false, playing: false,
    recording: null, // null | { phase: 'countdown' | 'recording', startIndex }
    canRecord: true,
  };
  let open = false;
  let preview = null;   // { kind, clip } while a drag is shown, else null
  let gesture = null;   // the pointer being handled (see onDown)
  let mic = null;       // the mic button's pointer, while held
  let playheadIndex = null;
  let geo = null;       // timeline geometry, refreshed on each layout

  const rowState = (kind) => state[kind] ?? EMPTY_ROW;
  const clipShown = (kind) => (preview?.kind === kind ? preview.clip : rowState(kind).clip);
  const ready = (kind) => {
    const r = rowState(kind);
    return Boolean(r.clip && r.peaks && r.duration > 0);
  };
  const length = () => animationSeconds(state.frameCount, state.fps);
  const pxPerSecond = () => state.fps * (geo?.pitch ?? 0);
  // Animation time → x on a track.
  const xAt = (t) => t * pxPerSecond() - (geo?.scrollLeft ?? 0);

  function setOpen(next) {
    if (next === open) return;
    open = next;
    panel.hidden = !open;
    button.classList.toggle('is-active', open);
    button.setAttribute('aria-pressed', String(open));
    if (!open) {
      cancelGesture();
      releaseMic(true);
      container.style.removeProperty('--pp-sound-panel-height');
    }
    callbacks.onOpenChange?.(open);
    if (open) layout();
  }
  button.addEventListener('click', () => setOpen(!open));

  // --- layout and drawing ---

  // Lines the tracks up with the tiles: the side cells cover the
  // transport, the tracks span the tiles' list.
  function layout() {
    if (!open) return;
    geo = timeline.geometry();
    const box = panel.getBoundingClientRect();
    const left = Math.max(0, geo.left - box.left);
    panel.style.setProperty('--pp-sound-track-left', `${left}px`);
    panel.style.setProperty('--pp-sound-track-width', `${geo.width}px`);
    container.style.setProperty('--pp-sound-panel-height', `${Math.round(panel.offsetHeight)}px`);
    for (const row of Object.values(rows)) {
      sizeCanvas(row.waveCanvas, geo.width, row.track.clientHeight);
    }
    sizeCanvas(overviewCanvas, geo.width, overview.clientHeight);
    draw();
    drawOverview();
  }

  function sizeCanvas(canvas, width, height) {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  function colors() {
    const css = getComputedStyle(panel);
    return {
      music: css.getPropertyValue('--pp-accent').trim() || '#f2a65a',
      voice: css.getPropertyValue('--pp-sound-voice').trim() || '#8cc4e8',
      faint: css.getPropertyValue('--pp-ink-light').trim() || '#55483a',
      tick: 'rgba(250, 244, 235, 0.08)',
    };
  }

  function draw() {
    if (!open || !geo) return;
    const c = colors();
    for (const row of Object.values(rows)) drawRow(row, c);
    placePlayhead();
    placeRecordBar();
  }

  // A track: frame ticks, then its clip's waveform; the clip box and
  // handles are elements placed here too.
  function drawRow(row, c) {
    const { kind, waveCanvas } = row;
    const ctx = waveCanvas.getContext('2d');
    const dpr = globalThis.devicePixelRatio || 1;
    const w = waveCanvas.width / dpr;
    const h = waveCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const clip = clipShown(kind);
    placeClipBox(row, clip);
    if (!clip || !ready(kind)) return;

    // A faint line at each frame's start, so the track reads against
    // the tiles below.
    const end = Math.min(w, geo.contentWidth - geo.scrollLeft);
    ctx.fillStyle = c.tick;
    const firstFrame = Math.ceil(geo.scrollLeft / geo.pitch);
    for (let i = firstFrame; i * geo.pitch - geo.scrollLeft < end; i++) {
      ctx.fillRect(Math.round(i * geo.pitch - geo.scrollLeft), 0, 1, h);
    }

    const len = length();
    const x0 = Math.max(0, xAt(clip.offset));
    const x1 = Math.min(end, xAt(clipVisibleEnd(clip, len)));
    const perPx = 1 / pxPerSecond();
    const mid = h / 2;
    const { peaks } = rowState(kind);
    ctx.fillStyle = c[kind];
    for (let x = Math.floor(x0); x < x1; x++) {
      const t = (x + geo.scrollLeft) * perPx; // animation time
      const fileT = clip.trimStart + (t - clip.offset);
      const peak = peakBetween(peaks, fileT, fileT + perPx);
      const half = Math.max(0.5, peak * (mid - 4));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }

  function placeClipBox(row, clip) {
    if (!clip || !ready(row.kind) || !geo) {
      row.clipBox.hidden = true;
      return;
    }
    const len = length();
    const left = xAt(clip.offset);
    const runsOn = clip.offset + (clip.trimEnd - clip.trimStart) > len;
    // The animation's end, at most the end of the last tile.
    const right = Math.min(xAt(clipVisibleEnd(clip, len)), geo.contentWidth - geo.scrollLeft);
    row.clipBox.hidden = false;
    row.clipBox.style.left = `${left}px`;
    row.clipBox.style.width = `${Math.max(0, right - left)}px`;
    row.clipBox.classList.toggle('runs-on', runsOn);
  }

  function placePlayhead() {
    for (const row of Object.values(rows)) {
      if (playheadIndex === null || !geo) {
        row.playheadLine.hidden = true;
        continue;
      }
      row.playheadLine.hidden = false;
      row.playheadLine.style.left = `${playheadIndex * geo.pitch - geo.scrollLeft}px`;
    }
  }

  // While recording: from the frame she started on to the playhead.
  function placeRecordBar() {
    const rec = state.recording;
    if (!rec || rec.phase !== 'recording' || !geo || playheadIndex === null) {
      recordBar.hidden = true;
      return;
    }
    const left = rec.startIndex * geo.pitch - geo.scrollLeft;
    const right = (playheadIndex + 1) * geo.pitch - geo.scrollLeft;
    recordBar.hidden = false;
    recordBar.style.left = `${left}px`;
    recordBar.style.width = `${Math.max(0, right - left)}px`;
  }

  // The overview: the whole usable Music file squeezed into the track's
  // width, the part that plays in the window.
  function drawOverview() {
    if (!open || !geo) return;
    const ctx = overviewCanvas.getContext('2d');
    const dpr = globalThis.devicePixelRatio || 1;
    const w = overviewCanvas.width / dpr;
    const h = overviewCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const clip = clipShown('music');
    if (!clip || !ready('music')) {
      windowBox.hidden = true;
      return;
    }
    const { peaks, duration } = rowState('music');
    const c = colors();
    const perPx = duration / w;
    const mid = h / 2;
    ctx.fillStyle = c.faint;
    for (let x = 0; x < w; x++) {
      const peak = peakBetween(peaks, x * perPx, (x + 1) * perPx);
      const half = Math.max(0.5, peak * (mid - 2));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
    const placement = clipPlacement(clip, length());
    const from = placement ? placement.from : clip.trimStart;
    const to = placement ? placement.to : clip.trimStart;
    windowBox.hidden = false;
    windowBox.style.left = `${(from / duration) * w}px`;
    windowBox.style.width = `${Math.max(3, ((to - from) / duration) * w)}px`;
  }

  // --- dragging ---
  //
  // gesture = { pointerId, kind (row), action, startX, startScroll, x,
  //   lastX, startClip, jump, raf, captured, swallowed }
  // action: 'move' | 'trim-start' | 'trim-end' | 'slip' | 'scroll'

  function onDown(event, area, row) {
    if (gesture || !event.isPrimary) return;
    if (state.playing) {
      // Swallow the touch: stopping is all it does.
      gesture = { pointerId: event.pointerId, swallowed: true };
      callbacks.onPlayingTouch?.();
      return;
    }
    const kind = area === 'overview' ? 'music' : row.kind;
    let action = 'scroll';
    let jump = 0;
    const editable = ready(kind) && !state.busy && !state.recording;
    if (area === 'overview') {
      if (!editable) return;
      action = 'slip';
      // A tap outside the window jumps its start there first.
      const box = windowBox.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right) {
        const ox = overview.getBoundingClientRect().left;
        const t = ((event.clientX - ox) / overview.clientWidth) * rowState('music').duration;
        jump = t - rowState('music').clip.trimStart;
      }
    } else if (editable) {
      if (event.target === row.startHandle) action = 'trim-start';
      else if (event.target === row.endHandle) action = 'trim-end';
      else if (event.target === row.clipBox) action = 'move';
    }
    geo = timeline.geometry();
    gesture = {
      pointerId: event.pointerId,
      kind,
      action,
      track: area === 'overview' ? null : row.track,
      startX: event.clientX,
      startScroll: geo.scrollLeft,
      x: event.clientX,
      startClip: rowState(kind).clip,
      jump,
      raf: 0,
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* gone */ }
    gesture.captured = event.currentTarget;
    if (action === 'slip') applyDrag();
    if (action !== 'scroll' && action !== 'slip') gesture.raf = requestAnimationFrame(edgeScroll);
  }

  function applyDrag() {
    const g = gesture;
    if (!g || g.swallowed) return;
    if (g.action === 'scroll') {
      timeline.scrollBy(-(g.x - g.lastX));
      g.lastX = g.x;
      return;
    }
    const limits = {
      duration: rowState(g.kind).duration,
      minLength: minClipSeconds(state.fps),
      length: length(),
    };
    let clip;
    if (g.action === 'slip') {
      const dt = g.jump + ((g.x - g.startX) / Math.max(1, overview.clientWidth)) * limits.duration;
      clip = slipClip(g.startClip, dt, limits);
    } else {
      geo = timeline.geometry();
      const dx = g.x - g.startX + (geo.scrollLeft - g.startScroll);
      const dt = dx / pxPerSecond();
      const rule = g.action === 'move' ? moveClip : g.action === 'trim-start' ? trimClipStart : trimClipEnd;
      clip = rule(g.startClip, dt, limits);
    }
    preview = { kind: g.kind, clip };
    draw();
    drawOverview();
  }

  // While dragging a clip or a handle near either end, the tiles scroll
  // (and the drag follows).
  function edgeScroll() {
    const g = gesture;
    if (!g || !g.track) return;
    const box = g.track.getBoundingClientRect();
    let step = 0;
    if (g.x < box.left + SCROLL_EDGE) step = -MAX_SCROLL_STEP * Math.min(1, (box.left + SCROLL_EDGE - g.x) / SCROLL_EDGE);
    else if (g.x > box.right - SCROLL_EDGE) step = MAX_SCROLL_STEP * Math.min(1, (g.x - (box.right - SCROLL_EDGE)) / SCROLL_EDGE);
    if (step) {
      timeline.scrollBy(step);
      applyDrag();
    }
    g.raf = requestAnimationFrame(edgeScroll);
  }

  function onMove(event) {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId || g.swallowed) return;
    if (g.lastX === undefined) g.lastX = g.x;
    g.x = event.clientX;
    applyDrag();
  }

  function onUp(event) {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId) return;
    endGesture(event.type === 'pointercancel');
  }

  function endGesture(cancelled) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    cancelAnimationFrame(g.raf);
    try { g.captured?.releasePointerCapture(g.pointerId); } catch { /* released */ }
    const result = preview?.clip;
    preview = null;
    if (!cancelled && result && g.startClip && !sameClip(result, g.startClip)) {
      callbacks.onChange(g.kind, result);
    } else {
      draw();
      drawOverview();
    }
  }

  function cancelGesture() {
    if (gesture) endGesture(true);
  }

  const areas = [[overview, 'overview', null], ...Object.values(rows).map((row) => [row.track, 'track', row])];
  for (const [el, area, row] of areas) {
    el.addEventListener('pointerdown', (event) => onDown(event, area, row));
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', (event) => {
      if (gesture && event.pointerId === gesture.pointerId && !gesture.swallowed) endGesture(true);
    });
  }
  // A swallowed touch (while playing) ends wherever the finger lifts.
  const onDocUp = (event) => {
    if (gesture?.swallowed && event.pointerId === gesture.pointerId) gesture = null;
  };
  document.addEventListener('pointerup', onDocUp, { signal });
  document.addEventListener('pointercancel', onDocUp, { signal });
  panel.addEventListener('contextmenu', (event) => event.preventDefault());

  // --- the mic (5c): press and hold ---

  micBtn.addEventListener('pointerdown', (event) => {
    if (mic || !event.isPrimary || micBtn.disabled) return;
    event.preventDefault(); // no text selection or callout on a held button
    mic = { pointerId: event.pointerId };
    try { micBtn.setPointerCapture(event.pointerId); } catch { /* gone */ }
    micBtn.classList.add('is-held');
    callbacks.onMicDown?.();
  });
  const onMicEnd = (event) => {
    if (!mic || event.pointerId !== mic.pointerId) return;
    releaseMic(event.type !== 'pointerup');
  };
  micBtn.addEventListener('pointerup', onMicEnd);
  micBtn.addEventListener('pointercancel', onMicEnd);
  micBtn.addEventListener('lostpointercapture', onMicEnd);
  // The click that follows a hold isn't a separate action.
  micBtn.addEventListener('click', (event) => event.preventDefault());

  function releaseMic(cancelled) {
    if (!mic) return;
    const { pointerId } = mic;
    mic = null;
    micBtn.classList.remove('is-held');
    try { micBtn.releasePointerCapture(pointerId); } catch { /* released */ }
    callbacks.onMicUp?.({ cancelled });
  }

  timeline.onScroll(() => {
    if (!open) return;
    geo = timeline.geometry();
    draw();
  });
  const resize = new ResizeObserver(() => layout());
  resize.observe(panel);
  signal?.addEventListener('abort', () => resize.disconnect());

  // --- state ---

  function renderRow(kind) {
    const row = rows[kind];
    const r = rowState(kind);
    const text = ROW_TEXT[kind];
    const has = Boolean(r.clip);
    let msg = '';
    if (kind === 'voice' && state.recording?.phase === 'recording') msg = ''; // the red bar says it
    else if (kind === 'voice' && !state.canRecord && !has) msg = text.unsupported;
    else if (!has) msg = text.empty;
    else if (!ready(kind)) msg = r.loading ? text.loading : text.failed;
    row.message.textContent = msg;
    row.message.hidden = !msg;
    // An empty row stays slim.
    row.element.classList.toggle('is-empty', !ready(kind));
  }

  // next: { music, voice — each { clip, duration (s of the decoded
  //   file), peaks, loading }; fps, frameCount, busy, playing,
  //   recording, canRecord }
  function render(next) {
    const before = state;
    state = { ...state, ...next };
    // Anything that changes what a drag started from ends it.
    if (gesture && !gesture.swallowed
      && (rowState(gesture.kind).clip !== before[gesture.kind]?.clip || state.busy || state.playing
        || state.recording || state.fps !== before.fps || state.frameCount !== before.frameCount)) {
      cancelGesture();
    }
    const music = rowState('music');
    const voice = rowState('voice');
    const has = Boolean(music.clip || voice.clip);
    dot.hidden = !has;
    button.setAttribute('aria-label', has ? 'Sound (this animation has sound)' : 'Sound');
    button.classList.toggle('has-sound', has);

    const recording = state.recording;
    importBtn.textContent = music.clip ? 'Replace' : 'Import sound';
    importBtn.setAttribute('aria-label', music.clip ? 'Replace sound' : 'Import sound');
    importBtn.disabled = state.busy || Boolean(recording);
    deleteMusicBtn.hidden = !music.clip;
    deleteMusicBtn.disabled = state.busy || Boolean(recording);
    deleteVoiceBtn.hidden = !voice.clip;
    deleteVoiceBtn.disabled = state.busy || Boolean(recording);
    micBtn.hidden = !state.canRecord;
    // Busy only blocks a new press; a hold in progress keeps going.
    micBtn.disabled = state.busy && !recording && !mic;
    micBtn.classList.toggle('is-recording', recording?.phase === 'recording');
    micBtn.classList.toggle('is-counting', recording?.phase === 'countdown');
    micText.textContent = recording?.phase === 'recording' ? 'Recording' : 'Hold to record';
    rows.voice.track.classList.toggle('is-muted', Boolean(recording));

    panel.classList.toggle('is-busy', state.busy);
    overviewRow.hidden = !ready('music');
    renderRow('music');
    renderRow('voice');
    layout();
  }

  // The frame index showing while playing, or null.
  function setPlayhead(index) {
    playheadIndex = index;
    if (open) {
      placePlayhead();
      placeRecordBar();
    }
  }

  render({});
  return {
    button,
    element: panel,
    render,
    setPlayhead,
    open: () => setOpen(true),
    close: () => setOpen(false),
    get isOpen() {
      return open;
    },
    // Whether the mic is held down right now.
    get micHeld() {
      return mic !== null;
    },
  };
}

function sameClip(a, b) {
  return a.trimStart === b.trimStart && a.trimEnd === b.trimEnd && a.offset === b.offset;
}

// A pair of beamed eighth notes.
const SOUND_ICON = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <path d="M9 17.5V6l11-2.5v11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  <ellipse cx="6.5" cy="17.5" rx="2.8" ry="2.2" fill="currentColor"/>
  <ellipse cx="17.5" cy="15" rx="2.8" ry="2.2" fill="currentColor"/>
</svg>`;

const MIC_ICON = `
<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
  <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/>
  <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const TRASH_ICON = `
<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
  <path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
