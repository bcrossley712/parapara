// js/timeline/frame-strip.js
//
// The frame strip below the canvas: a horizontally scrolling row of
// frame tiles, the current one highlighted, ending in a dashed "add
// frame" tile (the wireframe's layout). Tap a tile to go to that frame;
// the add tile inserts a blank frame after the current one. Tapping
// the frame she's already on opens a small menu above it (Flipaclip's
// frame menu): Duplicate today; step 4's delete and reorder join it.
// (The reference image's controls live in the top bar's Image menu.)
//
// Tiles show a picture of the frame (4a-ii; drawn by
// canvas/frame-tiles.js, handed in with setThumbnail) with its number
// in a corner badge; until a frame's picture is ready, the number alone.
// Tiles take the canvas's shape (setAspect). Reorder and delete come
// with 4d. The transport (4b, transport.js) sits at the strip's left
// end; ui.js puts it there.
//
// While the animation plays, the highlight follows the frame showing
// (setPlayhead) and the strip scrolls to keep it in view, as in
// Flipaclip; any tile tap then just asks for that frame (onSelect) —
// main.js stops playback and lands there — never the menu.
//
// Pure UI: main.js passes state in through render() and gets intents
// back through the callbacks.

// Tile height in CSS px (the strip's layout is built around it); the
// width follows the canvas's aspect, within limits.
export const TILE_HEIGHT = 48;
const MIN_TILE_WIDTH = 36;
const MAX_TILE_WIDTH = 96;

// A tile's CSS size for a canvas of `canvasSize`.
export function tileCssSize(canvasSize) {
  const width = Math.round(TILE_HEIGHT * (canvasSize.width / canvasSize.height));
  return { width: Math.min(MAX_TILE_WIDTH, Math.max(MIN_TILE_WIDTH, width)), height: TILE_HEIGHT };
}

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
  let lastState = null;  // the last render()'s state
  let playhead = null;   // the frame playing, or null

  // Picture canvases by frame id (owned by frame-tiles.js). Kept here
  // across render(), which rebuilds the tile buttons.
  const pictures = new Map();

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

  // Scrolls only the list itself — scrollIntoView could also nudge
  // overflow-hidden ancestors, i.e. the fixed app shell.
  function keepInView(tile) {
    if (!tile) return;
    const left = tile.offsetLeft; // list is position: relative
    const right = left + tile.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
  }

  // state: { frameIds (timeline order), currentId, busy }
  function render(state) {
    lastState = state;
    const { frameIds, busy = false } = state;
    // While playing, the highlight is the frame showing.
    const currentId = playhead ?? state.currentId;
    closeMenu();
    lastBusy = busy;
    const tiles = frameIds.map((id, i) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pp-frame-strip__tile';
      tile.dataset.frameId = id;
      // The number stays the tile's only text (tests read it).
      const number = document.createElement('span');
      number.className = 'pp-frame-strip__number';
      number.textContent = String(i + 1);
      tile.appendChild(number);
      const picture = pictures.get(id);
      if (picture) {
        tile.prepend(picture);
        tile.classList.add('has-picture');
      }
      tile.setAttribute('aria-label', `Frame ${i + 1}`);
      const isCurrent = id === currentId;
      tile.classList.toggle('is-current', isCurrent);
      if (isCurrent) tile.setAttribute('aria-current', 'true');
      tile.disabled = busy && !isCurrent;
      tile.addEventListener('click', () => {
        if (playhead !== null || id !== currentId) callbacks.onSelect(id);
        else if (menu) closeMenu();
        else openMenu(tile);
      });
      return tile;
    });
    list.replaceChildren(...tiles);
    addTile.disabled = busy;

    // Keep the current frame in view when it changes (e.g. after adding
    // one at the end of a long strip, or an undo jumping frames).
    if (currentId !== lastCurrent) {
      lastCurrent = currentId;
      keepInView(list.querySelector('.is-current'));
    }
  }

  // The frame playing (4b), or null when playback stops. Moves the
  // highlight without rebuilding the tiles — it runs every beat.
  function setPlayhead(frameId) {
    if (frameId === playhead) return;
    if (frameId === null) {
      playhead = null;
      if (lastState) render(lastState);
      return;
    }
    if (playhead === null) closeMenu();
    playhead = frameId;
    for (const tile of list.children) {
      const on = tile.dataset.frameId === frameId;
      tile.classList.toggle('is-current', on);
      if (on) tile.setAttribute('aria-current', 'true');
      else tile.removeAttribute('aria-current');
      if (on) keepInView(tile);
    }
    lastCurrent = frameId;
  }

  // A frame's picture (a canvas), or null to go back to the number.
  // The canvas is redrawn in place later; it's only placed here.
  function setThumbnail(frameId, canvas) {
    if (canvas) {
      canvas.classList.add('pp-frame-strip__picture');
      pictures.set(frameId, canvas);
    } else {
      pictures.get(frameId)?.remove();
      pictures.delete(frameId);
    }
    const tile = [...list.children].find((t) => t.dataset.frameId === frameId);
    if (!tile) return;
    if (canvas) tile.prepend(canvas);
    tile.classList.toggle('has-picture', Boolean(canvas));
  }

  // The canvas's shape, so tiles match it. Returns the tile's CSS size.
  function setAspect(canvasSize) {
    const size = tileCssSize(canvasSize);
    strip.style.setProperty('--pp-tile-width', `${size.width}px`);
    strip.style.setProperty('--pp-tile-height', `${size.height}px`);
    return size;
  }

  return { element: strip, render, closeMenu, setThumbnail, setAspect, setPlayhead };
}

const PLUS_ICON = `
<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
  <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
