// js/ui/ui.js
//
// Owns: the editor screen — top bar (Gallery, undo/redo, Image,
// Layers), tool rail (draw/erase/fill/smudge/brush-size/color; later
// mic/pan), transport controls — plus toasts and banners, and DOM
// glue between the other
// modules. The gallery screen is gallery.js. Custom-styled dialogs only — no
// native confirm()/alert()/date-input/color chrome, per the working
// agreement.
//
// The rail so far: draw/erase/fill/smudge, brush size, color; the rest
// (mic/pan) lands with its build step. The color picker lives in
// color-picker.js, the frame strip and transport in timeline/.

import { initCanvas, MAX_BRUSH_SIZE } from '../canvas/canvas.js';
import { createColorPicker, EYEDROPPER_ICON } from './color-picker.js';
import { attachSettingsMenu } from './settings-panel.js';
import { GEAR_ICON, GALLERY_ICON } from './icons.js';
import { createLayersPanel, LAYERS_ICON } from './layers-panel.js';
import { createFrameStrip } from '../timeline/frame-strip.js';
import { createTransport } from '../timeline/transport.js';
import { createReferenceBar } from './reference-bar.js';
import { createImageMenu } from './image-menu.js';
import { createSoundPanel } from './sound-panel.js';
import { createOnionBadge } from './onion-badge.js';

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
// options.frames: callbacks for the frame strip ({ onSelect, onAdd,
//   onDuplicate },
//   see timeline/frame-strip.js).
// options.transport: playback intents ({ onPlay, onPrev, onNext,
//   onLoop, onFps }, see timeline/transport.js).
// options.colors: palette intents from the color picker
//   ({ onPaletteAdd(hex), onPaletteReplace(index, hex),
//   onPaletteRemove(index) } — hex is the current color).
// options.images: the top bar's Image menu intents ({ onImage,
//   onUseOnAllFrames, onToggleImages }, see image-menu.js).
// options.sound: the Sound button's panel intents ({ onImport,
//   onDelete, onChange(clip), onPlayingTouch }, see sound-panel.js;
//   step 5).
// options.reference: the adjust-image bar's intents ({ onOpacityInput,
//   onFlip, onReplace, onDelete, onDone }, see reference-bar.js). onDone also
//   fires when she taps any other control while adjusting.
// options.onion: the onion-skin badge's intents ({ onToggle,
//   onChange(partial) }, see onion-badge.js).
// options.onGallery: the top bar's Gallery button. Omit (or null) to
//   leave the button out — when saving doesn't work there's no gallery
//   to go back to.
//
// Returns { canvas, layers (the panel), frames (the strip), transport
// (render(state)), onion (the badge: render(settings)), images
// (the top bar's Image menu: render(state)), sound (the sound panel:
// render(state), setPlayhead(index)), pickAudio(onFile),
// setHistoryState(canUndo, canRedo), setRecentColors(list),
// setPalette(list), pickImage(onFile), setAdjusting(on, opacity),
// setAdjustBusy(busy) (the adjust bar's controls off while a photo is
// being prepared),
// destroy() }. destroy() removes
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
    transport: transportCallbacks = {},
    colors: colorCallbacks = {},
    reference: referenceCallbacks = {},
    images: imagesCallbacks = {},
    sound: soundCallbacks = {},
    onion: onionCallbacks = {},
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
  // A tap on the canvas while a menu or popover is open only closes it
  // (Procreate's way) — no stroke, fill or pick; fingers joining it are
  // ignored too (canvas.js dismissTouch). Registered before the menus'
  // own tap-outside listeners, so it sees them still open. Panels she
  // works with open (layers, sound) don't count; controls inside the
  // canvas area (sound panel, onion badge) handle their own taps.
  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !canvasArea.contains(target)) return;
    if (target.closest('.pp-sound-panel, .pp-onion-badge')) return;
    if (!anyMenuOpen()) return;
    canvasApi.dismissTouch(event.pointerId);
  }, { signal, capture: true });

  function anyMenuOpen() {
    return pickerOpen
      || settingsPanel.isOpen
      || imageMenu.isMenuOpen
      || layersPanel.isMenuOpen
      || frameStrip.isMenuOpen
      || onionBadge.isMenuOpen
      || transport.isMenuOpen;
  }

  const topBar = document.createElement('div');
  topBar.className = 'pp-top-bar';
  const undoBtn = createIconButton('Undo', UNDO_ICON, onUndo);
  const redoBtn = createIconButton('Redo', REDO_ICON, onRedo);
  const topBarSpacer = document.createElement('div');
  topBarSpacer.className = 'pp-top-bar__spacer';
  const layersBtn = createIconButton('Layers', LAYERS_ICON, () => {
    layersPanel.setOpen(!layersPanel.isOpen);
  });
  // Image (3a): the reference image's one home, beside Layers.
  const imageMenu = createImageMenu({
    onImage: () => {}, onUseOnAllFrames: () => {}, onToggleImages: () => {}, ...imagesCallbacks,
  }, { container: shell, signal });
  if (onGallery) topBar.append(createIconButton('Gallery', GALLERY_ICON, onGallery));
  topBar.append(undoBtn, redoBtn, topBarSpacer, imageMenu.button, layersBtn);

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
  }, { signal });
  layersBtn.setAttribute('aria-pressed', 'false');

  // Canvas area above, frame strip below with the transport at its
  // left end (4b). The rail runs the full height beside.
  const frameStrip = createFrameStrip({
    onSelect: () => {}, onAdd: () => {}, onDuplicate: () => {}, ...framesCallbacks,
  }, { signal });
  const transport = createTransport({
    onPlay: () => {}, onPrev: () => {}, onNext: () => {}, onLoop: () => {}, onFps: () => {},
    ...transportCallbacks,
  }, { signal });
  frameStrip.element.prepend(transport.element);
  canvasArea.appendChild(transport.statusElement);
  // Onion skin's badge (4c): bottom-left of the canvas area.
  const onionBadge = createOnionBadge({
    onToggle: () => {}, onChange: () => {}, ...onionCallbacks,
  }, { signal });
  canvasArea.appendChild(onionBadge.element);
  // Sound (step 5): the button beside Image opens the sound panel (5b)
  // over the bottom of the canvas area, its track lined up with the
  // tiles. While it's open the onion badge and "Getting ready" sit
  // above it, and the layers panel stops short of it.
  const soundPanel = createSoundPanel({
    onImport: () => {}, onDelete: () => {}, onChange: () => {}, ...soundCallbacks,
    onOpenChange: (open) => {
      canvasArea.classList.toggle('has-sound-panel', open);
      fitLayersPanel();
    },
  }, { container: canvasArea, timeline: frameStrip.timeline, signal });
  imageMenu.button.before(soundPanel.button);
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
    setEyedropperArmed(false); // picking a tool cancels the eyedropper
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
  const swatchBadge = document.createElement('span');
  swatchBadge.className = 'pp-color-swatch__badge';
  swatchBadge.innerHTML = EYEDROPPER_ICON;
  colorSwatch.appendChild(swatchBadge);
  rail.appendChild(colorSwatch);

  const currentColor = () => canvasApi.getSettings().color;
  const picker = createColorPicker(startSettings.color, {
    onChange: (hex) => {
      canvasApi.setColor(hex);
      colorSwatch.style.background = hex;
      onSettingsChange();
    },
    onEyedropper: () => {
      setPickerOpen(false);
      setEyedropperArmed(!canvasApi.isEyedropperArmed());
    },
    onPaletteAdd: () => colorCallbacks.onPaletteAdd?.(currentColor()),
    onPaletteReplace: (index) => colorCallbacks.onPaletteReplace?.(index, currentColor()),
    onPaletteRemove: (index) => colorCallbacks.onPaletteRemove?.(index),
  });

  // Eyedropper (canvas.js has the mechanics): armed from the picker,
  // the rail swatch wears a badge and previews the color under her
  // finger; a pick sets the color like any other change, and the tool
  // she had is still the tool.
  function setEyedropperArmed(armed) {
    canvasApi.setEyedropper(armed);
    colorSwatch.classList.toggle('is-picking', armed);
    colorSwatch.setAttribute('aria-label', armed ? 'Color (picking from canvas)' : 'Color');
    if (!armed) colorSwatch.style.background = currentColor();
    else showBanner('Tap the canvas to pick a color.');
  }
  canvasApi.onEyedropper(({ type, hex }) => {
    if (type === 'preview') {
      colorSwatch.style.background = hex;
    } else if (type === 'preview-end') {
      colorSwatch.style.background = currentColor();
    } else if (type === 'pick') {
      canvasApi.setColor(hex);
      picker.setColor(hex);
      setEyedropperArmed(false);
      onSettingsChange();
    }
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
      // Beside the swatch, but moved up if it would run off the bottom
      // (it's taller since 2e's recents and palette).
      const bottomLimit = window.innerHeight - picker.element.offsetHeight - 8;
      picker.element.style.top = `${Math.max(8, Math.min(rect.top, bottomLimit))}px`;
    } else {
      picker.closeMenu();
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
    if (picker.element.contains(event.target) || colorSwatch.contains(event.target)) return;
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
  // check for updates, and (temporary) dev tools.
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
      fillAllLayers: appActions.fillAllLayers ?? (() => {}),
      playbackSpeedTest: appActions.playbackSpeedTest ?? (() => {}),
      frameMemoryTest: appActions.frameMemoryTest ?? (() => {}),
      showActivityLog: appActions.showActivityLog, // dev only (after 4b)
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

  // --- reference image (3a) ---

  // The photo picker: the one native picker the app uses, because
  // iPadOS has no other way into Photos (see PROJECT_NOTES.md). Hidden;
  // pickImage() must be called inside a tap.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.className = 'pp-file-input';
  fileInput.hidden = true;
  shell.appendChild(fileInput);
  let onPicked = null;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0] ?? null;
    const handler = onPicked;
    onPicked = null;
    fileInput.value = '';
    if (file && handler) handler(file);
  });
  function pickImage(onFile) {
    onPicked = onFile;
    fileInput.value = '';
    fileInput.click();
  }

  // The sound picker (step 5): the second native picker — iPadOS has no
  // other way into Files. Same rules: hidden, and pickAudio() must be
  // called inside a tap. Whether the file is sound the iPad can play is
  // decided by decoding it, not by `accept`.
  //
  // `accept` lists extensions, never `audio/*`: iOS treats `audio/*`
  // like `video/*` and shows Photo Library / Take Video / Choose File
  // (seen on her iPad); a list of plain extensions should open Files
  // directly. Files with other extensions are greyed out in the picker
  // — add one here if she needs it and Safari can decode it.
  const audioInput = document.createElement('input');
  audioInput.type = 'file';
  audioInput.accept = SOUND_FILE_TYPES;
  audioInput.className = 'pp-file-input pp-file-input--audio';
  audioInput.hidden = true;
  shell.appendChild(audioInput);
  let onAudioPicked = null;
  audioInput.addEventListener('change', () => {
    const file = audioInput.files?.[0] ?? null;
    const handler = onAudioPicked;
    onAudioPicked = null;
    audioInput.value = '';
    if (file && handler) handler(file);
  });
  function pickAudio(onFile) {
    onAudioPicked = onFile;
    audioInput.value = '';
    audioInput.click();
  }

  const referenceBar = createReferenceBar({
    onOpacityInput: () => {}, onFlip: () => {}, onReplace: () => {}, onDelete: () => {},
    onDone: () => {},
    ...referenceCallbacks,
  });
  let adjustingOn = false;

  // Adjust mode: the bar takes the rail's place. Tapping any control
  // outside the bar and the canvas commits, as Done does — and the
  // control still does its own thing (Procreate's transform). Disabled
  // buttons (undo/redo while adjusting) don't count.
  //
  // Buttons commit on click, in the capture phase: the commit may
  // re-render the frame strip, and a tile replaced between pointerdown
  // and pointerup would never get its click. A slider (layer opacity)
  // never clicks, so it commits as soon as it's touched.
  function setAdjusting(on, opacity = 1) {
    if (on === adjustingOn) {
      if (on) referenceBar.setOpacity(opacity);
      return;
    }
    adjustingOn = on;
    if (on) {
      setEyedropperArmed(false);
      setPickerOpen(false);
      referenceBar.setOpacity(opacity);
      body.insertBefore(referenceBar.element, rail);
    } else {
      referenceBar.element.remove();
    }
    rail.classList.toggle('is-hidden', on);
  }
  function commitOnOutsideTap(event) {
    if (!adjustingOn) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (referenceBar.element.contains(target) || canvasArea.contains(target)) return;
    if (target.closest('button:disabled, input:disabled')) return;
    const isInput = target.closest('input, textarea') !== null;
    if ((event.type === 'pointerdown') !== isInput) return;
    referenceCallbacks.onDone?.();
  }
  document.addEventListener('pointerdown', commitOnOutsideTap, { signal, capture: true });
  document.addEventListener('click', commitOnOutsideTap, { signal, capture: true });

  // With the sound panel open, the layers panel ends above it.
  function fitLayersPanel() {
    if (!soundPanel.isOpen) {
      layersPanel.element.style.maxHeight = '';
      return;
    }
    const room = soundPanel.element.getBoundingClientRect().top - body.getBoundingClientRect().top - 16;
    layersPanel.element.style.maxHeight = `${Math.max(120, room)}px`;
  }
  const bodyResize = new ResizeObserver(() => fitLayersPanel());
  bodyResize.observe(body);
  signal.addEventListener('abort', () => bodyResize.disconnect());

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

  return {
    canvas: canvasApi,
    layers: layersPanel,
    frames: frameStrip,
    transport,
    onion: onionBadge,
    images: imageMenu,
    sound: soundPanel,
    setHistoryState,
    setRecentColors: (list) => picker.setRecents(list),
    setPalette: (list) => picker.setPalette(list),
    pickImage,
    pickAudio,
    setAdjusting,
    setAdjustBusy: (busy) => referenceBar.setBusy(busy),
    destroy,
  };
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

// The sound picker's `accept` (step 5): extensions only, so iOS opens
// Files instead of its photo/video menu. Covers mp3, AAC/m4a (Voice
// Memos, iTunes, Amazon), WAV, AIFF and CAF (GarageBand).
export const SOUND_FILE_TYPES = '.mp3,.m4a,.aac,.wav,.aif,.aiff,.caf';

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
