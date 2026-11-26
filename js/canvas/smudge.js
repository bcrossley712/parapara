// js/canvas/smudge.js
//
// Smudge (8e): blends by dragging color. Each dab along the stroke lays
// down some of the color it carries (`buffer`) through a soft round
// mask (the Soft tip's fade, so no hard circle edge), then picks up
// some of what is now under it — so color drags along and mixes, as
// Procreate's and Sketchbook's smudge do.
//
// Pure — no DOM; canvas.js reads the layer patch (getImageData), calls
// smudgeDab, and puts it back. Unit-tested.
//
// Colors in `buffer` are premultiplied (0–255 per channel, alpha
// included), so smudging into empty canvas fades paint out instead of
// dragging black in. `data` is ImageData's unpremultiplied RGBA.

export const DEFAULT_SMUDGE_STRENGTH = 50;

// Dabs land this far apart (fraction of size). Close, so the drag is
// smooth; strength sets how much each dab moves.
export const SMUDGE_SPACING_RATIO = 0.05;

// Feel values — first tries, tune on the iPad. Both are per brush
// width of drag, so they don't depend on the spacing:
// - PASS_BLEND × strength: how far a pixel under the middle of the
//   smudge moves toward the carried color in one pass.
// - CARRY_MIN + CARRY_RANGE × strength: how much of the carried color
//   is left after dragging it one brush width — strong smudges carry
//   color farther before it's used up.
const PASS_BLEND = 0.8;
const CARRY_MIN = 0.2;
const CARRY_RANGE = 0.5;

// The Soft tip's fade (brush.js drawSoft), scaled so the center is 1.
const FALLOFF = [[0, 1], [0.35, 0.7], [0.7, 0.2], [1, 0]];

export function falloff(t) {
  if (t >= 1) return 0;
  for (let i = 1; i < FALLOFF.length; i++) {
    const [t1, v1] = FALLOFF[i];
    if (t <= t1) {
      const [t0, v0] = FALLOFF[i - 1];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return 0;
}

// How many dabs' worth of the mask a pixel on the stroke's center line
// gets in one pass: the falloff's average across the diameter, over
// the spacing.
const PASS_DABS = (() => {
  let sum = 0;
  const n = 200;
  for (let i = 0; i < n; i++) sum += falloff((i + 0.5) / n);
  return sum / n / SMUDGE_SPACING_RATIO;
})();

// Per-dab rates for a strength (0–1): `deposit` (how much of the
// carried color one dab lays down at the mask's center) and `pickup`
// (how far the carried color moves toward what's under it, per dab).
export function smudgeRates(strength) {
  const blend = Math.min(0.99, PASS_BLEND * strength);
  const carry = CARRY_MIN + CARRY_RANGE * strength;
  return {
    deposit: 1 - (1 - blend) ** (1 / PASS_DABS),
    pickup: 1 - carry ** SMUDGE_SPACING_RATIO,
  };
}

// The mask for a size × size patch, center at the patch's center.
const masks = new Map(); // size → Float32Array; a handful at most
export function smudgeMask(size) {
  let mask = masks.get(size);
  if (mask) return mask;
  mask = new Float32Array(size * size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r) / r;
      mask[y * size + x] = falloff(d);
    }
  }
  if (masks.size >= 8) masks.delete(masks.keys().next().value);
  masks.set(size, mask);
  return mask;
}

// The color a dab starts out carrying: what's under the stroke's first
// point.
export function startBuffer(data) {
  const buffer = new Float32Array(data.length);
  for (let j = 0; j < data.length; j += 4) {
    const a = data[j + 3];
    buffer[j] = (data[j] * a) / 255;
    buffer[j + 1] = (data[j + 1] * a) / 255;
    buffer[j + 2] = (data[j + 2] * a) / 255;
    buffer[j + 3] = a;
  }
  return buffer;
}

// One dab: blends `buffer` into `data` through `mask` (all the same
// size × size), then updates `buffer` from the result. strength 0–1.
// Pixels outside the mask are left exactly as they were. Returns
// whether any pixel changed.
export function smudgeDab(data, buffer, mask, strength) {
  const { deposit, pickup } = smudgeRates(strength);
  let changed = false;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i];
    if (m === 0) continue;
    const j = i * 4;
    const a = data[j + 3];
    const r = (data[j] * a) / 255;
    const g = (data[j + 1] * a) / 255;
    const b = (data[j + 2] * a) / 255;
    const w = m * deposit;
    const na = a + (buffer[j + 3] - a) * w;
    const nr = r + (buffer[j] - r) * w;
    const ng = g + (buffer[j + 1] - g) * w;
    const nb = b + (buffer[j + 2] - b) * w;
    buffer[j] += (nr - buffer[j]) * pickup;
    buffer[j + 1] += (ng - buffer[j + 1]) * pickup;
    buffer[j + 2] += (nb - buffer[j + 2]) * pickup;
    buffer[j + 3] += (na - buffer[j + 3]) * pickup;
    const outA = Math.round(na);
    if (outA <= 0) {
      if (a !== 0) changed = true;
      data[j] = 0;
      data[j + 1] = 0;
      data[j + 2] = 0;
      data[j + 3] = 0;
      continue;
    }
    const outR = Math.round((nr * 255) / na);
    const outG = Math.round((ng * 255) / na);
    const outB = Math.round((nb * 255) / na);
    if (outA !== a || outR !== data[j] || outG !== data[j + 1] || outB !== data[j + 2]) changed = true;
    data[j] = outR;
    data[j + 1] = outG;
    data[j + 2] = outB;
    data[j + 3] = outA;
  }
  return changed;
}
