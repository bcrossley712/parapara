// Unit tests for js/storage/autosave.js — the save-timing rules.
// Uses short real timers (delayMs 20) and a fake `save` that records
// how many saves ran and whether any overlapped.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAutosaver } from '../../js/storage/autosave.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSaver({ saveMs = 30, fail = () => false } = {}) {
  const log = { calls: 0, active: 0, maxActive: 0, errors: 0 };
  const saver = createAutosaver({
    delayMs: 20,
    save: async () => {
      log.calls++;
      log.active++;
      log.maxActive = Math.max(log.maxActive, log.active);
      await sleep(saveMs);
      log.active--;
      if (fail(log.calls)) throw new Error('disk full');
    },
    onError: () => { log.errors++; },
  });
  return { saver, log };
}

test('a burst of edits produces one save', async () => {
  const { saver, log } = makeSaver();
  for (let i = 0; i < 10; i++) {
    saver.schedule();
    await sleep(2);
  }
  await sleep(100);
  assert.equal(log.calls, 1);
  assert.equal(saver.hasPendingWork, false);
});

test('an edit during a save causes exactly one more save, never overlapping', async () => {
  const { saver, log } = makeSaver({ saveMs: 60 });
  saver.schedule();
  await sleep(35); // first save is now running
  saver.schedule();
  saver.schedule();
  await sleep(250);
  assert.equal(log.calls, 2);
  assert.equal(log.maxActive, 1, 'saves never overlap');
  assert.equal(saver.hasPendingWork, false);
});

test('flush during a save waits for it, then saves the newer edit', async () => {
  const { saver, log } = makeSaver({ saveMs: 60 });
  saver.schedule();
  await sleep(35); // running
  saver.schedule(); // newer edit
  await saver.flush(); // e.g. the app goes to the background
  assert.equal(log.calls, 2);
  assert.equal(log.maxActive, 1);
  assert.equal(saver.hasPendingWork, false);
});

test('flush with nothing unsaved does nothing', async () => {
  const { saver, log } = makeSaver();
  await saver.flush();
  assert.equal(log.calls, 0);
});

test('flush saves immediately and cancels the pending debounce', async () => {
  const { saver, log } = makeSaver({ saveMs: 1 });
  saver.schedule();
  await saver.flush();
  assert.equal(log.calls, 1);
  await sleep(60);
  assert.equal(log.calls, 1, 'no duplicate save from the old timer');
});

test('a failed save reports once, does not retry in a loop, and retries on the next edit', async () => {
  const { saver, log } = makeSaver({ saveMs: 5, fail: (n) => n === 1 });
  saver.schedule();
  await sleep(150);
  assert.equal(log.calls, 1, 'no automatic retry loop');
  assert.equal(log.errors, 1);
  assert.equal(saver.hasPendingWork, true, 'work still marked unsaved');

  saver.schedule();
  await sleep(100);
  assert.equal(log.calls, 2);
  assert.equal(saver.hasPendingWork, false);
});
