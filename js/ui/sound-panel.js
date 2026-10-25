// js/ui/sound-panel.js
//
// The top bar's Sound button and the sound panel it opens (5b), which
// replaced 5a's little menu. The panel slides up over the bottom of the
// canvas area, just above the frame tiles — it covers the canvas, never
// shrinks it (like the layers panel). Not remembered across launches:
// she opens it for a job.
//
//   - Left, above the transport: Import (Replace) and Delete. Room for
//     5c's hold-to-record button.
//   - The overview: the whole file (up to the 3-minute cap), the part
//     that plays highlighted. Drag it (or tap elsewhere on it) to pick
//     which part of the song plays without moving it in the animation
//     (slipClip) — at the tiles' scale a song is far too long to reach
//     its middle by dragging. Not in Flipaclip; agreed in 5b's scoping.
//   - The track, lined up with the tiles and scrolling with them (one
//     frame = a tile and its gap): the clip, its waveform, a trim handle
//     at each end. Drag the middle to move it (left past frame 1 slides
//     the song's start under it, Flipaclip's way); drag a handle to
//     trim. A clip running past the last frame fades out at the
//     animation's end, where its right handle sits. A swipe on the
//     empty track scrolls the tiles; dragging near either end scrolls
//     them too. No snapping to frames.
//   - While playing, a line marks the frame showing. Touching the track
//     or overview stops playback and does nothing else (anything that
//     changes the project stops playback first); Import only stops it
//     too (the file picker must open inside the tap, iOS).
//
// The waveform is drawn on a canvas only as wide as the track and
// redrawn as it scrolls — never one canvas as long as the song (iOS
// caps canvas size and memory). The clip and handles are elements.
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

// Dragging near either end of the track scrolls the tiles, like a
// lifted tile (frame-strip.js).
const SCROLL_EDGE = 48;
const MAX_SCROLL_STEP = 14; // px per animation frame

// callbacks:
//   onImport() — must open the file picker synchronously (iOS)
//   onDelete()
//   onChange(clip) — a drag ended with the clip changed (one undo step)
//   onPlayingTouch() — the track or overview was touched while playing
//   onOpenChange(open)
// options.container: the canvas area (the panel goes in it).
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

  const side = document.createElement('div');
  side.className = 'pp-sound-panel__side';
  const importBtn = textButton('Import sound', () => callbacks.onImport());
  const deleteBtn = textButton('Delete', () => callbacks.onDelete());
  deleteBtn.setAttribute('aria-label', 'Delete sound');
  side.append(importBtn, deleteBtn);

  const main = document.createElement('div');
  main.className = 'pp-sound-panel__main';

  const overview = document.createElement('div');
  overview.className = 'pp-sound-panel__overview';
  overview.setAttribute('aria-label', 'Whole sound');
  const overviewCanvas = document.createElement('canvas');
  const windowBox = document.createElement('div');
  windowBox.className = 'pp-sound-panel__window';
  overview.append(overviewCanvas, windowBox);

  const track = document.createElement('div');
  track.className = 'pp-sound-panel__track';
  const waveCanvas = document.createElement('canvas');
  const clipBox = document.createElement('div');
  clipBox.className = 'pp-sound-panel__clip';
  clipBox.setAttribute('aria-label', 'Sound clip');
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
  track.append(waveCanvas, clipBox, playheadLine);

  const message = document.createElement('div');
  message.className = 'pp-sound-panel__message';

  main.append(overview, track, message);
  panel.append(side, main);
  container.appendChild(panel);

  let state = {
    clip: null, duration: 0, peaks: null, loading: false,
    fps: 12, frameCount: 1, busy: false, playing: false,
  };
  let open = false;
  let preview = null;   // the clip while a drag is shown, else null
  let gesture = null;   // the pointer being handled (see onDown)
  let playheadIndex = null;
  let geo = null;       // timeline geometry, refreshed on each layout

  const clipShown = () => preview ?? state.clip;
  const ready = () => Boolean(state.clip && state.peaks && state.duration > 0);
  const length = () => animationSeconds(state.frameCount, state.fps);
  const pxPerSecond = () => state.fps * (geo?.pitch ?? 0);
  // Animation time → x on the track (and back).
  const xAt = (t) => t * pxPerSecond() - (geo?.scrollLeft ?? 0);

  function textButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-sound-panel__btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function setOpen(next) {
    if (next === open) return;
    open = next;
    panel.hidden = !open;
    button.classList.toggle('is-active', open);
    button.setAttribute('aria-pressed', String(open));
    if (!open) cancelGesture();
    callbacks.onOpenChange?.(open);
    if (open) layout();
  }
  button.addEventListener('click', () => setOpen(!open));

  // --- layout and drawing ---

  // Lines the track up with the tiles: the side column covers the
  // transport, the track spans the tiles' list.
  function layout() {
    if (!open) return;
    geo = timeline.geometry();
    const box = panel.getBoundingClientRect();
    const left = Math.max(0, geo.left - box.left);
    panel.style.setProperty('--pp-sound-track-left', `${left}px`);
    panel.style.setProperty('--pp-sound-track-width', `${geo.width}px`);
    sizeCanvas(waveCanvas, geo.width, track.clientHeight);
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
      wave: css.getPropertyValue('--pp-accent').trim() || '#f2a65a',
      faint: css.getPropertyValue('--pp-ink-light').trim() || '#55483a',
      tick: 'rgba(250, 244, 235, 0.08)',
    };
  }

  // The track: frame ticks, then the clip's waveform; the clip box,
  // handles and playhead are elements placed here too.
  function draw() {
    if (!open || !geo) return;
    const ctx = waveCanvas.getContext('2d');
    const dpr = globalThis.devicePixelRatio || 1;
    const w = waveCanvas.width / dpr;
    const h = waveCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const c = colors();

    // A faint line at each frame's start, so the track reads against
    // the tiles below.
    const end = Math.min(w, geo.contentWidth - geo.scrollLeft);
    ctx.fillStyle = c.tick;
    const firstFrame = Math.ceil(geo.scrollLeft / geo.pitch);
    for (let i = firstFrame; i * geo.pitch - geo.scrollLeft < end; i++) {
      ctx.fillRect(Math.round(i * geo.pitch - geo.scrollLeft), 0, 1, h);
    }

    const clip = clipShown();
    placeClipBox(clip);
    placePlayhead();
    if (!clip || !ready()) return;

    const len = length();
    const x0 = Math.max(0, xAt(clip.offset));
    const x1 = Math.min(end, xAt(clipVisibleEnd(clip, len)));
    const perPx = 1 / pxPerSecond();
    const mid = h / 2;
    ctx.fillStyle = c.wave;
    for (let x = Math.floor(x0); x < x1; x++) {
      const t = (x + geo.scrollLeft) * perPx; // animation time
      const fileT = clip.trimStart + (t - clip.offset);
      const peak = peakBetween(state.peaks, fileT, fileT + perPx);
      const half = Math.max(0.5, peak * (mid - 4));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }

  function placeClipBox(clip) {
    if (!clip || !ready() || !geo) {
      clipBox.hidden = true;
      return;
    }
    const len = length();
    const left = xAt(clip.offset);
    const runsOn = clip.offset + (clip.trimEnd - clip.trimStart) > len;
    // The animation's end, at most the end of the last tile.
    const right = Math.min(xAt(clipVisibleEnd(clip, len)), geo.contentWidth - geo.scrollLeft);
    clipBox.hidden = false;
    clipBox.style.left = `${left}px`;
    clipBox.style.width = `${Math.max(0, right - left)}px`;
    clipBox.classList.toggle('runs-on', runsOn);
  }

  function placePlayhead() {
    if (playheadIndex === null || !geo) {
      playheadLine.hidden = true;
      return;
    }
    playheadLine.hidden = false;
    playheadLine.style.left = `${playheadIndex * geo.pitch - geo.scrollLeft}px`;
  }

  // The overview: the whole usable file squeezed into the track's
  // width, the part that plays in the window.
  function drawOverview() {
    if (!open || !geo) return;
    const ctx = overviewCanvas.getContext('2d');
    const dpr = globalThis.devicePixelRatio || 1;
    const w = overviewCanvas.width / dpr;
    const h = overviewCanvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const clip = clipShown();
    if (!clip || !ready()) {
      windowBox.hidden = true;
      return;
    }
    const c = colors();
    const perPx = state.duration / w;
    const mid = h / 2;
    ctx.fillStyle = c.faint;
    for (let x = 0; x < w; x++) {
      const peak = peakBetween(state.peaks, x * perPx, (x + 1) * perPx);
      const half = Math.max(0.5, peak * (mid - 2));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
    const placement = clipPlacement(clip, length());
    const from = placement ? placement.from : clip.trimStart;
    const to = placement ? placement.to : clip.trimStart;
    windowBox.hidden = false;
    windowBox.style.left = `${(from / state.duration) * w}px`;
    windowBox.style.width = `${Math.max(3, ((to - from) / state.duration) * w)}px`;
  }

  // --- dragging ---
  //
  // gesture = { pointerId, kind, startX, startScroll, x, startClip,
  //   jump, raf, swallowed }
  // kind: 'move' | 'trim-start' | 'trim-end' | 'slip' | 'scroll'

  function onDown(event, area) {
    if (gesture || !event.isPrimary) return;
    if (state.playing) {
      // Swallow the touch: stopping is all it does.
      gesture = { pointerId: event.pointerId, swallowed: true };
      callbacks.onPlayingTouch?.();
      return;
    }
    let kind = 'scroll';
    let jump = 0;
    if (area === 'overview') {
      if (!ready() || state.busy) return;
      kind = 'slip';
      // A tap outside the window jumps its start there first.
      const box = windowBox.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right) {
        const ox = overview.getBoundingClientRect().left;
        const t = ((event.clientX - ox) / overview.clientWidth) * state.duration;
        jump = t - state.clip.trimStart;
      }
    } else if (ready() && !state.busy) {
      if (event.target === startHandle) kind = 'trim-start';
      else if (event.target === endHandle) kind = 'trim-end';
      else if (event.target === clipBox) kind = 'move';
    }
    geo = timeline.geometry();
    gesture = {
      pointerId: event.pointerId,
      kind,
      startX: event.clientX,
      startScroll: geo.scrollLeft,
      x: event.clientX,
      startClip: state.clip,
      jump,
      raf: 0,
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* gone */ }
    gesture.captured = event.currentTarget;
    if (kind === 'slip') applyDrag();
    if (kind !== 'scroll' && kind !== 'slip') gesture.raf = requestAnimationFrame(edgeScroll);
  }

  function applyDrag() {
    const g = gesture;
    if (!g || g.swallowed) return;
    if (g.kind === 'scroll') {
      timeline.scrollBy(-(g.x - g.lastX));
      g.lastX = g.x;
      return;
    }
    const limits = {
      duration: state.duration,
      minLength: minClipSeconds(state.fps),
      length: length(),
    };
    if (g.kind === 'slip') {
      const dt = g.jump + ((g.x - g.startX) / Math.max(1, overview.clientWidth)) * state.duration;
      preview = slipClip(g.startClip, dt, limits);
    } else {
      geo = timeline.geometry();
      const dx = g.x - g.startX + (geo.scrollLeft - g.startScroll);
      const dt = dx / pxPerSecond();
      const rule = g.kind === 'move' ? moveClip : g.kind === 'trim-start' ? trimClipStart : trimClipEnd;
      preview = rule(g.startClip, dt, limits);
    }
    draw();
    drawOverview();
  }

  // While dragging the clip or a handle near either end, the tiles
  // scroll (and the drag follows).
  function edgeScroll() {
    const g = gesture;
    if (!g || g.kind === 'scroll' || g.kind === 'slip') return;
    const box = track.getBoundingClientRect();
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
    const result = preview;
    preview = null;
    if (!cancelled && result && g.startClip && !sameClip(result, g.startClip)) {
      callbacks.onChange(result);
    } else {
      draw();
      drawOverview();
    }
  }

  function cancelGesture() {
    if (gesture) endGesture(true);
  }

  for (const [el, area] of [[track, 'track'], [overview, 'overview']]) {
    el.addEventListener('pointerdown', (event) => onDown(event, area));
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

  timeline.onScroll(() => {
    if (!open) return;
    geo = timeline.geometry();
    draw();
  });
  const resize = new ResizeObserver(() => layout());
  resize.observe(panel);
  signal?.addEventListener('abort', () => resize.disconnect());

  // --- state ---

  // next: { clip, duration (s of the decoded file), peaks, loading,
  //   fps, frameCount, busy, playing }
  function render(next) {
    const before = state;
    state = { ...state, ...next };
    // Anything that changes what the drag started from ends it.
    if (gesture && !gesture.swallowed
      && (state.clip !== before.clip || state.busy || state.playing
        || state.fps !== before.fps || state.frameCount !== before.frameCount)) {
      cancelGesture();
    }
    const has = Boolean(state.clip);
    dot.hidden = !has;
    button.setAttribute('aria-label', has ? 'Sound (this animation has sound)' : 'Sound');
    button.classList.toggle('has-sound', has);
    importBtn.textContent = has ? 'Replace' : 'Import sound';
    importBtn.setAttribute('aria-label', has ? 'Replace sound' : 'Import sound');
    importBtn.disabled = state.busy;
    deleteBtn.hidden = !has;
    deleteBtn.disabled = state.busy;
    panel.classList.toggle('is-busy', state.busy);
    if (!has) message.textContent = 'No sound yet. Import a song or sound from Files.';
    else if (!ready()) message.textContent = state.loading ? 'Getting the sound ready…' : "This sound couldn't be played.";
    else message.textContent = '';
    message.hidden = ready();
    overview.hidden = !ready();
    layout();
  }

  // The frame index showing while playing, or null.
  function setPlayhead(index) {
    playheadIndex = index;
    if (open) placePlayhead();
  }

  render({});
  return {
    button,
    element: panel,
    render,
    setPlayhead,
    close: () => setOpen(false),
    get isOpen() {
      return open;
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
