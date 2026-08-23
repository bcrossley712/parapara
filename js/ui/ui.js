// js/ui/ui.js
//
// Owns: tool rail (draw/erase/fill/smudge/brush-size/image-import/
// mic/pan), transport controls, project gallery screen, DOM glue
// between the other modules. Custom-styled dialogs only — no native
// confirm()/alert()/date-input chrome, per the working agreement.
//
// Bare-bones so far: just enough of the rail (draw/erase/brush size)
// to drive canvas.js for the drawing-engine testing pass. Transport,
// timeline, gallery, and the rest of the tool rail (fill/smudge/
// image-import/mic/pan) land with their respective build steps.

import { initCanvas, MAX_BRUSH_SIZE } from '../canvas/canvas.js';

export function initUI(container) {
  container.innerHTML = '';

  const shell = document.createElement('div');
  shell.className = 'pp-app-shell';

  const rail = document.createElement('div');
  rail.className = 'pp-tool-rail';

  const canvasArea = document.createElement('div');
  canvasArea.className = 'pp-canvas-area';

  shell.appendChild(rail);
  shell.appendChild(canvasArea);
  container.appendChild(shell);

  const canvasApi = initCanvas(canvasArea);

  const drawBtn = createToolButton('Draw', () => setActiveTool('draw'));
  const eraseBtn = createToolButton('Erase', () => setActiveTool('erase'));
  const fillBtn = createToolButton('Fill', () => setActiveTool('fill'));
  const smudgeBtn = createToolButton('Smudge', () => setActiveTool('smudge'));
  rail.appendChild(drawBtn);
  rail.appendChild(eraseBtn);
  rail.appendChild(fillBtn);
  rail.appendChild(smudgeBtn);

  const sizeControl = document.createElement('label');
  sizeControl.className = 'pp-brush-size';
  const sizeText = document.createElement('span');
  sizeText.textContent = 'Size';
  const sizeInput = document.createElement('input');
  sizeInput.type = 'range';
  sizeInput.min = '1';
  sizeInput.max = String(MAX_BRUSH_SIZE);
  sizeInput.value = '6';
  sizeInput.addEventListener('input', () => {
    canvasApi.setBrushSize(Number(sizeInput.value));
  });
  sizeControl.appendChild(sizeText);
  sizeControl.appendChild(sizeInput);
  rail.appendChild(sizeControl);

  // Dev-testing convenience for this pass, not a real "new project"
  // feature — no confirmation dialog since there's nothing durable to
  // lose yet (no storage/ until step 2).
  const clearBtn = createToolButton('Clear', () => canvasApi.clear());
  clearBtn.classList.add('pp-tool-btn--secondary');
  rail.appendChild(clearBtn);

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

  setActiveTool('draw');

  return canvasApi;
}

// PWA update prompt — shown when a new service worker has installed
// and is waiting to take over. Custom-styled, per the working
// agreement against native confirm()/alert(). Deliberately simple
// for now (styling matches app background, not yet the full toolkit
// look); refine alongside the rest of ui/ once that exists.
export function showUpdatePrompt(onRefresh) {
  // Avoid stacking a second toast if this somehow fires twice.
  if (document.getElementById('pp-update-toast')) return;

  const toast = document.createElement('div');
  toast.id = 'pp-update-toast';
  toast.className = 'pp-update-toast';
  toast.innerHTML = `
    <span class="pp-update-toast__text">New version available</span>
    <button type="button" class="pp-update-toast__btn">Refresh</button>
  `;

  toast.querySelector('.pp-update-toast__btn').addEventListener('click', () => {
    toast.remove();
    onRefresh();
  });

  document.body.appendChild(toast);
}
