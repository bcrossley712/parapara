// js/ui/brush-panel.js
//
// The brush panel (8b-ii): opened by tapping the Draw or Erase button
// when it's already the tool (as the current frame tile opens its
// menu). Tips with a sample stroke each, then Size (with the number),
// Strength and Stabilizer — Flipaclip keeps these in its brush
// settings. It opens to the right of the button, like the color
// picker, and closes on a tap anywhere else.
//
// Pure UI: ui.js reads the canvas's settings into render(state) and
// gets changes back through the callbacks. Every change applies from
// the next stroke.

import { TIPS, TIP_LABELS, MIN_STRENGTH, MAX_STRENGTH, drawTipSample } from '../canvas/brush.js';
import { MAX_STABILIZER } from '../canvas/stabilizer.js';
import { sliderToSize, sizeToSlider, SIZE_SLIDER_STEPS } from '../canvas/size-curve.js';

const TOOL_TITLES = { draw: 'Draw brush', erase: 'Erase brush' };

// Sample strokes: CSS size, drawn at 2× for the iPad's screen.
const SAMPLE_W = 96;
const SAMPLE_H = 30;
const SAMPLE_SCALE = 2;
// The sample's ink. Erase's samples show the shape it takes away, in
// the same dark ink (there's nothing to erase in a sample).
const ERASE_SAMPLE_COLOR = '#2b2b2b';

// options: { container, signal, maxSize, onTip(name), onSize(px),
// onStrength(percent), onStabilizer(value) }.
export function createBrushPanel({ container, signal, maxSize, onTip, onSize, onStrength, onStabilizer }) {
  const panel = document.createElement('div');
  panel.className = 'pp-brush-panel';
  panel.setAttribute('role', 'dialog');
  panel.hidden = true;

  const title = document.createElement('div');
  title.className = 'pp-brush-panel__title';
  panel.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'pp-brush-panel__tips';
  panel.appendChild(grid);

  const tipButtons = new Map(); // name → { button, canvas }
  for (const name of TIPS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pp-brush-panel__tip';
    button.dataset.tip = name;
    button.setAttribute('aria-label', TIP_LABELS[name]);
    const canvas = document.createElement('canvas');
    canvas.className = 'pp-brush-panel__sample';
    canvas.width = SAMPLE_W * SAMPLE_SCALE;
    canvas.height = SAMPLE_H * SAMPLE_SCALE;
    canvas.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = TIP_LABELS[name];
    button.append(canvas, label);
    button.addEventListener('click', () => onTip(name));
    grid.appendChild(button);
    tipButtons.set(name, { button, canvas });
  }

  function slider(className, min, max) {
    const wrap = document.createElement('label');
    wrap.className = `pp-brush-panel__slider ${className}`;
    const text = document.createElement('span');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    wrap.append(text, input);
    panel.appendChild(wrap);
    return { text, input };
  }

  // Size is on the same curve as the rail's slider (size-curve.js).
  const size = slider('pp-brush-panel__size', 0, SIZE_SLIDER_STEPS);
  const strength = slider('pp-brush-panel__strength', MIN_STRENGTH, MAX_STRENGTH);
  const stabilizer = slider('pp-brush-panel__stabilizer', 0, MAX_STABILIZER);

  function showSize(px) {
    size.text.textContent = `Size ${px}`;
    size.input.setAttribute('aria-valuetext', String(px));
  }
  function showStrength(percent) {
    strength.text.textContent = `Strength ${percent}%`;
    strength.input.setAttribute('aria-valuetext', `${percent}%`);
  }
  function showStabilizer(value) {
    stabilizer.text.textContent = value === 0 ? 'Stabilizer off' : `Stabilizer ${value}`;
  }

  size.input.addEventListener('input', () => {
    const px = sliderToSize(Number(size.input.value), maxSize);
    showSize(px);
    onSize(px);
  });
  strength.input.addEventListener('input', () => {
    const percent = Number(strength.input.value);
    showStrength(percent);
    onStrength(percent);
  });
  stabilizer.input.addEventListener('input', () => {
    const value = Number(stabilizer.input.value);
    showStabilizer(value);
    onStabilizer(value);
  });

  container.appendChild(panel);

  let anchor = null; // the tool button it opened from
  let state = null;

  // state: { tool, tip, size, strength, stabilizer, color,
  // tipStrength(name) }.
  function render(next) {
    state = next;
    if (panel.hidden || !state) return;
    title.textContent = TOOL_TITLES[state.tool] ?? '';
    const ink = state.tool === 'erase' ? ERASE_SAMPLE_COLOR : state.color;
    for (const [name, { button, canvas }] of tipButtons) {
      const current = name === state.tip;
      button.classList.toggle('is-current', current);
      button.setAttribute('aria-pressed', String(current));
      drawTipSample(canvas, name, {
        color: ink,
        strength: state.tipStrength(name),
        size: name === 'pencil' || name === 'pen' ? 8 * SAMPLE_SCALE : 18 * SAMPLE_SCALE,
      });
    }
    size.input.value = String(sizeToSlider(state.size, maxSize));
    showSize(state.size);
    strength.input.value = String(state.strength);
    showStrength(state.strength);
    stabilizer.input.value = String(state.stabilizer);
    showStabilizer(state.stabilizer);
  }

  function position() {
    const box = container.getBoundingClientRect();
    const b = anchor.getBoundingClientRect();
    panel.style.left = `${b.right - box.left + 8}px`;
    const bottomLimit = box.height - panel.offsetHeight - 8;
    panel.style.top = `${Math.max(8, Math.min(b.top - box.top, bottomLimit))}px`;
  }

  function open(button, next) {
    anchor = button;
    panel.hidden = false;
    anchor.classList.add('is-open');
    render(next);
    position();
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    anchor?.classList.remove('is-open');
    anchor = null;
  }

  // A tap anywhere but the panel or its own button (whose click toggles
  // it) closes it.
  document.addEventListener('pointerdown', (event) => {
    if (panel.hidden) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (panel.contains(target) || anchor?.contains(target)) return;
    close();
  }, { signal, capture: true });

  return {
    element: panel,
    open,
    close,
    render,
    get isOpen() { return !panel.hidden; },
    get anchor() { return anchor; },
  };
}
