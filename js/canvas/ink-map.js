// js/canvas/ink-map.js
//
// Pure rules for noticing a layer canvas that iOS has emptied behind
// the app's back (seen on her iPad, after 4c: one layer canvas read
// back blank and stayed blank, while storage still held the drawing.
// The next save would have written blank over it).
//
// An ink map is a coarse grid over a layer — one cell per
// INK_CELL × INK_CELL canvas pixels — that says which cells have any
// paint (alpha > 0) in a scaled-down sample of the layer. canvas.js
// takes the samples; everything here is plain arrays, so it's
// unit-tested without a DOM.
//
// The check: every edit marks the cells it touched (with a one-cell
// margin, since scaling blurs across cell edges). Ink can only
// disappear from cells she edited — erasing, Clear, undo. If ink has
// vanished from many cells she *didn't* touch, the canvas has lost
// its pixels, so it must not be saved. A big erase is fine: every
// erased cell was edited.
//
// Known gap: a canvas that loses only a few cells isn't caught —
// small differences are ignored so resampling noise never trips it.

export const INK_CELL = 8;

// Ink must vanish from at least this many untouched cells, and from at
// least LOST_SHARE of the untouched cells that had ink, to count as a
// lost canvas. A lost canvas loses all of them.
export const MIN_LOST_CELLS = 8;
export const LOST_SHARE = 0.5;

export function inkGrid(width, height) {
  return { cols: Math.ceil(width / INK_CELL), rows: Math.ceil(height / INK_CELL) };
}

export function emptyInk(grid) {
  return new Uint8Array(grid.cols * grid.rows);
}

// RGBA bytes of a cols×rows sample → 1 where alpha > 0.
export function inkFromRgba(rgba, grid) {
  const n = grid.cols * grid.rows;
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = rgba[i * 4 + 3] > 0 ? 1 : 0;
  return ink;
}

export function countInk(ink) {
  let n = 0;
  for (let i = 0; i < ink.length; i++) n += ink[i];
  return n;
}

// Marks the cells `rect` (canvas pixels) covers, plus a one-cell
// margin, in `mask` (created if null). Returns the mask.
export function markEdited(mask, rect, grid) {
  const out = mask ?? new Uint8Array(grid.cols * grid.rows);
  if (!rect || rect.w <= 0 || rect.h <= 0) return out;
  const c0 = Math.max(0, Math.floor(rect.x / INK_CELL) - 1);
  const r0 = Math.max(0, Math.floor(rect.y / INK_CELL) - 1);
  const c1 = Math.min(grid.cols - 1, Math.ceil((rect.x + rect.w) / INK_CELL));
  const r1 = Math.min(grid.rows - 1, Math.ceil((rect.y + rect.h) / INK_CELL));
  for (let r = r0; r <= r1; r++) {
    out.fill(1, r * grid.cols + c0, r * grid.cols + c1 + 1);
  }
  return out;
}

// Compares what the layer had (`before`) with a fresh sample (`now`),
// outside the edited cells. had = untouched cells that had ink;
// lost = those that no longer do.
export function compareInk(before, now, edited) {
  let had = 0;
  let lost = 0;
  for (let i = 0; i < before.length; i++) {
    if (!before[i] || (edited && edited[i])) continue;
    had++;
    if (!now[i]) lost++;
  }
  return { had, lost };
}

export function looksLost({ had, lost }) {
  return lost >= MIN_LOST_CELLS && lost >= had * LOST_SHARE;
}
