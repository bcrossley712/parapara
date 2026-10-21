// Unit tests for js/storage/dev-log.js — the temporary activity log.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDevLog, DEV_LOG_KEY } from '../../js/storage/dev-log.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
}

const at = new Date(2026, 9, 21, 13, 42, 7, 315);

test('lines carry the time, the event and its details', () => {
  const storage = fakeStorage();
  const log = createDevLog({ storage, now: () => at });
  log.add('save', { frame: 'f2#ab12', bytes: 5120, ref: null });
  log.add('note', 'free text');
  assert.equal(log.read(), '13:42:07.315 save frame=f2#ab12 bytes=5120 ref=-\n13:42:07.315 note free text');
});

test('it survives a restart (kept in storage)', () => {
  const storage = fakeStorage();
  createDevLog({ storage, now: () => at }).add('stroke');
  const again = createDevLog({ storage, now: () => at });
  assert.equal(again.read(), '13:42:07.315 stroke');
});

test('only the newest lines are kept', () => {
  const storage = fakeStorage();
  const log = createDevLog({ storage, now: () => at, max: 3 });
  for (let i = 1; i <= 5; i++) log.add('e', { i });
  assert.deepEqual(log.read().split('\n').map((l) => l.split(' ').at(-1)), ['i=3', 'i=4', 'i=5']);
  assert.equal(JSON.parse(storage.data[DEV_LOG_KEY]).length, 3);
});

test('clear empties it', () => {
  const storage = fakeStorage();
  const log = createDevLog({ storage, now: () => at });
  log.add('e');
  log.clear();
  assert.equal(log.read(), '');
  assert.equal(createDevLog({ storage }).read(), '');
});

test('broken or missing storage never throws', () => {
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('full'); },
  };
  const log = createDevLog({ storage: throwing, now: () => at });
  log.add('e');
  assert.equal(log.read(), '13:42:07.315 e');
  const none = createDevLog({ storage: null, now: () => at });
  none.add('e');
  assert.equal(none.read(), '13:42:07.315 e');
  const garbage = createDevLog({ storage: fakeStorage({ [DEV_LOG_KEY]: '{not json' }), now: () => at });
  assert.equal(garbage.read(), '');
});
