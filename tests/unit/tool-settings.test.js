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

const DEFAULTS = {
  tool: 'draw',
  color: DEFAULT_COLOR,
  brushSizes: { draw: 6, erase: 6, smudge: 6 },
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
  const saved = { tool: 'smudge', color: '#FFAA00', brushSizes: { draw: 1, erase: 33, smudge: MAX_BRUSH_SIZE } };
  assert.deepEqual(sanitizeToolSettings(saved), {
    tool: 'smudge',
    color: '#ffaa00',
    brushSizes: { draw: 1, erase: 33, smudge: MAX_BRUSH_SIZE },
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
  });
  assert.deepEqual(result, {
    tool: 'draw',
    color: DEFAULT_COLOR,
    brushSizes: { draw: 12, erase: 6, smudge: 6 },
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
    zoom: 3,
  });
  assert.deepEqual(Object.keys(result).sort(), ['brushSizes', 'color', 'tool']);
  assert.deepEqual(Object.keys(result.brushSizes).sort(), ['draw', 'erase', 'smudge']);
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
