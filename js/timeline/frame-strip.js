// js/timeline/frame-strip.js
//
// The frame strip below the canvas: a horizontally scrolling row of
// frame tiles, the current one highlighted, ending in a dashed "add
// frame" tile (the wireframe's layout). Tap a tile to go to that frame;
// the add tile inserts a blank frame after the current one. Tapping
// the frame she's already on opens a small menu above it (Flipaclip's
// frame menu): Duplicate, and Delete (4d; not on the last frame).
// (Copy / paste of a layer's drawing is in the layer menu.) (The reference
// image's controls live in the top bar's Image menu.)
//
// Reorder (4d, Flipaclip's way): long-press a tile, it lifts, drag it
// along the strip (which scrolls near its ends), let go to drop it.
// Moving a frame doesn't change which frame she's on.
//
// Tiles show a picture of the frame (4a-ii; drawn by
// canvas/frame-tiles.js, handed in with setThumbnail) with its number
// in a corner badge; until a frame's picture is ready, the number alone.
// Tiles take the canvas's shape (setAspect). The transport (4b, transport.js) sits at the strip's left
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

// Long-press to lift a tile: how long, and how far the finger may
// wander first (further is a scroll, not a press). Near either end of
// the strip a lifted tile scrolls it, faster the closer it gets.
const LONG_PRESS_MS = 400;
const LONG_PRESS_SLOP = 8;
const SCROLL_EDGE = 48;
const MAX_SCROLL_STEP = 14; // px per animation frame

// callbacks: onSelect(frameId), onAdd(), onDuplicate(), onDelete(),
// onMove(frameId, toIndex)
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
    // The last frame can't be deleted, so it isn't offered.
    if ((lastState?.frameIds.length ?? 0) > 1) {
      const del = menuItem('Delete', () => callbacks.onDelete());
      del.classList.add('pp-frame-menu__item--danger');
      menu.append(del);
    }
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

  // --- long-press and drag to reorder (4d) ---
  //
  // A press becomes a drag only after LONG_PRESS_MS without moving;
  // moving sooner (or the browser taking the touch for a scroll, which
  // cancels the pointer) leaves it a scroll or a tap. Once lifted, the
  // strip stops scrolling under the finger (touchmove below) and the
  // tile follows it; the tiles it passes slide aside, like the layers
  // panel's rows. The click that ends a drag is swallowed.
  let press = null; // { pointerId, tile, startX, startY, x, timer }
  let drag = null;  // { pointerId, tile, id, from, target, step, tiles, startX, startScroll, x, raf }
  let swallowClick = false;

  function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  }

  function lift() {
    const { pointerId, tile, x } = press;
    press = null;
    if (!tile.isConnected || tile.disabled || lastBusy || playhead !== null) return;
    closeMenu();
    const tiles = [...list.children];
    const gap = parseFloat(getComputedStyle(list).columnGap || '0') || 0;
    drag = {
      pointerId,
      tile,
      id: tile.dataset.frameId,
      from: tiles.indexOf(tile),
      target: tiles.indexOf(tile),
      step: tile.offsetWidth + gap,
      tiles,
      startX: x,
      startScroll: list.scrollLeft,
      x,
      raf: 0,
    };
    try { list.setPointerCapture(pointerId); } catch { /* pointer already gone */ }
    tile.classList.add('is-lifted');
    strip.classList.add('is-reordering');
    drag.raf = requestAnimationFrame(dragFrame);
  }

  // Places the lifted tile under the finger (scrolling included) and
  // slides the others out of its way.
  function placeDrag() {
    const { tile, tiles, from } = drag;
    const dx = drag.x - drag.startX + (list.scrollLeft - drag.startScroll);
    tile.style.transform = `translateX(${dx}px)`;
    drag.target = Math.max(0, Math.min(tiles.length - 1, from + Math.round(dx / drag.step)));
    tiles.forEach((other, i) => {
      if (other === tile) return;
      let shift = 0;
      if (drag.target > from && i > from && i <= drag.target) shift = -drag.step;
      if (drag.target < from && i < from && i >= drag.target) shift = drag.step;
      other.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  }

  // Every animation frame while lifted: scroll near the ends, re-place.
  function dragFrame() {
    if (!drag) return;
    const box = list.getBoundingClientRect();
    let step = 0;
    if (drag.x < box.left + SCROLL_EDGE) step = -MAX_SCROLL_STEP * Math.min(1, (box.left + SCROLL_EDGE - drag.x) / SCROLL_EDGE);
    else if (drag.x > box.right - SCROLL_EDGE) step = MAX_SCROLL_STEP * Math.min(1, (drag.x - (box.right - SCROLL_EDGE)) / SCROLL_EDGE);
    if (step) list.scrollLeft += step;
    placeDrag();
    drag.raf = requestAnimationFrame(dragFrame);
  }

  // Drops the tile (or puts it back, if `cancelled`).
  function endDrag(cancelled) {
    if (!drag) return;
    const { pointerId, tile, tiles, id, from, target, raf } = drag;
    drag = null;
    cancelAnimationFrame(raf);
    try { list.releasePointerCapture(pointerId); } catch { /* already released */ }
    tile.classList.remove('is-lifted');
    strip.classList.remove('is-reordering');
    for (const t of tiles) t.style.transform = '';
    swallowClick = true;
    if (!cancelled && target !== from) callbacks.onMove(id, target);
  }

  list.addEventListener('pointerdown', (event) => {
    swallowClick = false;
    if (drag || press || !event.isPrimary) return;
    const tile = event.target.closest?.('.pp-frame-strip__tile');
    if (!tile || tile.disabled || lastBusy || playhead !== null) return;
    press = {
      pointerId: event.pointerId,
      tile,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      timer: setTimeout(lift, LONG_PRESS_MS),
    };
  });
  list.addEventListener('pointermove', (event) => {
    if (drag && event.pointerId === drag.pointerId) {
      drag.x = event.clientX;
      placeDrag();
    } else if (press && event.pointerId === press.pointerId) {
      press.x = event.clientX;
      if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > LONG_PRESS_SLOP) cancelPress();
    }
  });
  const onPointerEnd = (event) => {
    if (drag && event.pointerId === drag.pointerId) endDrag(event.type === 'pointercancel');
    else if (press && event.pointerId === press.pointerId) cancelPress();
  };
  // On the document: a finger (or mouse) let go anywhere ends it.
  document.addEventListener('pointerup', onPointerEnd, { signal });
  document.addEventListener('pointercancel', onPointerEnd, { signal });
  list.addEventListener('lostpointercapture', (event) => {
    if (drag && event.pointerId === drag.pointerId) endDrag(true);
  });
  // A lifted tile owns the finger: the strip mustn't scroll under it.
  // (Non-passive, but it only acts while lifted, like the canvas
  // area's three-finger listener.)
  list.addEventListener('touchmove', (event) => {
    if (drag) event.preventDefault();
  }, { passive: false });
  // No long-press callout or context menu on tiles.
  list.addEventListener('contextmenu', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });

  // state: { frameIds (timeline order), currentId, busy }
  function render(state) {
    // Rebuilding the tiles ends any press or drag in progress.
    cancelPress();
    endDrag(true);
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
    if (playhead === null) {
      closeMenu();
      cancelPress();
      endDrag(true);
    }
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
