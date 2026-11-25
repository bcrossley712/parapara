// js/ui/shape-panel.js
//
// The rail's Shape button and its small panel (8d): Line, Rectangle,
// Oval, Triangle, and a Perfect switch (square, circle, 45° lines, an
// even-sided triangle — no Shift key on an iPad). The button names the
// current shape under its label, as Draw names its tip. As with Draw,
// the first tap picks the tool and a tap on the current tool opens the
// panel (ui.js decides which); picking a shape closes it, the switch
// doesn't. Shapes draw with Draw's tip, size, strength and color, so
// there's nothing else to set here.
//
// Pure UI: ui.js passes the state in with render(); picks come back
// through onShape(name) and onPerfect(on).

import { SHAPES, SHAPE_LABELS } from '../canvas/shapes.js';

// options.container: the element the panel is positioned in.
// options.signal: aborts the tap-outside listener on teardown.
export function createShapePanel({ onShape, onPerfect, container, signal }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pp-tool-btn pp-tool-btn--tipped pp-shape-btn';
  button.setAttribute('aria-label', 'Shape');
  const label = document.createElement('span');
  label.textContent = 'Shape';
  const name = document.createElement('span');
  name.className = 'pp-tool-btn__tip';
  button.append(label, name);

  let state = { shape: 'line', perfect: false };
  let panel = null;

  function close() {
    panel?.remove();
    panel = null;
    button.classList.remove('is-open');
  }

  function open() {
    close();
    panel = document.createElement('div');
    panel.className = 'pp-shape-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Shapes');
    for (const key of SHAPES) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pp-frame-menu__item pp-shape-panel__item';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(key === state.shape));
      item.classList.toggle('is-current', key === state.shape);
      item.dataset.shape = key;
      const icon = document.createElement('span');
      icon.className = 'pp-shape-panel__icon';
      icon.innerHTML = ICONS[key];
      const text = document.createElement('span');
      text.textContent = SHAPE_LABELS[key];
      item.append(icon, text);
      item.addEventListener('click', () => {
        close();
        onShape(key);
      });
      panel.appendChild(item);
    }

    const row = document.createElement('div');
    row.className = 'pp-shape-panel__perfect';
    const rowLabel = document.createElement('span');
    rowLabel.id = 'pp-shape-perfect-label';
    rowLabel.textContent = 'Perfect';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'pp-switch pp-shape-panel__switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-labelledby', rowLabel.id);
    toggle.setAttribute('aria-checked', String(state.perfect));
    toggle.appendChild(document.createElement('span')).className = 'pp-switch__knob';
    toggle.addEventListener('click', () => onPerfect(!state.perfect));
    row.append(rowLabel, toggle);
    panel.appendChild(row);

    container.appendChild(panel);
    const box = container.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    panel.style.left = `${b.right - box.left + 8}px`;
    const bottomLimit = box.height - panel.offsetHeight - 8;
    panel.style.top = `${Math.max(8, Math.min(b.top - box.top, bottomLimit))}px`;
    button.classList.add('is-open');
  }

  // A tap anywhere but the panel or the button (ui.js handles the
  // button's taps) closes it.
  document.addEventListener('pointerdown', (event) => {
    if (!panel || panel.contains(event.target) || button.contains(event.target)) return;
    close();
  }, { signal, capture: true });

  // { shape, perfect }. An open panel updates in place.
  function render(next) {
    state = { shape: next.shape, perfect: next.perfect === true };
    name.textContent = SHAPE_LABELS[state.shape] ?? SHAPE_LABELS.line;
    if (!panel) return;
    for (const item of panel.querySelectorAll('.pp-shape-panel__item')) {
      const current = item.dataset.shape === state.shape;
      item.classList.toggle('is-current', current);
      item.setAttribute('aria-checked', String(current));
    }
    panel.querySelector('.pp-shape-panel__switch').setAttribute('aria-checked', String(state.perfect));
  }

  return {
    button,
    render,
    open,
    close,
    // Open panels make a canvas tap only close them (ui.js).
    get isOpen() { return panel !== null; },
  };
}

// Outlines of each shape, currentColor, as the canvas draws them.
const svg = (body) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"
  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  line: svg('<path d="M5 19L19 5"/>'),
  rect: svg('<rect x="4" y="6" width="16" height="12" rx="0.5"/>'),
  oval: svg('<ellipse cx="12" cy="12" rx="8.5" ry="6"/>'),
  triangle: svg('<path d="M12 5L20 19H4Z"/>'),
};
