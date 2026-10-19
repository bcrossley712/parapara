// js/ui/color-picker.js
//
// Custom color picker: a saturation/value square (for the current
// hue), a hue slider, and a hex input — no native
// <input type="color">, same reasoning as the ban on native
// confirm()/alert()/date-input chrome elsewhere: visual consistency
// and control over presentation, not browser/OS chrome. Split into
// its own file rather than living in ui.js — a gradient canvas with
// pointer dragging and hex parsing is a real subsystem, same
// reasoning as canvas/brush.js splitting out of canvas.js.
//
// 2e adds, below the hex field: an eyedropper button, a row of recent
// colors (app-wide, newest first) and the project's palette — up to 10
// swatches in a 2×5 grid, "+" in the first empty slot (Flipaclip's
// swatch strip). Tap a swatch to use it; press and hold for Replace /
// Remove (Flipaclip's long-press replaces).
//
// Talks to the rest of the app only through the callbacks passed into
// createColorPicker — it doesn't know about canvas.js, storage or the
// tool rail. The lists come in through setRecents() / setPalette();
// what to do with an add/replace/remove is main.js's call (colors.js).

import { MAX_RECENTS, MAX_PALETTE } from '../storage/colors.js';

const SV_WIDTH = 252; // px, saturation/value gradient area
const SV_HEIGHT = 160;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const value = parseInt(clean, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function isValidHex(value) {
  return /^#?[0-9a-fA-F]{6}$/.test(value);
}

// callbacks:
//   onChange(hex)           the color changed (square, hue, hex field, or
//                           a recent/palette swatch tapped)
//   onEyedropper()          eyedropper button
//   onPaletteAdd()          "+" — add the current color
//   onPaletteReplace(index) long-press → Replace with the current color
//   onPaletteRemove(index)  long-press → Remove
// Returns { element, setColor(hex), setRecents(list), setPalette(list),
// closeMenu() }.
export function createColorPicker(initialHex, callbacks = {}) {
  const {
    onChange = () => {},
    onEyedropper = () => {},
    onPaletteAdd = () => {},
    onPaletteReplace = () => {},
    onPaletteRemove = () => {},
  } = callbacks;
  const initialRgb = hexToRgb(initialHex);
  let { h, s, v } = rgbToHsv(initialRgb.r, initialRgb.g, initialRgb.b);

  const panel = document.createElement('div');
  panel.className = 'pp-color-picker';

  const svWrap = document.createElement('div');
  svWrap.className = 'pp-color-picker__sv-wrap';
  const svCanvas = document.createElement('canvas');
  svCanvas.width = SV_WIDTH;
  svCanvas.height = SV_HEIGHT;
  svCanvas.className = 'pp-color-picker__sv';
  const svCtx = svCanvas.getContext('2d');
  const svThumb = document.createElement('div');
  svThumb.className = 'pp-color-picker__sv-thumb';
  svWrap.appendChild(svCanvas);
  svWrap.appendChild(svThumb);

  const hueInput = document.createElement('input');
  hueInput.type = 'range';
  hueInput.className = 'pp-color-picker__hue';
  hueInput.min = '0';
  hueInput.max = '360';
  hueInput.step = '1';

  const hexRow = document.createElement('label');
  hexRow.className = 'pp-color-picker__hex-row';
  const hexPrefix = document.createElement('span');
  hexPrefix.textContent = '#';
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'pp-color-picker__hex-input';
  hexInput.maxLength = 6;
  hexInput.autocapitalize = 'off';
  hexInput.autocorrect = 'off';
  hexInput.spellcheck = false;
  hexRow.appendChild(hexPrefix);
  hexRow.appendChild(hexInput);

  const eyedropperBtn = document.createElement('button');
  eyedropperBtn.type = 'button';
  eyedropperBtn.className = 'pp-color-picker__eyedropper';
  eyedropperBtn.setAttribute('aria-label', 'Eyedropper');
  eyedropperBtn.innerHTML = EYEDROPPER_ICON;
  eyedropperBtn.addEventListener('click', () => onEyedropper());

  const fieldRow = document.createElement('div');
  fieldRow.className = 'pp-color-picker__field-row';
  fieldRow.append(hexRow, eyedropperBtn);

  const recentLabel = sectionLabel('Recent');
  const recentRow = document.createElement('div');
  recentRow.className = 'pp-color-picker__recents';
  recentRow.setAttribute('role', 'group');
  recentRow.setAttribute('aria-label', 'Recent colors');

  const paletteLabel = sectionLabel('Palette');
  const paletteGrid = document.createElement('div');
  paletteGrid.className = 'pp-color-picker__palette';
  paletteGrid.setAttribute('role', 'group');
  paletteGrid.setAttribute('aria-label', 'Palette');

  panel.appendChild(svWrap);
  panel.appendChild(hueInput);
  panel.appendChild(fieldRow);
  panel.append(recentLabel, recentRow, paletteLabel, paletteGrid);

  function currentHex() {
    const rgb = hsvToRgb(h, s, v);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  // Two-gradient technique for the SV square: fill with the pure hue,
  // overlay white fading to transparent left-to-right (saturation),
  // overlay black fading in top-to-bottom (value/brightness).
  function renderSV() {
    svCtx.fillStyle = `hsl(${h}, 100%, 50%)`;
    svCtx.fillRect(0, 0, SV_WIDTH, SV_HEIGHT);

    const whiteGrad = svCtx.createLinearGradient(0, 0, SV_WIDTH, 0);
    whiteGrad.addColorStop(0, 'rgba(255,255,255,1)');
    whiteGrad.addColorStop(1, 'rgba(255,255,255,0)');
    svCtx.fillStyle = whiteGrad;
    svCtx.fillRect(0, 0, SV_WIDTH, SV_HEIGHT);

    const blackGrad = svCtx.createLinearGradient(0, 0, 0, SV_HEIGHT);
    blackGrad.addColorStop(0, 'rgba(0,0,0,0)');
    blackGrad.addColorStop(1, 'rgba(0,0,0,1)');
    svCtx.fillStyle = blackGrad;
    svCtx.fillRect(0, 0, SV_WIDTH, SV_HEIGHT);
  }

  function renderThumb() {
    svThumb.style.left = `${s * SV_WIDTH}px`;
    svThumb.style.top = `${(1 - v) * SV_HEIGHT}px`;
  }

  function renderHue() {
    hueInput.value = String(Math.round(h));
  }

  function renderHex() {
    hexInput.value = currentHex().slice(1);
  }

  function renderAll() {
    renderSV();
    renderThumb();
    renderHue();
    renderHex();
  }

  function commit() {
    onChange(currentHex());
  }

  // --- SV square dragging ---
  let svPointerId = null;

  function setSVFromEvent(event) {
    const rect = svCanvas.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);
    s = x / rect.width;
    v = 1 - y / rect.height;
    renderThumb();
    renderHex();
    commit();
  }

  svCanvas.addEventListener('pointerdown', (event) => {
    svPointerId = event.pointerId;
    svCanvas.setPointerCapture(event.pointerId);
    setSVFromEvent(event);
  });
  svCanvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== svPointerId) return;
    setSVFromEvent(event);
  });
  svCanvas.addEventListener('pointerup', (event) => {
    if (event.pointerId !== svPointerId) return;
    if (svCanvas.hasPointerCapture?.(event.pointerId)) {
      svCanvas.releasePointerCapture(event.pointerId);
    }
    svPointerId = null;
  });
  svCanvas.addEventListener('pointercancel', () => {
    svPointerId = null;
  });

  // --- hue slider ---
  hueInput.addEventListener('input', () => {
    h = Number(hueInput.value);
    renderSV();
    renderHex();
    commit();
  });

  // --- hex input ---
  hexInput.addEventListener('change', () => {
    const raw = hexInput.value.trim();
    if (!isValidHex(raw)) {
      // Invalid entry — snap back to the last valid color rather than
      // silently accepting or half-applying a bad value.
      renderHex();
      return;
    }
    const hex = raw.startsWith('#') ? raw : `#${raw}`;
    const rgb = hexToRgb(hex);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    h = hsv.h; s = hsv.s; v = hsv.v;
    renderAll();
    commit();
  });

  function setColor(hex) {
    const rgb = hexToRgb(hex);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    h = hsv.h; s = hsv.s; v = hsv.v;
    renderAll();
  }

  // A swatch tapped: that color, everywhere.
  function useSwatch(hex) {
    setColor(hex);
    onChange(hex);
  }

  // --- recents ---

  function setRecents(list) {
    const swatches = list.slice(0, MAX_RECENTS).map((hex) => {
      const btn = swatchButton(hex, 'pp-color-picker__recent');
      btn.addEventListener('click', () => useSwatch(hex));
      return btn;
    });
    // Empty slots keep the row's shape before she's drawn with much.
    while (swatches.length < MAX_RECENTS) swatches.push(emptySlot('pp-color-picker__recent'));
    recentRow.replaceChildren(...swatches);
  }

  // --- palette ---

  let menu = null;
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  // A tap anywhere else in the picker closes the swatch menu (taps
  // outside close the whole picker, in ui.js).
  panel.addEventListener('pointerdown', (event) => {
    if (menu && !menu.contains(event.target)) closeMenu();
  });

  function openMenu(index, anchor) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'pp-color-picker__menu';
    menu.setAttribute('role', 'menu');
    const item = (label, fn) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pp-color-picker__menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        closeMenu();
        fn();
      });
      return btn;
    };
    menu.append(
      item('Replace', () => onPaletteReplace(index)),
      item('Remove', () => onPaletteRemove(index)),
    );
    panel.appendChild(menu);
    // Just below the swatch, kept inside the panel.
    const panelBox = panel.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    const left = Math.min(box.left - panelBox.left, panel.clientWidth - menu.offsetWidth - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${box.bottom - panelBox.top + 4}px`;
  }

  // Tap = use the color; press and hold (without sliding) = the menu.
  // The hold is timed by hand: iPadOS has no long-press event, and its
  // own (text callout, magnifier) is switched off in CSS.
  function attachPress(btn, index, hex) {
    let timer = null;
    let start = null;
    let held = false;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };
    btn.addEventListener('pointerdown', (event) => {
      held = false;
      start = { x: event.clientX, y: event.clientY };
      cancel();
      timer = setTimeout(() => {
        timer = null;
        held = true;
        openMenu(index, btn);
      }, LONG_PRESS_MS);
    });
    btn.addEventListener('pointermove', (event) => {
      if (!timer || !start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
    });
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('contextmenu', (event) => event.preventDefault());
    btn.addEventListener('click', () => {
      if (held) {
        held = false;
        return;
      }
      useSwatch(hex);
    });
  }

  function setPalette(list) {
    closeMenu();
    const slots = list.slice(0, MAX_PALETTE).map((hex, i) => {
      const btn = swatchButton(hex, 'pp-color-picker__swatch');
      attachPress(btn, i, hex);
      return btn;
    });
    if (slots.length < MAX_PALETTE) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'pp-color-picker__swatch pp-color-picker__swatch--add';
      add.setAttribute('aria-label', 'Add color to palette');
      add.innerHTML = PLUS_ICON;
      add.addEventListener('click', () => onPaletteAdd());
      slots.push(add);
    }
    while (slots.length < MAX_PALETTE) slots.push(emptySlot('pp-color-picker__swatch'));
    paletteGrid.replaceChildren(...slots);
  }

  setRecents([]);
  setPalette([]);
  renderAll();

  return {
    element: panel,
    setColor,
    setRecents,
    setPalette,
    closeMenu,
  };
}

function sectionLabel(text) {
  const label = document.createElement('div');
  label.className = 'pp-color-picker__label';
  label.textContent = text;
  return label;
}

function swatchButton(hex, className) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.style.background = hex;
  btn.dataset.color = hex;
  btn.setAttribute('aria-label', `Color ${hex}`);
  return btn;
}

function emptySlot(className) {
  const slot = document.createElement('div');
  slot.className = `${className} ${className}--empty`;
  slot.setAttribute('aria-hidden', 'true');
  return slot;
}

const PLUS_ICON = `
<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
  <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;

// Exported for the rail swatch's "armed" badge (ui.js).
export const EYEDROPPER_ICON = `
<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
  <path d="M15.5 3.5a2.6 2.6 0 0 1 3.7 3.7l-2.1 2.1.9.9a1 1 0 0 1-1.4 1.4l-.9-.9-7.6 7.6-3.4.9a.8.8 0 0 1-1-1l.9-3.4 7.6-7.6-.9-.9a1 1 0 0 1 1.4-1.4l.9.9Z" fill="currentColor"/>
</svg>`;
