// js/timeline/frame-strip.js
//
// The frame strip below the canvas: a horizontally scrolling row of
// frame tiles, the current one highlighted, ending in a dashed "add
// frame" tile (the wireframe's layout). Tap a tile to go to that frame;
// the add tile inserts a blank frame after the current one. Tapping
// the frame she's already on opens a small menu above it (Flipaclip's
// frame menu) — Duplicate today; step 4's delete and reorder join it.
//
// Bare-bones for now: tiles show the frame number only. Thumbnails,
// reorder and delete come with step 4 (playback, onion skin), and the
// transport sits above this strip then.
//
// Pure UI: main.js passes state in through render() and gets intents
// back through the callbacks.

// callbacks: onSelect(frameId), onAdd(), onDuplicate()
// options.signal: aborts the document listener (the menu's tap-outside
// close) when the editor is torn down.
export function createFrameStrip(callbacks, { signal } = {}) {
  const strip = document.createElement('div');
  strip.className = 'pp-frame-strip';
  strip.setAttribute('aria-label', 'Frames');

  const list = document.createElement('div');
  list.className = 'pp-frame-strip__list';

  const addTile = document.createElement('button');
  addTile.type = 'button';
  addTile.className = 'pp-frame-strip__add';
  addTile.setAttribute('aria-label', 'Add frame');
  addTile.innerHTML = PLUS_ICON;
  addTile.addEventListener('click', () => callbacks.onAdd());

  strip.append(list, addTile);

  let lastCurrent = null;
  let lastBusy = false;

  // --- the frame menu (above the current tile) ---
  let menu = null;
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  function openMenu(tile) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'pp-frame-menu';
    menu.setAttribute('role', 'menu');
    menu.append(menuItem('Duplicate', () => callbacks.onDuplicate()));
    strip.appendChild(menu);
    // Centered over the tile, kept inside the strip.
    const stripBox = strip.getBoundingClientRect();
    const tileBox = tile.getBoundingClientRect();
    const center = tileBox.left - stripBox.left + tileBox.width / 2;
    const max = strip.clientWidth - menu.offsetWidth - 8;
    menu.style.left = `${Math.max(8, Math.min(center - menu.offsetWidth / 2, max))}px`;
  }
  function menuItem(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-frame-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = label;
    btn.disabled = lastBusy;
    btn.addEventListener('click', () => {
      closeMenu();
      onClick();
    });
    return btn;
  }
  // A tap anywhere but the menu or the current tile (whose own click
  // toggles it) closes it; so does scrolling the strip.
  document.addEventListener('pointerdown', (event) => {
    if (!menu || menu.contains(event.target)) return;
    if (event.target.closest?.('.pp-frame-strip__tile.is-current')) return;
    closeMenu();
  }, { signal, capture: true });
  list.addEventListener('scroll', () => closeMenu(), { passive: true });

  // state: { frameIds (timeline order), currentId, busy }
  function render({ frameIds, currentId, busy = false }) {
    closeMenu();
    lastBusy = busy;
    const tiles = frameIds.map((id, i) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pp-frame-strip__tile';
      tile.dataset.frameId = id;
      tile.textContent = String(i + 1);
      tile.setAttribute('aria-label', `Frame ${i + 1}`);
      const isCurrent = id === currentId;
      tile.classList.toggle('is-current', isCurrent);
      if (isCurrent) tile.setAttribute('aria-current', 'true');
      tile.disabled = busy && !isCurrent;
      tile.addEventListener('click', () => {
        if (id !== currentId) callbacks.onSelect(id);
        else if (menu) closeMenu();
        else openMenu(tile);
      });
      return tile;
    });
    list.replaceChildren(...tiles);
    addTile.disabled = busy;

    // Keep the current frame in view when it changes (e.g. after adding
    // one at the end of a long strip, or an undo jumping frames).
    // Scrolls only the list itself — scrollIntoView could also nudge
    // overflow-hidden ancestors, i.e. the fixed app shell.
    if (currentId !== lastCurrent) {
      lastCurrent = currentId;
      const tile = list.querySelector('.is-current');
      if (tile) {
        const left = tile.offsetLeft; // list is position: relative
        const right = left + tile.offsetWidth;
        if (left < list.scrollLeft) list.scrollLeft = left;
        else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
      }
    }
  }

  return { element: strip, render, closeMenu };
}

const PLUS_ICON = `
<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
  <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
