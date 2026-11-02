// js/canvas/brush.js
//
// Brush tips (8b-ii). A tip is a shape stamped repeatedly along a path
// (canvas.js's stampAlongLine/stampAlongQuadratic) into the stroke
// buffer; canvas.js's composeStroke then lays the whole stroke onto the
// layer at the tip's strength, through the paper grain if the tip has
// one. A tip knows its shape, spacing and grain — not draw/erase mode,
// strength or input handling.
//
// `point` is one symmetry copy: { x, y, flipX, flipY }. A shaped tip
// (chisel, paintbrush) is drawn mirrored for a mirrored copy, so the
// chisel's angle mirrors with the line; round tips look the same either
// way.
//
// Every tip stays inside a circle of diameter `size` around the point —
// canvas.js's dirty rect (rectAroundPoint) depends on it.
//
// No DOM at import time (unit tests import this): canvases are made
// the first time a stamp or grain is needed.

export const TIPS = ['pen', 'pencil', 'chalk', 'chisel', 'paintbrush', 'soft'];

export const TIP_LABELS = {
  pen: 'Pen',
  pencil: 'Pencil',
  chalk: 'Chalk',
  chisel: 'Chisel',
  paintbrush: 'Paintbrush',
  soft: 'Soft',
};

export const DEFAULT_TIP = 'pen';
export const MIN_STRENGTH = 1;
export const MAX_STRENGTH = 100;

// Starting size and strength (percent) per tip, per tool. Pen keeps the
// app's old defaults so nothing she has changes. Erase starts every tip
// at full strength — a partial eraser is something she sets. Feel
// values: tune on the iPad.
export const TIP_DEFAULTS = {
  draw: {
    pen: { size: 6, strength: 100 },
    pencil: { size: 4, strength: 85 },
    chalk: { size: 24, strength: 90 },
    chisel: { size: 16, strength: 100 },
    paintbrush: { size: 24, strength: 90 },
    soft: { size: 40, strength: 60 },
  },
  erase: {
    pen: { size: 6, strength: 100 },
    pencil: { size: 4, strength: 100 },
    chalk: { size: 24, strength: 100 },
    chisel: { size: 16, strength: 100 },
    paintbrush: { size: 24, strength: 100 },
    soft: { size: 40, strength: 100 },
  },
};

export function sanitizeTipName(name) {
  return TIPS.includes(name) ? name : DEFAULT_TIP;
}

// --- canvases (made lazily) ---

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  return canvas;
}

// Small seeded random generator, so a tip's sprite and the grain are
// the same every launch (a stroke redrawn later matches the first).
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- sprites: a shaped tip drawn once per size and color ---

// The sprite is (side × side) with the tip centered; side covers the
// size circle plus a pixel for antialiasing.
function spriteSide(size) {
  return Math.ceil(size) + 2;
}

const spriteCache = new Map(); // key → canvas; a handful at most
const SPRITE_CACHE_LIMIT = 12;

function cachedSprite(key, size, draw) {
  let sprite = spriteCache.get(key);
  if (sprite) return sprite;
  const side = spriteSide(size);
  sprite = makeCanvas(side, side);
  const ctx = sprite.getContext('2d');
  ctx.translate(side / 2, side / 2);
  draw(ctx);
  if (spriteCache.size >= SPRITE_CACHE_LIMIT) {
    spriteCache.delete(spriteCache.keys().next().value);
  }
  spriteCache.set(key, sprite);
  return sprite;
}

function spriteStamper(sprite) {
  const half = sprite.width / 2;
  return (ctx, point) => {
    if (!point.flipX && !point.flipY) {
      ctx.drawImage(sprite, point.x - half, point.y - half);
      return;
    }
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.scale(point.flipX ? -1 : 1, point.flipY ? -1 : 1);
    ctx.drawImage(sprite, -half, -half);
    ctx.restore();
  };
}

// A filled circle, exactly as stamping worked before 8b-ii (Pen's
// pixels must not change). The caller sets fillStyle.
function roundStamper(size) {
  return (ctx, point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  };
}

// Chisel: a flat nib held at a fixed angle, like a calligraphy pen —
// "/" (rising to the right), so down-right strokes are thick and
// up-right strokes thin. Corners stay inside the size circle.
const CHISEL_ANGLE = -Math.PI / 4;
const CHISEL_THICKNESS = 0.22; // of size

function drawChisel(ctx, size, color) {
  const length = size;
  const thickness = Math.max(1, size * CHISEL_THICKNESS);
  // Shrink so the corners (half-diagonal) fit in radius size/2.
  const scale = Math.min(1, (size / 2) / Math.hypot(length / 2, thickness / 2));
  ctx.rotate(CHISEL_ANGLE);
  ctx.fillStyle = color;
  ctx.fillRect(-length * scale / 2, -thickness * scale / 2, length * scale, thickness * scale);
}

// Paintbrush: bristles scattered in a disc. Stamped close together, each
// bristle drags a streak along the path, whichever way she moves.
function drawBristles(ctx, size, color) {
  const random = seededRandom(7);
  const count = Math.min(64, 14 + Math.round(size / 2));
  const bristle = Math.max(0.6, size * 0.07);
  const reach = size / 2 - bristle;
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    const r = Math.sqrt(random()) * Math.max(0, reach);
    ctx.globalAlpha = 0.45 + random() * 0.55;
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * r, Math.sin(angle) * r, bristle * (0.7 + random() * 0.6) / 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Soft: a round tip that fades out. Stamps overlap many times along a
// line, so each one is faint at the edge — the stroke's edge is soft
// rather than each stamp's.
function drawSoft(ctx, size, color) {
  const r = size / 2;
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  const rgb = hexToRgb(color);
  const stops = [[0, 0.5], [0.35, 0.35], [0.7, 0.1], [1, 0]];
  for (const [at, alpha] of stops) gradient.addColorStop(at, `rgba(${rgb},${alpha})`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
}

// Chalk: a round tip with a slightly worn edge; the grain does the rest.
function drawChalk(ctx, size, color) {
  const r = size / 2;
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  const rgb = hexToRgb(color);
  gradient.addColorStop(0, `rgba(${rgb},1)`);
  gradient.addColorStop(0.75, `rgba(${rgb},0.9)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
}

function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

// The tips. spacingRatio: fraction of size between stamps (smaller =
// smoother, more stamps). grain: null, 'fine' or 'coarse'.
// stamper(size, color) → (ctx, point) => void, made once per stroke.
const TIP_SHAPES = {
  pen: { spacingRatio: 0.2, grain: null, stamper: (size) => roundStamper(size) },
  pencil: { spacingRatio: 0.15, grain: 'fine', stamper: (size) => roundStamper(size) },
  chalk: {
    spacingRatio: 0.15,
    grain: 'coarse',
    stamper: (size, color) => spriteStamper(cachedSprite(`chalk:${size}:${color}`, size, (ctx) => drawChalk(ctx, size, color))),
  },
  chisel: {
    spacingRatio: 0.06,
    grain: null,
    stamper: (size, color) => spriteStamper(cachedSprite(`chisel:${size}:${color}`, size, (ctx) => drawChisel(ctx, size, color))),
  },
  paintbrush: {
    spacingRatio: 0.04,
    grain: null,
    stamper: (size, color) => spriteStamper(cachedSprite(`paintbrush:${size}:${color}`, size, (ctx) => drawBristles(ctx, size, color))),
  },
  soft: {
    spacingRatio: 0.12,
    grain: null,
    stamper: (size, color) => spriteStamper(cachedSprite(`soft:${size}:${color}`, size, (ctx) => drawSoft(ctx, size, color))),
  },
};

export function getTip(name) {
  return TIP_SHAPES[sanitizeTipName(name)];
}

// --- paper grain, fixed to the canvas ---
//
// A tiling alpha mask; composeStroke keeps the stroke only where the
// grain lets it (destination-in), with the pattern anchored at the
// canvas's (0, 0) — so the grain stays put under the stroke like paper
// (Sketchbook and Procreate pencils), instead of moving with each stamp.

export const GRAIN_TILE = 256;

// Wrapping value noise: a grid of random values every `cell` pixels,
// smoothly interpolated, wrapping at the tile's edge so tiles join.
function valueNoise(random, cell) {
  const n = GRAIN_TILE / cell;
  const grid = new Float32Array(n * n);
  for (let i = 0; i < grid.length; i++) grid[i] = random();
  const out = new Float32Array(GRAIN_TILE * GRAIN_TILE);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < GRAIN_TILE; y++) {
    const gy = y / cell;
    const y0 = Math.floor(gy) % n;
    const y1 = (y0 + 1) % n;
    const ty = smooth(gy - Math.floor(gy));
    for (let x = 0; x < GRAIN_TILE; x++) {
      const gx = x / cell;
      const x0 = Math.floor(gx) % n;
      const x1 = (x0 + 1) % n;
      const tx = smooth(gx - Math.floor(gx));
      const a = grid[y0 * n + x0] + (grid[y0 * n + x1] - grid[y0 * n + x0]) * tx;
      const b = grid[y1 * n + x0] + (grid[y1 * n + x1] - grid[y1 * n + x0]) * tx;
      out[y * GRAIN_TILE + x] = a + (b - a) * ty;
    }
  }
  return out;
}

// The grain's alpha per pixel (0–255), pure so it's unit-tested.
// Fine (pencil): tight, mostly-through texture. Coarse (chalk): bigger
// clumps with real gaps, like chalk skipping over rough paper.
export function grainAlpha(kind) {
  const random = seededRandom(kind === 'coarse' ? 11 : 5);
  const out = new Uint8ClampedArray(GRAIN_TILE * GRAIN_TILE);
  if (kind === 'coarse') {
    const big = valueNoise(random, 8);
    const small = valueNoise(random, 2);
    for (let i = 0; i < out.length; i++) {
      const v = big[i] * 0.6 + small[i] * 0.4;
      const t = Math.max(0, Math.min(1, (v - 0.22) / 0.4));
      out[i] = Math.round(255 * t * t * (3 - 2 * t));
    }
  } else {
    const mid = valueNoise(random, 4);
    const small = valueNoise(random, 1);
    for (let i = 0; i < out.length; i++) {
      const v = mid[i] * 0.4 + small[i] * 0.6;
      const t = Math.max(0, Math.min(1, (v - 0.2) / 0.5));
      out[i] = Math.round(255 * (0.4 + 0.6 * t));
    }
  }
  return out;
}

const grainTiles = new Map(); // kind → canvas

function grainTile(kind) {
  let tile = grainTiles.get(kind);
  if (tile) return tile;
  tile = makeCanvas(GRAIN_TILE, GRAIN_TILE);
  const ctx = tile.getContext('2d');
  const image = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  const alpha = grainAlpha(kind);
  for (let i = 0; i < alpha.length; i++) image.data[i * 4 + 3] = alpha[i];
  ctx.putImageData(image, 0, 0);
  grainTiles.set(kind, tile);
  return tile;
}

// `ctx` holds a copy of the canvas region `rect` at its (0, 0); this
// keeps it only where the grain lets it, lined up with the canvas.
export function applyGrain(ctx, kind, rect) {
  if (!kind) return;
  const pattern = ctx.createPattern(grainTile(kind), 'repeat');
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.globalAlpha = 1;
  ctx.translate(-rect.x, -rect.y);
  ctx.fillStyle = pattern;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

// --- preview: a sample stroke for the brush panel ---
//
// Same stamps, grain and strength as a real stroke, on a small canvas.
export function drawTipSample(canvas, tipName, { color, strength = 100, size } = {}) {
  const tip = getTip(tipName);
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  const buffer = makeCanvas(width, height);
  const bctx = buffer.getContext('2d');
  const stampSize = size ?? Math.round(height * 0.45);
  bctx.fillStyle = color;
  const stamp = tip.stamper(stampSize, color);
  const pad = stampSize / 2 + 2;
  const spacing = Math.max(1, stampSize * tip.spacingRatio);
  const length = width - pad * 2;
  const steps = Math.max(1, Math.ceil(length / spacing));
  for (let i = 0; i <= steps; i++) {
    const x = pad + (length * i) / steps;
    const y = height / 2 + Math.sin((i / steps) * Math.PI * 2) * (height / 2 - pad) * 0.8;
    stamp(bctx, { x, y, flipX: false, flipY: false });
  }
  applyGrain(bctx, tip.grain, { x: 0, y: 0, w: width, h: height });
  ctx.globalAlpha = strength / 100;
  ctx.drawImage(buffer, 0, 0);
  ctx.globalAlpha = 1;
}
