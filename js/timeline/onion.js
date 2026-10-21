// js/timeline/onion.js
//
// Onion skin (step 4c), the pure part: the saved settings and their
// clean-up, and which neighboring frames show as ghosts, with what
// tint and how strongly.
//
// Conventions (Flipaclip, Rough Animator, traditional light tables):
// previous frames red, next frames green; the frame next to hers
// strongest, each one further out fainter; no wrap-around, even with
// loop on (frame 1 has no "previous"). Off on a new project. Saved per
// project, not undoable (a setting, like fps and loop).
//
// No DOM: canvas/onion-view.js draws the ghosts, ui/onion-badge.js is
// the badge and its panel, main.js glues.

// Up to this many frames each way.
export const MAX_ONION_FRAMES = 3;

// The opacity slider's range (the whole ghost layer's opacity).
export const MIN_ONION_OPACITY = 0.1;
export const MAX_ONION_OPACITY = 0.8;

// Tint choices for each side. The first two are the defaults.
export const ONION_TINTS = [
  { hex: '#e5484d', name: 'Red' },
  { hex: '#30a46c', name: 'Green' },
  { hex: '#3e63dd', name: 'Blue' },
  { hex: '#f76b15', name: 'Orange' },
  { hex: '#8e4ec6', name: 'Purple' },
];

export const DEFAULT_ONION = Object.freeze({
  on: false,
  before: 1,
  after: 1,
  opacity: 0.4,
  tintBefore: ONION_TINTS[0].hex,
  tintAfter: ONION_TINTS[1].hex,
});

// How strong each ghost is by distance (1 = next to her frame), as a
// share of the ghost layer's opacity.
const FALLOFF = [1, 0.55, 0.3];

const TINT_SET = new Set(ONION_TINTS.map((t) => t.hex));

// A saved (or missing, or damaged) onion record → a whole, valid one.
// Each bad field falls back on its own.
export function sanitizeOnion(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    on: s.on === true,
    before: count(s.before, DEFAULT_ONION.before),
    after: count(s.after, DEFAULT_ONION.after),
    opacity: Number.isFinite(s.opacity)
      ? Math.min(MAX_ONION_OPACITY, Math.max(MIN_ONION_OPACITY, s.opacity))
      : DEFAULT_ONION.opacity,
    tintBefore: TINT_SET.has(s.tintBefore) ? s.tintBefore : DEFAULT_ONION.tintBefore,
    tintAfter: TINT_SET.has(s.tintAfter) ? s.tintAfter : DEFAULT_ONION.tintAfter,
  };
}

function count(value, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(MAX_ONION_FRAMES, Math.max(0, value));
}

// The ghosts to show around `currentId`: [{ id, side: 'before' |
// 'after', distance, tint, alpha }], farthest first, so the nearest
// ones draw on top. Empty when onion skin is off or there's nothing
// beside her frame. `alpha` is the share of the ghost layer's opacity
// (that is applied to the whole layer, so moving the slider redraws
// nothing).
export function ghostFrames(frameIds, currentId, settings) {
  const s = sanitizeOnion(settings);
  const at = frameIds.indexOf(currentId);
  if (!s.on || at < 0) return [];
  const ghosts = [];
  const furthest = Math.max(s.before, s.after);
  for (let d = furthest; d >= 1; d--) {
    const alpha = FALLOFF[d - 1] ?? FALLOFF[FALLOFF.length - 1];
    if (d <= s.before && at - d >= 0) {
      ghosts.push({ id: frameIds[at - d], side: 'before', distance: d, tint: s.tintBefore, alpha });
    }
    if (d <= s.after && at + d < frameIds.length) {
      ghosts.push({ id: frameIds[at + d], side: 'after', distance: d, tint: s.tintAfter, alpha });
    }
  }
  return ghosts;
}
