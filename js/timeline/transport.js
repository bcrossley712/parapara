// js/timeline/transport.js
//
// The transport (step 4b): previous frame, play/pause, next frame, the
// loop toggle and the fps button, at the left end of the frame strip's
// row (Flipaclip keeps its play button down with the timeline; this
// saves the canvas a row of height). The fps button opens a small
// panel above it: − / + and quick picks.
//
// Also the "Getting ready" label that sits over the canvas while
// frames are still being flattened before playback can start; ui.js
// puts `statusElement` in the canvas area.
//
// Pure UI: main.js passes state in through render() and gets intents
// back through the callbacks. Icons are inline SVG (no symbol
// characters — iOS may draw those as emoji).

import { MIN_FPS, MAX_FPS, FPS_PRESETS } from './clock.js';

// callbacks: onPlay() (play, or pause while playing/getting ready),
//   onPrev(), onNext(), onLoop() (toggle), onFps(fps)
// options.signal: aborts the document listener (the fps panel's
//   tap-outside close) when the editor is torn down.
export function createTransport(callbacks, { signal } = {}) {
  const element = document.createElement('div');
  element.className = 'pp-transport';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Playback');

  const prevBtn = button('Previous frame', PREV_ICON, () => callbacks.onPrev());
  const playBtn = button('Play', PLAY_ICON, () => callbacks.onPlay());
  playBtn.classList.add('pp-transport__play');
  const nextBtn = button('Next frame', NEXT_ICON, () => callbacks.onNext());
  const loopBtn = button('Loop', LOOP_ICON, () => callbacks.onLoop());
  const fpsBtn = button('Frames per second', '', () => setPanelOpen(!panel.isConnected));
  fpsBtn.classList.add('pp-transport__fps');
  fpsBtn.setAttribute('aria-haspopup', 'true');
  const fpsLabel = document.createElement('span');
  fpsBtn.appendChild(fpsLabel);
  element.append(prevBtn, playBtn, nextBtn, loopBtn, fpsBtn);

  // --- the fps panel ---
  const panel = document.createElement('div');
  panel.className = 'pp-fps-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Frames per second');
  const title = document.createElement('div');
  title.className = 'pp-fps-panel__title';
  title.textContent = 'Frames per second';
  const stepRow = document.createElement('div');
  stepRow.className = 'pp-fps-panel__step';
  const minusBtn = panelButton('Slower', MINUS_ICON, () => callbacks.onFps(fps - 1));
  const value = document.createElement('span');
  value.className = 'pp-fps-panel__value';
  const plusBtn = panelButton('Faster', PLUS_ICON, () => callbacks.onFps(fps + 1));
  stepRow.append(minusBtn, value, plusBtn);
  const presets = document.createElement('div');
  presets.className = 'pp-fps-panel__presets';
  const presetBtns = FPS_PRESETS.map((n) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-fps-panel__preset';
    btn.textContent = String(n);
    btn.setAttribute('aria-label', `${n} frames per second`);
    btn.addEventListener('click', () => callbacks.onFps(n));
    presets.appendChild(btn);
    return [n, btn];
  });
  panel.append(title, stepRow, presets);

  function setPanelOpen(open) {
    if (open === panel.isConnected) return;
    if (open) element.appendChild(panel);
    else panel.remove();
    fpsBtn.classList.toggle('is-active', open);
    fpsBtn.setAttribute('aria-expanded', String(open));
  }
  fpsBtn.setAttribute('aria-expanded', 'false');
  document.addEventListener('pointerdown', (event) => {
    if (!panel.isConnected) return;
    if (panel.contains(event.target) || fpsBtn.contains(event.target)) return;
    setPanelOpen(false);
  }, { signal, capture: true });

  // --- "Getting ready" over the canvas ---
  const statusElement = document.createElement('div');
  statusElement.className = 'pp-playback-status';
  statusElement.setAttribute('role', 'status');
  statusElement.hidden = true;

  let fps = 12;

  // state: { playback: 'idle' | 'preparing' | 'playing', ready, total,
  //   fps, loop, canPrev, canNext, busy }
  function render({ playback = 'idle', ready = 0, total = 0, fps: nextFps, loop, canPrev, canNext, busy = false }) {
    fps = nextFps;
    const active = playback !== 'idle';
    playBtn.innerHTML = active ? PAUSE_ICON : PLAY_ICON;
    playBtn.setAttribute('aria-label', active ? 'Pause' : 'Play');
    playBtn.classList.toggle('is-active', active);
    playBtn.disabled = busy && !active;
    // While playing, they stop and step from the frame showing.
    prevBtn.disabled = busy || (!active && !canPrev);
    nextBtn.disabled = busy || (!active && !canNext);
    loopBtn.classList.toggle('is-active', loop);
    loopBtn.setAttribute('aria-pressed', String(loop));
    fpsLabel.textContent = `${fps} fps`;
    value.textContent = String(fps);
    minusBtn.disabled = fps <= MIN_FPS;
    plusBtn.disabled = fps >= MAX_FPS;
    for (const [n, btn] of presetBtns) btn.classList.toggle('is-active', n === fps);

    statusElement.hidden = playback !== 'preparing';
    statusElement.textContent = total > 0 ? `Getting ready… ${ready} of ${total}` : 'Getting ready…';
  }

  return {
    element,
    statusElement,
    render,
    closePanel: () => setPanelOpen(false),
    // The fps panel: open, a canvas tap only closes it (ui.js).
    get isMenuOpen() { return panel.isConnected; },
  };
}

function button(label, icon, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp-transport__btn';
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon;
  btn.addEventListener('click', onClick);
  return btn;
}

function panelButton(label, icon, onClick) {
  const btn = button(label, icon, onClick);
  btn.className = 'pp-fps-panel__btn';
  return btn;
}

const svg = (body) => `
<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${body}</svg>`;

const PLAY_ICON = svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>');
const PAUSE_ICON = svg('<g fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></g>');
// A bar and a triangle: step one frame.
const PREV_ICON = svg('<g fill="currentColor"><rect x="5.5" y="6" width="2.6" height="12" rx="1"/><path d="M18 6.5v11l-8.5-5.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></g>');
const NEXT_ICON = svg('<g fill="currentColor"><rect x="15.9" y="6" width="2.6" height="12" rx="1"/><path d="M6 6.5v11l8.5-5.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></g>');
// Two arrows chasing each other round a loop.
const LOOP_ICON = svg(`<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4.5 11.5v-1a3.5 3.5 0 0 1 3.5-3.5h11"/><path d="M16 4l3 3-3 3"/>
  <path d="M19.5 12.5v1a3.5 3.5 0 0 1-3.5 3.5h-11"/><path d="M8 20l-3-3 3-3"/></g>`);
const MINUS_ICON = svg('<path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>');
const PLUS_ICON = svg('<path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>');
