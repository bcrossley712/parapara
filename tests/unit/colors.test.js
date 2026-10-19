// Unit tests for js/storage/colors.js — recent colors and the palette.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as C from '../../js/storage/colors.js';

test('normalizeHex accepts 6-digit hex with or without #, lowercased', () => {
  assert.equal(C.normalizeHex('#AABBCC'), '#aabbcc');
  assert.equal(C.normalizeHex('aabbcc'), '#aabbcc');
  assert.equal(C.normalizeHex('#abc'), null);
  assert.equal(C.normalizeHex(42), null);
  assert.equal(C.normalizeHex(null), null);
});

test('sanitizeColorList keeps valid unique colors up to the cap', () => {
  assert.deepEqual(C.sanitizeColorList(['#FF0000', 'bad', '#ff0000', '00ff00'], 8), ['#ff0000', '#00ff00']);
  assert.deepEqual(C.sanitizeColorList(Array.from({ length: 12 }, (_, i) => `#0000${String(i).padStart(2, '0')}`), 10).length, 10);
  assert.deepEqual(C.sanitizeColorList('nope', 8), []);
  assert.deepEqual(C.sanitizeColorList(undefined, 8), []);
});

test('addRecent puts the color first, without repeats, keeping the newest 8', () => {
  let recents = [];
  for (let i = 0; i < 10; i++) recents = C.addRecent(recents, `#00000${i}`);
  assert.equal(recents.length, C.MAX_RECENTS);
  assert.equal(recents[0], '#000009');
  assert.ok(!recents.includes('#000000'), 'oldest dropped');

  const moved = C.addRecent(recents, '#000005');
  assert.equal(moved[0], '#000005');
  assert.equal(moved.length, C.MAX_RECENTS);
  assert.equal(moved.filter((c) => c === '#000005').length, 1);

  assert.equal(C.addRecent(moved, '#000005'), moved, 'already first: same list, no save needed');
  assert.equal(C.addRecent(moved, 'junk'), moved);
});

test('addToPalette adds to the end, refusing duplicates and a full palette', () => {
  let palette = [];
  ({ palette } = C.addToPalette(palette, '#FF0000'));
  assert.deepEqual(palette, ['#ff0000']);
  const dup = C.addToPalette(palette, '#ff0000');
  assert.equal(dup.result, 'duplicate');
  assert.equal(dup.palette, palette);

  for (let i = 1; i < C.MAX_PALETTE; i++) ({ palette } = C.addToPalette(palette, `#0000${String(i).padStart(2, '0')}`));
  assert.equal(palette.length, C.MAX_PALETTE);
  const full = C.addToPalette(palette, '#123456');
  assert.equal(full.result, 'full');
  assert.equal(full.palette.length, C.MAX_PALETTE);
});

test('replace keeps the swatch\'s place and never leaves two of one color', () => {
  const palette = ['#111111', '#222222', '#333333'];
  assert.deepEqual(C.replaceInPalette(palette, 1, '#ABCDEF'), ['#111111', '#abcdef', '#333333']);
  assert.deepEqual(C.replaceInPalette(palette, 0, '#333333'), ['#333333', '#222222']);
  assert.equal(C.replaceInPalette(palette, 5, '#000000'), palette);
  assert.deepEqual(palette, ['#111111', '#222222', '#333333'], 'input not mutated');
});

test('remove takes out one swatch', () => {
  assert.deepEqual(C.removeFromPalette(['#111111', '#222222'], 0), ['#222222']);
  const p = ['#111111'];
  assert.equal(C.removeFromPalette(p, 3), p);
});
