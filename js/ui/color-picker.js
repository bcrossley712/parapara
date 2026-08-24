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
// Talks to the rest of the app only through the onChange(hex)
// callback passed into createColorPicker — it doesn't know about
// canvas.js or the tool rail.

const SV_SIZE = 160; // px, square gradient area

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

export function createColorPicker(initialHex, onChange) {
  const initialRgb = hexToRgb(initialHex);
  let { h, s, v } = rgbToHsv(initialRgb.r, initialRgb.g, initialRgb.b);

  const panel = document.createElement('div');
  panel.className = 'pp-color-picker';

  const svWrap = document.createElement('div');
  svWrap.className = 'pp-color-picker__sv-wrap';
  const svCanvas = document.createElement('canvas');
  svCanvas.width = SV_SIZE;
  svCanvas.height = SV_SIZE;
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

  panel.appendChild(svWrap);
  panel.appendChild(hueInput);
  panel.appendChild(hexRow);

  function currentHex() {
    const rgb = hsvToRgb(h, s, v);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  // Two-gradient technique for the SV square: fill with the pure hue,
  // overlay white fading to transparent left-to-right (saturation),
  // overlay black fading in top-to-bottom (value/brightness).
  function renderSV() {
    svCtx.fillStyle = `hsl(${h}, 100%, 50%)`;
    svCtx.fillRect(0, 0, SV_SIZE, SV_SIZE);

    const whiteGrad = svCtx.createLinearGradient(0, 0, SV_SIZE, 0);
    whiteGrad.addColorStop(0, 'rgba(255,255,255,1)');
    whiteGrad.addColorStop(1, 'rgba(255,255,255,0)');
    svCtx.fillStyle = whiteGrad;
    svCtx.fillRect(0, 0, SV_SIZE, SV_SIZE);

    const blackGrad = svCtx.createLinearGradient(0, 0, 0, SV_SIZE);
    blackGrad.addColorStop(0, 'rgba(0,0,0,0)');
    blackGrad.addColorStop(1, 'rgba(0,0,0,1)');
    svCtx.fillStyle = blackGrad;
    svCtx.fillRect(0, 0, SV_SIZE, SV_SIZE);
  }

  function renderThumb() {
    svThumb.style.left = `${s * SV_SIZE}px`;
    svThumb.style.top = `${(1 - v) * SV_SIZE}px`;
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

  renderAll();

  return {
    element: panel,
    setColor(hex) {
      const rgb = hexToRgb(hex);
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      h = hsv.h; s = hsv.s; v = hsv.v;
      renderAll();
    },
  };
}
