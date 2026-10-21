// js/ui/onion-badge.js
//
// Onion skin's controls (step 4c): a badge in the bottom-left corner
// of the canvas area (the plan's "badge on the canvas"; the layers
// panel covers the right side). Tapping the onion turns ghosts on and
// off; the button beside it opens a small panel above: how many frames
// before and after (0–3 each), the ghosts' opacity, and the color for
// each side.
//
// The badge sits inside the canvas area, which listens for strokes, so
// its own pointer events stop here — a tap on it never draws, and
// never stops playback (it's a setting, like fps).
//
// Pure UI: main.js passes the settings in through render() and gets
// intents back. Inline SVG icons (no symbol characters — iOS may draw
// those as emoji).

import {
  MAX_ONION_FRAMES, MIN_ONION_OPACITY, MAX_ONION_OPACITY, ONION_TINTS,
} from '../timeline/onion.js';

// callbacks: onToggle(), onChange(partial settings) — { before },
//   { after }, { opacity } (while the slider moves), { tintBefore },
//   { tintAfter }.
// options.signal: aborts the document listener (the panel's
//   tap-outside close) when the editor is torn down.
export function createOnionBadge(callbacks, { signal } = {}) {
  const element = document.createElement('div');
  element.className = 'pp-onion-badge';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Onion skin');
  // Keep the canvas area's stroke and playback-stop handling out of it.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    element.addEventListener(type, (event) => event.stopPropagation());
  }

  const toggleBtn = badgeButton('Onion skin', ONION_ICON, () => callbacks.onToggle());
  toggleBtn.classList.add('pp-onion-badge__toggle');
  const settingsBtn = badgeButton('Onion skin settings', SETTINGS_ICON, () => setPanelOpen(!panel.isConnected));
  settingsBtn.setAttribute('aria-haspopup', 'true');
  settingsBtn.setAttribute('aria-expanded', 'false');
  element.append(toggleBtn, settingsBtn);

  // --- the panel ---
  const panel = document.createElement('div');
  panel.className = 'pp-onion-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Onion skin settings');
  const title = document.createElement('div');
  title.className = 'pp-onion-panel__title';
  title.textContent = 'Onion skin';

  let settings = null;

  const beforeRow = stepper('Frames before', 'before');
  const afterRow = stepper('Frames after', 'after');

  const opacityRow = document.createElement('label');
  opacityRow.className = 'pp-onion-panel__opacity';
  const opacityText = document.createElement('span');
  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = String(Math.round(MIN_ONION_OPACITY * 100));
  opacityInput.max = String(Math.round(MAX_ONION_OPACITY * 100));
  opacityInput.step = '5';
  opacityInput.setAttribute('aria-label', 'Onion skin opacity');
  opacityInput.addEventListener('input', () => {
    const opacity = Number(opacityInput.value) / 100;
    opacityText.textContent = `Opacity ${Math.round(opacity * 100)}%`;
    callbacks.onChange({ opacity });
  });
  opacityRow.append(opacityText, opacityInput);

  const beforeTints = tintRow('Before color', 'tintBefore');
  const afterTints = tintRow('After color', 'tintAfter');

  panel.append(title, beforeRow.element, afterRow.element, opacityRow, beforeTints.element, afterTints.element);

  function setPanelOpen(open) {
    if (open === panel.isConnected) return;
    if (open) element.appendChild(panel);
    else panel.remove();
    settingsBtn.classList.toggle('is-active', open);
    settingsBtn.setAttribute('aria-expanded', String(open));
  }
  document.addEventListener('pointerdown', (event) => {
    if (!panel.isConnected) return;
    if (element.contains(event.target)) return;
    setPanelOpen(false);
  }, { signal, capture: true });

  // A "Frames before/after" row: label, −, the number, +.
  function stepper(label, key) {
    const row = document.createElement('div');
    row.className = 'pp-onion-panel__step';
    const text = document.createElement('span');
    text.className = 'pp-onion-panel__label';
    text.textContent = label;
    const minus = panelButton(`Fewer ${label.toLowerCase()}`, MINUS_ICON, () => callbacks.onChange({ [key]: settings[key] - 1 }));
    const value = document.createElement('span');
    value.className = 'pp-onion-panel__value';
    const plus = panelButton(`More ${label.toLowerCase()}`, PLUS_ICON, () => callbacks.onChange({ [key]: settings[key] + 1 }));
    row.append(text, minus, value, plus);
    return {
      element: row,
      render(n) {
        value.textContent = String(n);
        minus.disabled = n <= 0;
        plus.disabled = n >= MAX_ONION_FRAMES;
      },
    };
  }

  // A row of color choices for one side.
  function tintRow(label, key) {
    const row = document.createElement('div');
    row.className = 'pp-onion-panel__tints';
    const text = document.createElement('span');
    text.className = 'pp-onion-panel__label';
    text.textContent = label;
    const swatches = document.createElement('div');
    swatches.className = 'pp-onion-panel__swatches';
    swatches.setAttribute('role', 'radiogroup');
    swatches.setAttribute('aria-label', label);
    const buttons = ONION_TINTS.map(({ hex, name }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pp-onion-panel__swatch';
      btn.style.background = hex;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', `${label}: ${name}`);
      btn.addEventListener('click', () => callbacks.onChange({ [key]: hex }));
      swatches.appendChild(btn);
      return [hex, btn];
    });
    row.append(text, swatches);
    return {
      element: row,
      render(current) {
        for (const [hex, btn] of buttons) {
          const on = hex === current;
          btn.classList.toggle('is-active', on);
          btn.setAttribute('aria-checked', String(on));
        }
      },
    };
  }

  // settings: the project's sanitized onion record (timeline/onion.js).
  function render(next) {
    settings = next;
    toggleBtn.classList.toggle('is-active', next.on);
    toggleBtn.setAttribute('aria-pressed', String(next.on));
    beforeRow.render(next.before);
    afterRow.render(next.after);
    const percent = Math.round(next.opacity * 100);
    if (document.activeElement !== opacityInput) opacityInput.value = String(percent);
    opacityText.textContent = `Opacity ${percent}%`;
    beforeTints.render(next.tintBefore);
    afterTints.render(next.tintAfter);
  }

  return { element, render, closePanel: () => setPanelOpen(false) };
}

function badgeButton(label, icon, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp-onion-badge__btn';
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon;
  btn.addEventListener('click', onClick);
  return btn;
}

function panelButton(label, icon, onClick) {
  const btn = badgeButton(label, icon, onClick);
  btn.className = 'pp-onion-panel__btn';
  return btn;
}

const svg = (body) => `
<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${body}</svg>`;

// Three pages fanned out: the frame she's on, ghosts behind it.
const ONION_ICON = svg(`<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
  <rect x="3" y="3" width="11" height="11" rx="2" opacity="0.45"/>
  <rect x="6.5" y="6.5" width="11" height="11" rx="2" opacity="0.7"/>
  <rect x="10" y="10" width="11" height="11" rx="2" fill="currentColor" fill-opacity="0.25"/></g>`);
// Two sliders with knobs.
const SETTINGS_ICON = svg(`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
  <path d="M4 8h16M4 16h16"/></g><g fill="currentColor">
  <circle cx="9" cy="8" r="2.6"/><circle cx="15" cy="16" r="2.6"/></g>`);
const MINUS_ICON = svg('<path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>');
const PLUS_ICON = svg('<path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>');
