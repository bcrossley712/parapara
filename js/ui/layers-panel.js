// js/ui/layers-panel.js
//
// The layers panel: floats over the right side of the canvas area
// (doesn't shrink the canvas), opened from the top bar's Layers button.
// Like Sketchbook/Procreate/Flipaclip: top layer listed first, each row
// with a thumbnail, name, visibility and lock toggles and a drag handle;
// tap a row to make it the active layer. Below the list, the active
// layer's opacity, Rename and Delete.
//
// Pure UI: knows nothing about storage, history or the canvas. main.js
// passes state in through render() and gets intents back through the
// callbacks. Custom controls only (no prompt()/confirm()) — rename is
// an inline text field; delete is undoable, so there's no confirm.

// callbacks:
//   onSelect(id), onAdd(), onDelete(id), onRename(id, name),
//   onToggleVisible(id), onToggleLock(id),
//   onMove(id, toIndex)            toIndex: 0 = bottom
//   onOpacityInput(id, opacity)    live while dragging (0-1)
//   onOpacityCommit(id, before, after)  on release
//   drawThumbnail(id, canvas)      fill a thumbnail canvas
//   onOpenChange(open)
export function createLayersPanel(callbacks) {
  const panel = document.createElement('aside');
  panel.className = 'pp-layers pp-layers--hidden';
  panel.setAttribute('aria-label', 'Layers');

  const header = document.createElement('div');
  header.className = 'pp-layers__header';
  const title = document.createElement('div');
  title.className = 'pp-layers__title';
  title.textContent = 'Layers';
  const addBtn = iconButton('Add layer', PLUS_ICON, 'pp-layers__add');
  header.append(title, addBtn);

  const list = document.createElement('div');
  list.className = 'pp-layers__list';
  list.setAttribute('role', 'list');

  const footer = document.createElement('div');
  footer.className = 'pp-layers__footer';
  const opacityLabel = document.createElement('label');
  opacityLabel.className = 'pp-layers__opacity';
  const opacityText = document.createElement('span');
  opacityText.className = 'pp-layers__opacity-text';
  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = '0';
  opacityInput.max = '100';
  opacityInput.setAttribute('aria-label', 'Layer opacity');
  opacityLabel.append(opacityText, opacityInput);
  const actions = document.createElement('div');
  actions.className = 'pp-layers__actions';
  const renameBtn = textButton('Rename');
  const deleteBtn = textButton('Delete');
  deleteBtn.classList.add('pp-layers__delete');
  actions.append(renameBtn, deleteBtn);
  footer.append(opacityLabel, actions);

  panel.append(header, list, footer);

  let state = { layers: [], activeLayerId: null, maxLayers: Infinity, busy: false };
  let open = false;
  let renamingId = null;
  const thumbs = new Map(); // layer id -> <canvas>

  // --- header / footer actions ---

  addBtn.addEventListener('click', () => callbacks.onAdd());
  deleteBtn.addEventListener('click', () => {
    if (state.activeLayerId) callbacks.onDelete(state.activeLayerId);
  });
  renameBtn.addEventListener('click', () => {
    if (state.activeLayerId) startRename(state.activeLayerId);
  });

  // Opacity: live updates while dragging, one commit (one undo step)
  // on release.
  let opacityStart = null;
  opacityInput.addEventListener('input', () => {
    const id = state.activeLayerId;
    if (!id) return;
    if (opacityStart === null) opacityStart = activeLayer()?.opacity ?? 1;
    const value = Number(opacityInput.value) / 100;
    opacityText.textContent = `Opacity ${Math.round(value * 100)}%`;
    callbacks.onOpacityInput(id, value);
  });
  opacityInput.addEventListener('change', () => {
    const id = state.activeLayerId;
    if (!id || opacityStart === null) return;
    const after = Number(opacityInput.value) / 100;
    const before = opacityStart;
    opacityStart = null;
    if (after !== before) callbacks.onOpacityCommit(id, before, after);
  });

  function activeLayer() {
    return state.layers.find((l) => l.id === state.activeLayerId) ?? null;
  }

  // --- rows ---

  function thumbFor(id) {
    let canvas = thumbs.get(id);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'pp-layers__thumb';
      // 16:9 at 2x for a crisp ~64x36 CSS-px thumbnail.
      canvas.width = 128;
      canvas.height = 72;
      thumbs.set(id, canvas);
      if (open) callbacks.drawThumbnail(id, canvas);
    }
    return canvas;
  }

  function buildRow(layer, visualIndex) {
    const row = document.createElement('div');
    row.className = 'pp-layers__row';
    row.setAttribute('role', 'listitem');
    row.dataset.layerId = layer.id;
    const isActive = layer.id === state.activeLayerId;
    row.classList.toggle('is-active', isActive);
    row.classList.toggle('is-hidden', !layer.visible);

    const handle = document.createElement('div');
    handle.className = 'pp-layers__handle';
    handle.setAttribute('aria-label', `Reorder ${layer.name}`);
    handle.innerHTML = HANDLE_ICON;
    attachDrag(handle, row, layer.id, visualIndex);

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'pp-layers__thumb-wrap';
    thumbWrap.appendChild(thumbFor(layer.id));

    let name;
    if (layer.id === renamingId) {
      name = document.createElement('input');
      name.type = 'text';
      name.className = 'pp-layers__name-input';
      name.value = layer.name;
      name.maxLength = 40;
      name.setAttribute('aria-label', 'Layer name');
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        renamingId = null;
        const next = name.value.trim();
        if (commit && next && next !== layer.name) callbacks.onRename(layer.id, next);
        else render(state);
      };
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      name.addEventListener('blur', () => finish(true));
      // Don't let a tap inside the field select the row.
      name.addEventListener('click', (e) => e.stopPropagation());
    } else {
      name = document.createElement('span');
      name.className = 'pp-layers__name';
      name.textContent = layer.name;
    }

    const eye = iconButton(
      layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`,
      layer.visible ? EYE_ICON : EYE_OFF_ICON,
      'pp-layers__toggle'
    );
    eye.setAttribute('aria-pressed', String(!layer.visible));
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onToggleVisible(layer.id);
    });

    const lock = iconButton(
      layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`,
      layer.locked ? LOCK_ICON : UNLOCK_ICON,
      'pp-layers__toggle'
    );
    lock.classList.toggle('is-on', layer.locked);
    lock.setAttribute('aria-pressed', String(layer.locked));
    lock.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onToggleLock(layer.id);
    });

    row.append(handle, thumbWrap, name, eye, lock);
    row.addEventListener('click', () => {
      if (layer.id !== state.activeLayerId) callbacks.onSelect(layer.id);
    });
    return row;
  }

  // Drag to reorder, by the handle. The dragged row follows the finger;
  // the rows it passes slide out of the way; on release the layer moves
  // to where it was dropped.
  function attachDrag(handle, row, layerId, startVisual) {
    handle.addEventListener('pointerdown', (event) => {
      if (state.busy) return;
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      const rows = [...list.children];
      const step = row.getBoundingClientRect().height
        + parseFloat(getComputedStyle(list).rowGap || '0');
      const startY = event.clientY;
      let target = startVisual;
      row.classList.add('is-dragging');

      const onMove = (e) => {
        const dy = e.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
        target = Math.max(0, Math.min(rows.length - 1, startVisual + Math.round(dy / step)));
        rows.forEach((other, i) => {
          if (other === row) return;
          let shift = 0;
          if (target > startVisual && i > startVisual && i <= target) shift = -step;
          if (target < startVisual && i < startVisual && i >= target) shift = step;
          other.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };
      const onEnd = (e) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        row.classList.remove('is-dragging');
        for (const r of rows) r.style.transform = '';
        if (e.type !== 'pointercancel' && target !== startVisual) {
          // Rows are listed top-first; layer indexes are bottom-first.
          callbacks.onMove(layerId, rows.length - 1 - target);
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    });
  }

  function startRename(id) {
    renamingId = id;
    render(state);
    const input = list.querySelector('.pp-layers__name-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  // state: { layers (bottom first), activeLayerId, maxLayers, busy }
  function render(next) {
    state = { ...state, ...next };
    const ids = new Set(state.layers.map((l) => l.id));
    for (const id of thumbs.keys()) if (!ids.has(id)) thumbs.delete(id);
    if (renamingId && !ids.has(renamingId)) renamingId = null;

    const topFirst = [...state.layers].reverse();
    list.replaceChildren(...topFirst.map((layer, i) => buildRow(layer, i)));

    const active = activeLayer();
    const opacity = active?.opacity ?? 1;
    if (opacityStart === null) opacityInput.value = String(Math.round(opacity * 100));
    opacityText.textContent = `Opacity ${Math.round(Number(opacityInput.value))}%`;
    opacityInput.disabled = !active || state.busy;
    addBtn.disabled = state.busy || state.layers.length >= state.maxLayers;
    deleteBtn.disabled = state.busy || !active || state.layers.length <= 1;
    renameBtn.disabled = state.busy || !active;
  }

  // Redraws one layer's thumbnail (after an edit lands). Skipped while
  // the panel is closed — opening redraws them all.
  function refreshThumbnail(id) {
    if (!open) return;
    const canvas = thumbs.get(id);
    if (canvas) callbacks.drawThumbnail(id, canvas);
  }

  function setOpen(next, { notify = true } = {}) {
    if (next === open) return;
    open = next;
    panel.classList.toggle('pp-layers--hidden', !open);
    if (open) {
      for (const [id, canvas] of thumbs) callbacks.drawThumbnail(id, canvas);
    } else if (renamingId) {
      renamingId = null;
      render(state);
    }
    if (notify) callbacks.onOpenChange(open);
  }

  return {
    element: panel,
    render,
    refreshThumbnail,
    setOpen,
    get isOpen() { return open; },
  };
}

function iconButton(label, icon, className) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon;
  return btn;
}

function textButton(label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp-layers__btn';
  btn.textContent = label;
  return btn;
}

const svg = (body, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">${body}</svg>`;

const PLUS_ICON = svg(
  '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'
);
const HANDLE_ICON = svg(
  '<path d="M5 8h14M5 12h14M5 16h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  20
);
const EYE_ICON = svg(
  '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
  + '<circle cx="12" cy="12" r="3" fill="currentColor"/>'
);
const EYE_OFF_ICON = svg(
  '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity="0.5"/>'
  + '<path d="M4 20 20 4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'
);
const LOCK_ICON = svg(
  '<rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor"/>'
  + '<path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2"/>'
);
const UNLOCK_ICON = svg(
  '<rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/>'
  + '<path d="M8 10.5V8a4 4 0 0 1 7.6-1.7" fill="none" stroke="currentColor" stroke-width="2"/>'
);

// The top bar's Layers button: three stacked sheets.
export const LAYERS_ICON = svg(
  '<path d="M12 3 2.5 8 12 13l9.5-5Z" fill="currentColor"/>'
  + '<path d="M2.5 12 12 17l9.5-5M2.5 16 12 21l9.5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  26
);
