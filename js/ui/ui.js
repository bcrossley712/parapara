// js/ui/ui.js
//
// Owns: the editor screen — top bar, tool rail (draw/erase/fill/
// smudge/brush-size/color; later image-import/mic/pan), transport
// controls — plus toasts and banners, and DOM glue between the other
// modules. The gallery screen is gallery.js. Custom-styled dialogs only — no
// native confirm()/alert()/date-input/color chrome, per the working
// agreement.
//
// Bare-bones so far: enough of the rail (draw/erase/fill/smudge,
// brush size, color) to drive canvas.js for the drawing-engine
// testing pass. Transport, timeline, and the rest of the
// tool rail (image-import/mic/pan) land with their respective build
// steps. Color picker itself lives in color-picker.js.

import { initCanvas, MAX_BRUSH_SIZE } from '../canvas/canvas.js';
import { createColorPicker } from './color-picker.js';
import { attachSettingsMenu } from './settings-panel.js';
import { GEAR_ICON, GALLERY_ICON } from './icons.js';
import { createLayersPanel, LAYERS_ICON } from './layers-panel.js';
import { createFrameStrip } from '../timeline/frame-strip.js';

// options.settings: saved tool settings to start from (raw is fine —
//   canvas.applySettings cleans them). Omit for defaults.
// options.onSettingsChange: called after the user changes tool, color
//   or brush size, so main.js can save. Not called for the initial
//   setup.
// options.appActions: for the gear menu — { getVersionLabel,
//   checkForUpdate, applyUpdate, freshReload } (see settings-panel.js).
//   Omitted actions report "unavailable" rather than breaking the UI.
// options.onUndo / options.onRedo: the top-bar buttons.
// options.layers: callbacks for the layers panel (see layers-panel.js);
//   onOpenChange also fires when the top-bar button toggles it.
// options.layersPanelOpen: open the layers panel at startup.
// options.frames: callbacks for the frame strip ({ onSelect, onAdd },
//   see timeline/frame-strip.js).
// options.onGallery: the top bar's Gallery button. Omit (or null) to
//   leave the button out — when saving doesn't work there's no gallery
//   to go back to.
//
// Returns { canvas, layers (the panel), frames (the strip),
// setHistoryState(canUndo, canRedo), destroy() }. destroy() removes
// the editor and everything it hooked up outside its own elements.
export function initUI(container, options = {}) {
  const {
    settings = null,
    onSettingsChange = () => {},
    appActions = {},
    onUndo = () => {},
    onRedo = () => {},
    layers: layersCallbacks = {},
    layersPanelOpen = false,
    frames: framesCallbacks = {},
    onGallery = null,
  } = options;
  container.innerHTML = '';

  // Every listener outside the editor's own elements (document-level
  // tap-outside handlers) goes through this, so destroy() can remove
  // them all at once.
  const listeners = new AbortController();
  const { signal } = listeners;

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
  const topBarSpacer = document.createElement('div');
  topBarSpacer.className = 'pp-top-bar__spacer';
  const layersBtn = createIconButton('Layers', LAYERS_ICON, () => {
    layersPanel.setOpen(!layersPanel.isOpen);
  });
  if (onGallery) topBar.append(createIconButton('Gallery', GALLERY_ICON, onGallery));
  topBar.append(undoBtn, redoBtn, topBarSpacer, layersBtn);

  const body = document.createElement('div');
  body.className = 'pp-app-body';

  const rail = document.createElement('div');
  rail.className = 'pp-tool-rail';

  const canvasArea = document.createElement('div');
  canvasArea.className = 'pp-canvas-area';

  // The layers panel floats over the right of the canvas area (inside
  // the body, so it sits below the top bar) without resizing it.
  const layersPanel = createLayersPanel({
    onSelect: () => {}, onAdd: () => {}, onDelete: () => {}, onRename: () => {},
    onToggleVisible: () => {}, onToggleLock: () => {}, onMove: () => {},
    onOpacityInput: () => {}, onOpacityCommit: () => {},
    drawThumbnail: (id, target) => canvasApi.drawThumbnail(id, target),
    ...layersCallbacks,
    onOpenChange: (open) => {
      layersBtn.classList.toggle('is-active', open);
      layersBtn.setAttribute('aria-pressed', String(open));
      layersCallbacks.onOpenChange?.(open);
    },
  });
  layersBtn.setAttribute('aria-pressed', 'false');

  // Canvas area above, frame strip below (the transport will sit
  // between them with step 4). The rail runs the full height beside.
  const frameStrip = createFrameStrip({
    onSelect: () => {}, onAdd: () => {}, ...framesCallbacks,
  });
  const stage = document.createElement('div');
  stage.className = 'pp-stage';
  stage.append(canvasArea, frameStrip.element);

  body.append(rail, stage, layersPanel.element);
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
  }, { signal });

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
  const settingsPanel = attachSettingsMenu({
    button: gearBtn,
    container: shell,
    actions: {
      getVersionLabel: appActions.getVersionLabel ?? (async () => 'Unknown'),
      checkForUpdate: appActions.checkForUpdate ?? unavailable,
      applyUpdate: appActions.applyUpdate ?? (async () => window.location.reload()),
      freshReload: appActions.freshReload ?? (async () => window.location.reload()),
      clearDrawing: () => canvasApi.clear(),
      fillAllLayers: appActions.fillAllLayers ?? (() => {}),
    },
    onOpen: () => { if (pickerOpen) setPickerOpen(false); },
    signal,
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

  if (layersPanelOpen) {
    layersPanel.setOpen(true, { notify: false });
    layersBtn.classList.add('is-active');
    layersBtn.setAttribute('aria-pressed', 'true');
  }

  function destroy() {
    listeners.abort();
    settingsPanel.setOpen(false);
    canvasApi.destroy();
    container.innerHTML = '';
  }

  return { canvas: canvasApi, layers: layersPanel, frames: frameStrip, setHistoryState, destroy };
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

// Brief, self-dismissing message for things that aren't problems —
// e.g. "this layer is locked" after a refused stroke. No button, and
// touches pass straight through it, so it never interrupts drawing.
// For real problems (couldn't save) use showNotice, which waits for OK.
// A repeat while it's showing updates the text and restarts the timer.
const BANNER_SHOW_MS = 2000;
const BANNER_FADE_MS = 400;
let bannerTimers = [];

export function showBanner(message) {
  let banner = document.getElementById('pp-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'pp-banner';
    banner.className = 'pp-banner';
    banner.setAttribute('role', 'status');
    document.body.appendChild(banner);
  }
  bannerTimers.forEach(clearTimeout);
  banner.textContent = message;
  banner.classList.remove('pp-banner--fading');
  bannerTimers = [
    setTimeout(() => banner.classList.add('pp-banner--fading'), BANNER_SHOW_MS),
    setTimeout(() => banner.remove(), BANNER_SHOW_MS + BANNER_FADE_MS),
  ];
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
