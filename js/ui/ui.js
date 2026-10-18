// js/ui/ui.js
//
// Owns: tool rail (draw/erase/fill/smudge/brush-size/color/image-
// import/mic/pan), transport controls, project gallery screen, DOM
// glue between the other modules. Custom-styled dialogs only — no
// native confirm()/alert()/date-input/color chrome, per the working
// agreement.
//
// Bare-bones so far: enough of the rail (draw/erase/fill/smudge,
// brush size, color) to drive canvas.js for the drawing-engine
// testing pass. Transport, timeline, gallery, and the rest of the
// tool rail (image-import/mic/pan) land with their respective build
// steps. Color picker itself lives in color-picker.js.

import { initCanvas, MAX_BRUSH_SIZE } from '../canvas/canvas.js';
import { createColorPicker } from './color-picker.js';
import { createSettingsPanel } from './settings-panel.js';

// options.settings: saved tool settings to start from (raw is fine —
//   canvas.applySettings cleans them). Omit for defaults.
// options.onSettingsChange: called after the user changes tool, color
//   or brush size, so main.js can save. Not called for the initial
//   setup.
// options.appActions: for the gear menu — { getVersionLabel,
//   checkForUpdate, applyUpdate, freshReload } (see settings-panel.js).
//   Omitted actions report "unavailable" rather than breaking the UI.
// options.onUndo / options.onRedo: the top-bar buttons.
//
// Returns { canvas, setHistoryState(canUndo, canRedo) }.
export function initUI(container, options = {}) {
  const {
    settings = null,
    onSettingsChange = () => {},
    appActions = {},
    onUndo = () => {},
    onRedo = () => {},
  } = options;
  container.innerHTML = '';

  const shell = document.createElement('div');
  shell.className = 'pp-app-shell';

  // Top bar: full width, and it extends up under the iPad status bar.
  // Keep it dark — the status bar's text is white (black-translucent).
  // Undo/redo for now; Share and the rest of the planned top bar land
  // with their steps.
  const topBar = document.createElement('div');
  topBar.className = 'pp-top-bar';
  const undoBtn = createIconButton('Undo', UNDO_ICON, onUndo);
  const redoBtn = createIconButton('Redo', REDO_ICON, onRedo);
  topBar.append(undoBtn, redoBtn);

  const body = document.createElement('div');
  body.className = 'pp-app-body';

  const rail = document.createElement('div');
  rail.className = 'pp-tool-rail';

  const canvasArea = document.createElement('div');
  canvasArea.className = 'pp-canvas-area';

  body.append(rail, canvasArea);
  shell.append(topBar, body);
  container.appendChild(shell);

  function setHistoryState(canUndo, canRedo) {
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
  }
  setHistoryState(false, false);

  const canvasApi = initCanvas(canvasArea);
  canvasApi.applySettings(settings);
  const startSettings = canvasApi.getSettings();

  const pickTool = (tool) => {
    setActiveTool(tool);
    onSettingsChange();
  };
  const drawBtn = createToolButton('Draw', () => pickTool('draw'));
  const eraseBtn = createToolButton('Erase', () => pickTool('erase'));
  const fillBtn = createToolButton('Fill', () => pickTool('fill'));
  const smudgeBtn = createToolButton('Smudge', () => pickTool('smudge'));
  rail.appendChild(drawBtn);
  rail.appendChild(eraseBtn);
  rail.appendChild(fillBtn);
  rail.appendChild(smudgeBtn);

  // Color swatch — opens the custom picker (canvas/brush.js-style
  // split into its own file, see color-picker.js) as a floating panel
  // rather than native <input type="color"> chrome, per the working
  // agreement.
  const colorSwatch = document.createElement('button');
  colorSwatch.type = 'button';
  colorSwatch.className = 'pp-color-swatch';
  colorSwatch.setAttribute('aria-label', 'Color');
  colorSwatch.style.background = startSettings.color;
  rail.appendChild(colorSwatch);

  const picker = createColorPicker(startSettings.color, (hex) => {
    canvasApi.setColor(hex);
    colorSwatch.style.background = hex;
    onSettingsChange();
  });
  picker.element.classList.add('pp-color-picker--hidden');
  shell.appendChild(picker.element);

  let pickerOpen = false;

  function setPickerOpen(open) {
    pickerOpen = open;
    picker.element.classList.toggle('pp-color-picker--hidden', !open);
    if (open) {
      const rect = colorSwatch.getBoundingClientRect();
      picker.element.style.left = `${rect.right + 8}px`;
      picker.element.style.top = `${rect.top}px`;
    }
  }

  colorSwatch.addEventListener('click', (event) => {
    event.stopPropagation();
    setPickerOpen(!pickerOpen);
  });

  // Tapping anywhere outside the panel (including the canvas) closes
  // it, matching how a floating picker behaves in other apps.
  document.addEventListener('pointerdown', (event) => {
    if (!pickerOpen) return;
    if (picker.element.contains(event.target) || event.target === colorSwatch) return;
    setPickerOpen(false);
  });

  const sizeControl = document.createElement('label');
  sizeControl.className = 'pp-brush-size';
  const sizeText = document.createElement('span');
  sizeText.textContent = 'Size';
  const sizeInput = document.createElement('input');
  sizeInput.type = 'range';
  sizeInput.min = '1';
  sizeInput.max = String(MAX_BRUSH_SIZE);
  // Value is set by setActiveTool() below, from the active tool's
  // remembered size.
  sizeInput.addEventListener('input', () => {
    canvasApi.setBrushSize(Number(sizeInput.value));
    onSettingsChange();
  });
  sizeControl.appendChild(sizeText);
  sizeControl.appendChild(sizeInput);
  rail.appendChild(sizeControl);

  // Gear menu (settings-panel.js) at the bottom of the rail: version,
  // check for updates, and dev tools (including Clear, which is
  // undoable — undo is the safety net, no confirm dialog).
  const gearBtn = document.createElement('button');
  gearBtn.type = 'button';
  gearBtn.className = 'pp-tool-btn pp-tool-btn--secondary pp-gear-btn';
  gearBtn.setAttribute('aria-label', 'Settings');
  gearBtn.innerHTML = GEAR_ICON;
  rail.appendChild(gearBtn);

  const unavailable = async () => 'unsupported';
  const settingsPanel = createSettingsPanel({
    getVersionLabel: appActions.getVersionLabel ?? (async () => 'Unknown'),
    checkForUpdate: appActions.checkForUpdate ?? unavailable,
    applyUpdate: appActions.applyUpdate ?? (async () => window.location.reload()),
    freshReload: appActions.freshReload ?? (async () => window.location.reload()),
    clearDrawing: () => canvasApi.clear(),
  });
  shell.appendChild(settingsPanel.element);

  gearBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (pickerOpen) setPickerOpen(false);
    settingsPanel.setOpen(!settingsPanel.isOpen, gearBtn);
  });

  // Same tap-outside-to-close behavior as the color picker.
  document.addEventListener('pointerdown', (event) => {
    if (!settingsPanel.isOpen) return;
    if (settingsPanel.element.contains(event.target) || gearBtn.contains(event.target)) return;
    settingsPanel.setOpen(false);
  });

  function setActiveTool(tool) {
    canvasApi.setTool(tool);
    drawBtn.classList.toggle('is-active', tool === 'draw');
    eraseBtn.classList.toggle('is-active', tool === 'erase');
    fillBtn.classList.toggle('is-active', tool === 'fill');
    smudgeBtn.classList.toggle('is-active', tool === 'smudge');

    // Each tool remembers its own size (see canvas.js) — sync the
    // slider to whatever the newly active tool last used, rather than
    // leaving it showing the previous tool's value. Fill has no size
    // concept at all, so the control is disabled rather than shown
    // with a meaningless number.
    const size = canvasApi.getBrushSize();
    sizeInput.disabled = size === null;
    sizeControl.classList.toggle('pp-brush-size--disabled', size === null);
    if (size !== null) {
      sizeInput.value = String(size);
    }
  }

  function createToolButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-tool-btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function createIconButton(label, icon, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-icon-btn';
    btn.setAttribute('aria-label', label);
    btn.innerHTML = icon;
    btn.addEventListener('click', onClick);
    return btn;
  }

  setActiveTool(startSettings.tool);

  return { canvas: canvasApi, setHistoryState };
}

// PWA update prompt — shown when a new service worker has installed
// and is waiting to take over. Custom-styled, per the working
// agreement against native confirm()/alert(). Deliberately simple
// for now (styling matches app background, not yet the full toolkit
// look); refine alongside the rest of ui/ once that exists.
export function showUpdatePrompt(onRefresh) {
  // Avoid stacking a second toast if this somehow fires twice.
  if (document.getElementById('pp-update-toast')) return;

  const toast = createToast('pp-update-toast', 'New version available', 'Refresh');
  toast.querySelector('.pp-toast__btn').addEventListener('click', () => {
    toast.remove();
    onRefresh();
  });
  document.body.appendChild(toast);
}

// General-purpose message toast with an OK button (e.g. "couldn't
// save"). Custom-styled, same reasoning as the update prompt. Shows at
// most one at a time — a repeat of the same failure (every stroke while
// the iPad is out of space) updates the text instead of stacking.
export function showNotice(message) {
  const existing = document.getElementById('pp-notice-toast');
  if (existing) {
    existing.querySelector('.pp-toast__text').textContent = message;
    return;
  }
  const toast = createToast('pp-notice-toast', message, 'OK');
  toast.classList.add('pp-toast--notice');
  toast.querySelector('.pp-toast__btn').addEventListener('click', () => toast.remove());
  document.body.appendChild(toast);
}

function createToast(id, message, buttonLabel) {
  const toast = document.createElement('div');
  toast.id = id;
  toast.className = 'pp-toast';
  const text = document.createElement('span');
  text.className = 'pp-toast__text';
  text.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp-toast__btn';
  btn.textContent = buttonLabel;
  toast.append(text, btn);
  return toast;
}

// Undo/redo arrows: a curved shaft and a head, mirrored for redo.
const UNDO_ICON = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <path d="M9 7H15a5 5 0 0 1 0 10H8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M10 2.5 4.5 7 10 11.5Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;
const REDO_ICON = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false" style="transform: scaleX(-1)">
  <path d="M9 7H15a5 5 0 0 1 0 10H8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M10 2.5 4.5 7 10 11.5Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;

// Gear icon, drawn here rather than pulled from an icon set: four bars
// crossed at 45° make the eight teeth, a disc makes the body, and the
// hole is filled with the button's own background color.
const GEAR_ICON = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <g fill="currentColor">
    <rect x="10" y="1.5" width="4" height="21" rx="1"/>
    <rect x="10" y="1.5" width="4" height="21" rx="1" transform="rotate(45 12 12)"/>
    <rect x="10" y="1.5" width="4" height="21" rx="1" transform="rotate(90 12 12)"/>
    <rect x="10" y="1.5" width="4" height="21" rx="1" transform="rotate(135 12 12)"/>
    <circle cx="12" cy="12" r="7.5"/>
  </g>
  <circle cx="12" cy="12" r="3" fill="var(--pp-ink-light)"/>
</svg>`;
