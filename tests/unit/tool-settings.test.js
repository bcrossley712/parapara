// Unit tests for remembered tool settings: canvas.js's
// sanitizeToolSettings (cleaning saved data) and storage.js's
// load/saveToolSettings (persisting it).
//
// Run: npm run test:unit

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeToolSettings, MAX_BRUSH_SIZE, DEFAULT_COLOR } from '../../js/canvas/canvas.js';
import * as storage from '../../js/storage/storage.js';
import { DEFAULT_STABILIZER, MAX_STABILIZER } from '../../js/canvas/stabilizer.js';
import { TIPS, TIP_DEFAULTS, MAX_STRENGTH } from '../../js/canvas/brush.js';

// Tip settings (8b-ii) as the defaults, with Pen's sizes overridden —
// what settings saved before 8b-ii turn into.
function tipSettingsWith(penDraw = 6, penErase = 6) {
  const out = structuredClone(TIP_DEFAULTS);
  out.draw.pen.size = penDraw;
  out.erase.pen.size = penErase;
  return out;
}

const DEFAULTS = {
  tool: 'draw',
  color: DEFAULT_COLOR,
  brushSizes: { draw: 6, erase: 6, smudge: 6 },
  stabilizer: { draw: DEFAULT_STABILIZER, erase: DEFAULT_STABILIZER },
  tips: { draw: 'pen', erase: 'pen' },
  tipSettings: tipSettingsWith(),
};

beforeEach(() => {
  storage._resetForTests();
  globalThis.indexedDB = new IDBFactory();
});

// ---------------- sanitizeToolSettings ----------------

test('nothing saved yet gives the defaults', () => {
  assert.deepEqual(sanitizeToolSettings(null), DEFAULTS);
  assert.deepEqual(sanitizeToolSettings(undefined), DEFAULTS);
  assert.deepEqual(sanitizeToolSettings('garbage'), DEFAULTS);
  assert.deepEqual(sanitizeToolSettings({}), DEFAULTS);
});

test('valid settings pass through unchanged (color lowercased)', () => {
  const saved = {
    tool: 'smudge',
    color: '#FFAA00',
    brushSizes: { draw: 1, erase: 33, smudge: MAX_BRUSH_SIZE },
    stabilizer: { draw: 0, erase: MAX_STABILIZER },
  };
  assert.deepEqual(sanitizeToolSettings(saved), {
    tool: 'smudge',
    color: '#ffaa00',
    brushSizes: { draw: 1, erase: 33, smudge: MAX_BRUSH_SIZE },
    stabilizer: { draw: 0, erase: MAX_STABILIZER },
    tips: { draw: 'pen', erase: 'pen' },
    tipSettings: tipSettingsWith(1, 33),
  });
});

test('each bad field falls back on its own, keeping the good ones', () => {
  const result = sanitizeToolSettings({
    tool: 'lasso',            // unknown tool
    color: 'red',             // not #rrggbb
    brushSizes: {
      draw: 12,               // fine
      erase: 0,               // below range
      smudge: MAX_BRUSH_SIZE + 1, // above range
    },
    stabilizer: { draw: 3, erase: MAX_STABILIZER + 1 },
  });
  assert.deepEqual(result, {
    tool: 'draw',
    color: DEFAULT_COLOR,
    brushSizes: { draw: 12, erase: 6, smudge: 6 },
    stabilizer: { draw: 3, erase: DEFAULT_STABILIZER },
    tips: { draw: 'pen', erase: 'pen' },
    tipSettings: tipSettingsWith(12, 6),
  });
});

test('non-integer, string and missing sizes fall back to the default', () => {
  const result = sanitizeToolSettings({
    tool: 'fill',
    color: '#123456',
    brushSizes: { draw: 3.5, erase: '20' },
  });
  assert.deepEqual(result.brushSizes, { draw: 6, erase: 6, smudge: 6 });
  assert.equal(result.tool, 'fill');
});

test('extra or unexpected fields are dropped', () => {
  const result = sanitizeToolSettings({
    tool: 'erase',
    color: '#000000',
    brushSizes: { draw: 2, erase: 3, smudge: 4, fill: 9 },
    stabilizer: { draw: 1, erase: 2, smudge: 3, fill: 4 },
    zoom: 3,
  });
  assert.deepEqual(Object.keys(result).sort(), ['brushSizes', 'color', 'stabilizer', 'tipSettings', 'tips', 'tool']);
  assert.deepEqual(Object.keys(result.brushSizes).sort(), ['draw', 'erase', 'smudge']);
  assert.deepEqual(Object.keys(result.stabilizer).sort(), ['draw', 'erase']);
});

test('stabilizer: settings saved before 8a get the midway default', () => {
  const result = sanitizeToolSettings({ tool: 'erase', color: '#000000', brushSizes: { draw: 2, erase: 3, smudge: 4 } });
  assert.deepEqual(result.stabilizer, { draw: DEFAULT_STABILIZER, erase: DEFAULT_STABILIZER });
  assert.equal(DEFAULT_STABILIZER, 5);
});

test('stabilizer: non-integer, string, negative and garbage values fall back', () => {
  assert.deepEqual(sanitizeToolSettings({ stabilizer: { draw: 2.5, erase: '7' } }).stabilizer,
    { draw: DEFAULT_STABILIZER, erase: DEFAULT_STABILIZER });
  assert.deepEqual(sanitizeToolSettings({ stabilizer: { draw: -1, erase: 0 } }).stabilizer,
    { draw: DEFAULT_STABILIZER, erase: 0 });
  assert.deepEqual(sanitizeToolSettings({ stabilizer: 'high' }).stabilizer,
    { draw: DEFAULT_STABILIZER, erase: DEFAULT_STABILIZER });
});

// ---------------- brush tips (8b-ii) ----------------

test('tips: settings saved before 8b-ii keep their sizes on Pen, the tip they drew with', () => {
  const result = sanitizeToolSettings({ tool: 'erase', color: '#000000', brushSizes: { draw: 14, erase: 80, smudge: 9 } });
  assert.deepEqual(result.tips, { draw: 'pen', erase: 'pen' });
  assert.equal(result.tipSettings.draw.pen.size, 14);
  assert.equal(result.tipSettings.erase.pen.size, 80);
  assert.deepEqual(result.tipSettings.draw.pencil, TIP_DEFAULTS.draw.pencil);
  assert.deepEqual(result.brushSizes, { draw: 14, erase: 80, smudge: 9 });
});

test('tips: size and strength are kept per tool and tip, and brushSizes follows the current tip', () => {
  const tipSettings = structuredClone(TIP_DEFAULTS);
  tipSettings.draw.pencil = { size: 3, strength: 40 };
  tipSettings.erase.pencil = { size: 120, strength: 25 };
  const result = sanitizeToolSettings({
    tool: 'draw',
    color: '#000000',
    brushSizes: { draw: 99, erase: 99, smudge: 7 }, // stale: tipSettings wins
    tips: { draw: 'pencil', erase: 'soft' },
    tipSettings,
  });
  assert.deepEqual(result.tips, { draw: 'pencil', erase: 'soft' });
  assert.deepEqual(result.tipSettings.draw.pencil, { size: 3, strength: 40 });
  assert.deepEqual(result.tipSettings.erase.pencil, { size: 120, strength: 25 });
  assert.deepEqual(result.brushSizes, { draw: 3, erase: TIP_DEFAULTS.erase.soft.size, smudge: 7 });
});

test('tips: unknown tips and bad sizes or strengths fall back one by one', () => {
  const result = sanitizeToolSettings({
    tips: { draw: 'crayon', erase: 'chisel' },
    tipSettings: {
      draw: { pen: { size: 0, strength: 50 }, chalk: { size: 30, strength: 0 }, crayon: { size: 5, strength: 5 } },
      erase: { soft: { size: 2.5, strength: MAX_STRENGTH + 1 }, chisel: 'big' },
      smudge: { pen: { size: 9, strength: 9 } },
    },
  });
  assert.deepEqual(result.tips, { draw: 'pen', erase: 'chisel' });
  assert.deepEqual(result.tipSettings.draw.pen, { size: TIP_DEFAULTS.draw.pen.size, strength: 50 });
  assert.deepEqual(result.tipSettings.draw.chalk, { size: 30, strength: TIP_DEFAULTS.draw.chalk.strength });
  assert.deepEqual(result.tipSettings.erase.soft, TIP_DEFAULTS.erase.soft);
  assert.deepEqual(result.tipSettings.erase.chisel, TIP_DEFAULTS.erase.chisel);
  assert.deepEqual(Object.keys(result.tipSettings), ['draw', 'erase']);
  assert.deepEqual(Object.keys(result.tipSettings.draw), TIPS);
});

test('tips: every default fits the ranges, and Pen keeps the old defaults', () => {
  for (const tool of ['draw', 'erase']) {
    for (const tip of TIPS) {
      const { size, strength } = TIP_DEFAULTS[tool][tip];
      assert.ok(Number.isInteger(size) && size >= 1 && size <= MAX_BRUSH_SIZE, `${tool} ${tip} size`);
      assert.ok(Number.isInteger(strength) && strength >= 1 && strength <= MAX_STRENGTH, `${tool} ${tip} strength`);
    }
    assert.deepEqual(TIP_DEFAULTS[tool].pen, { size: 6, strength: 100 });
  }
});

// ---------------- storage ----------------

test('no settings saved yet loads as null', async () => {
  assert.equal(await storage.loadToolSettings(), null);
});

test('settings round-trip across a relaunch', async () => {
  const settings = { tool: 'erase', color: '#ff00aa', brushSizes: { draw: 10, erase: 40, smudge: 5 } };
  await storage.saveToolSettings(settings);
  storage._resetForTests(); // relaunch: new connection, same database
  assert.deepEqual(await storage.loadToolSettings(), settings);
});

test('settings are app-wide: unaffected by creating a new project', async () => {
  const settings = { tool: 'fill', color: '#00ff00', brushSizes: { draw: 2, erase: 2, smudge: 2 } };
  await storage.saveToolSettings(settings);
  await storage.createProject('Second drawing');
  assert.deepEqual(await storage.loadToolSettings(), settings);
});
