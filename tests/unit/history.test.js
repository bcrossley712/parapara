// Unit tests for js/storage/history.js — the undo/redo stack rules.
// Entries use a plain object as the "patch"; the swap function stands
// in for canvas.swapRegion and records what it was asked to do.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHistory, MAX_UNDO_STEPS, MAX_UNDO_BYTES } from '../../js/storage/history.js';

function entry(id, bytes = 100, frameId = 'f1') {
  return { type: 'pixels', frameId, layerId: 'l1', rect: { x: 0, y: 0, w: 1, h: 1 }, patch: `before-${id}`, bytes, id };
}

// Swaps the patch label, as canvas.swapRegion would swap pixels.
function swapper(log = []) {
  return (e) => {
    log.push(e.id);
    const next = e.patch.startsWith('before') ? e.patch.replace('before', 'after') : e.patch.replace('after', 'before');
    return { ...e, patch: next };
  };
}

test('defaults are 30 steps and 150 MB', () => {
  assert.equal(MAX_UNDO_STEPS, 30);
  assert.equal(MAX_UNDO_BYTES, 150 * 1024 * 1024);
});

test('undo then redo round-trips the same entry, swapping its patch', () => {
  const h = createHistory();
  h.push(entry('a'));
  const log = [];
  assert.equal(h.undo(swapper(log)), true);
  assert.equal(h.peekRedo().patch, 'after-a');
  assert.equal(h.redo(swapper(log)), true);
  assert.equal(h.peekUndo().patch, 'before-a');
  assert.deepEqual(log, ['a', 'a']);
});

test('undo and redo do nothing when empty', () => {
  const h = createHistory();
  const log = [];
  assert.equal(h.undo(swapper(log)), false);
  assert.equal(h.redo(swapper(log)), false);
  assert.deepEqual(log, []);
});

test('undo walks back newest first', () => {
  const h = createHistory();
  h.push(entry('a'));
  h.push(entry('b'));
  const log = [];
  h.undo(swapper(log));
  h.undo(swapper(log));
  assert.deepEqual(log, ['b', 'a']);
  assert.equal(h.canUndo, false);
  assert.equal(h.redoCount, 2);
});

test('a new edit clears redo', () => {
  const h = createHistory();
  h.push(entry('a'));
  h.push(entry('b'));
  h.undo(swapper());
  assert.equal(h.canRedo, true);
  h.push(entry('c'));
  assert.equal(h.canRedo, false);
  assert.equal(h.undoCount, 2);
  assert.equal(h.bytes, 200);
});

test('the step cap drops the oldest entries', () => {
  const h = createHistory({ maxSteps: 3 });
  for (const id of ['a', 'b', 'c', 'd', 'e']) h.push(entry(id));
  assert.equal(h.undoCount, 3);
  const log = [];
  while (h.undo(swapper(log)));
  assert.deepEqual(log, ['e', 'd', 'c']);
});

test('the byte budget drops the oldest entries', () => {
  const h = createHistory({ maxBytes: 250 });
  h.push(entry('a', 100));
  h.push(entry('b', 100));
  h.push(entry('c', 100));
  assert.equal(h.undoCount, 2);
  assert.equal(h.bytes, 200);
  assert.equal(h.peekUndo().id, 'c');
});

test('an entry over budget on its own is still kept once', () => {
  const h = createHistory({ maxBytes: 50 });
  h.push(entry('a', 10));
  h.push(entry('big', 500));
  assert.equal(h.undoCount, 1);
  assert.equal(h.peekUndo().id, 'big');
});

test('the byte budget counts undo and redo together', () => {
  const h = createHistory({ maxBytes: 1000 });
  h.push(entry('a', 300));
  h.push(entry('b', 300));
  h.undo(swapper());
  // Moving b to redo doesn't free its bytes.
  assert.equal(h.bytes, 600);
  h.redo(swapper());
  assert.equal(h.bytes, 600);
});

test('a failed swap drops the entry instead of keeping a stale one', () => {
  const h = createHistory();
  h.push(entry('a'));
  const errors = console.error;
  console.error = () => {};
  try {
    assert.equal(h.undo(() => { throw new Error('boom'); }), false);
  } finally {
    console.error = errors;
  }
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(h.bytes, 0);
});

test('entries keep their frame tag through undo and redo', () => {
  const h = createHistory();
  h.push(entry('a', 100, 'frame-6'));
  h.undo(swapper());
  assert.equal(h.peekRedo().frameId, 'frame-6');
});

test('onChange fires on push, undo, redo and clear', () => {
  let calls = 0;
  const h = createHistory({ onChange: () => calls++ });
  h.push(entry('a'));
  h.undo(swapper());
  h.redo(swapper());
  h.clear();
  assert.equal(calls, 4);
  assert.equal(h.canUndo, false);
  assert.equal(h.bytes, 0);
});
