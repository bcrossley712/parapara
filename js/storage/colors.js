// js/storage/colors.js
//
// Owns: pure operations on the two saved color lists (see
// PROJECT_NOTES.md "Schema"):
//   - recent colors: app-wide, the last MAX_RECENTS colors she drew or
//     filled with, newest first (meta.recentColors);
//   - the palette: per project, up to MAX_PALETTE saved swatches in the
//     order she added them (project.palette).
// No DOM, no database — main.js applies these and saves the results.
// Lists are never mutated in place. Colors are '#rrggbb', lowercase.

export const MAX_RECENTS = 8;
export const MAX_PALETTE = 10;

// '#rrggbb' (lowercase) for a valid 6-digit hex with or without '#',
// otherwise null.
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

// A saved list as read back from storage: only valid colors, no
// repeats, at most `max`. Anything that isn't a list becomes [].
export function sanitizeColorList(list, max) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const hex = normalizeHex(item);
    if (hex && !out.includes(hex)) out.push(hex);
    if (out.length >= max) break;
  }
  return out;
}

// `hex` moves (or goes) to the front; the oldest drops off past the
// cap. Returns the same list if nothing changed, so callers can skip a
// save.
export function addRecent(recents, hex) {
  const color = normalizeHex(hex);
  if (!color) return recents;
  if (recents[0] === color) return recents;
  return [color, ...recents.filter((c) => c !== color)].slice(0, MAX_RECENTS);
}

// Adds `hex` to the end of the palette. Returns { palette, result }
// with result 'added', 'full' or 'duplicate' (palette unchanged for
// the last two — the picker says why with a banner).
export function addToPalette(palette, hex) {
  const color = normalizeHex(hex);
  if (!color) return { palette, result: 'invalid' };
  if (palette.includes(color)) return { palette, result: 'duplicate' };
  if (palette.length >= MAX_PALETTE) return { palette, result: 'full' };
  return { palette: [...palette, color], result: 'added' };
}

// Long-press → Replace: the swatch at `index` becomes `hex`, keeping
// its place. If `hex` is already elsewhere in the palette that other
// copy is dropped, so there are never two of one color.
export function replaceInPalette(palette, index, hex) {
  const color = normalizeHex(hex);
  if (!color || index < 0 || index >= palette.length) return palette;
  return palette
    .map((c, i) => (i === index ? color : c))
    .filter((c, i) => i === index || c !== color);
}

// Long-press → Remove.
export function removeFromPalette(palette, index) {
  if (index < 0 || index >= palette.length) return palette;
  return [...palette.slice(0, index), ...palette.slice(index + 1)];
}
