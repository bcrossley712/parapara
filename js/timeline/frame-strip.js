// js/timeline/frame-strip.js
//
// The frame strip below the canvas: a horizontally scrolling row of
// frame tiles, the current one highlighted, ending in a dashed "add
// frame" tile (the wireframe's layout). Tap a tile to go to that frame;
// the add tile inserts a blank frame after the current one.
//
// Bare-bones for now: tiles show the frame number only. Thumbnails,
// reorder and delete come with step 4 (playback, onion skin), and the
// transport sits above this strip then.
//
// Pure UI: main.js passes state in through render() and gets intents
// back through the callbacks.

// callbacks: onSelect(frameId), onAdd()
export function createFrameStrip(callbacks) {
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

  // state: { frameIds (timeline order), currentId, busy }
  function render({ frameIds, currentId, busy = false }) {
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

  return { element: strip, render };
}

const PLUS_ICON = `
<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
  <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;
