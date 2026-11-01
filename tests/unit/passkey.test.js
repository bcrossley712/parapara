// Unit tests for js/backup/passkey.js's pure helpers (step 7b). The
// ceremonies themselves run in e2e against Chromium's virtual
// authenticator (passkey.spec.js) and on her iPad.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticatorFlags, fromBase64Url, readPrf, toBase64Url } from '../../js/backup/passkey.js';

test('base64url round-trips any bytes, with no padding or + /', () => {
  for (const len of [0, 1, 2, 3, 16, 31, 32, 33]) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 97 + 251) & 0xff);
    const text = toBase64Url(bytes);
    assert.match(text, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(fromBase64Url(text), bytes);
  }
  assert.equal(toBase64Url(new Uint8Array([0xfb, 0xff])), '-_8');
  assert.equal(toBase64Url(new Uint8Array([0xfb, 0xff]).buffer), '-_8');
});

test('authenticatorFlags reads the flags byte at offset 32', () => {
  const data = new Uint8Array(37);
  data[32] = 0x01 | 0x04 | 0x08 | 0x10;
  assert.deepEqual(authenticatorFlags(data), { up: true, uv: true, be: true, bs: true });
  data[32] = 0x01 | 0x08; // may sync, not synced yet
  assert.deepEqual(authenticatorFlags(data.buffer), { up: true, uv: false, be: true, bs: false });
  assert.equal(authenticatorFlags(new Uint8Array(32)), null);
  assert.equal(authenticatorFlags(null), null);
});

test('readPrf: enabled and the first output as bytes, or nothing', () => {
  const out = new Uint8Array(32).fill(7);
  const read = readPrf({ prf: { enabled: true, results: { first: out.buffer } } });
  assert.equal(read.enabled, true);
  assert.deepEqual(read.first, out);
  assert.deepEqual(readPrf({ prf: { results: { first: out } } }), { enabled: false, first: out });
  assert.deepEqual(readPrf({}), { enabled: false, first: null });
  assert.deepEqual(readPrf(undefined), { enabled: false, first: null });
});
