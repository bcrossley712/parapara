// Unit tests for js/updater.js's pure parts. The update flow itself
// needs a real browser and service worker — see tests/e2e/updates.spec.js.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatVersion } from '../../js/updater.js';

test('a deploy stamp shows the short sha and the local date/time', () => {
  const label = formatVersion('0123456789abcdef0123456789abcdef01234567-20261018131500', 'en-US');
  // The time part depends on the machine's time zone, so only its
  // shape is checked.
  assert.match(label, /^0123456 · Oct 1[78], \d{1,2}:\d{2}\s?[AP]M$/);
});

test('the date is read as UTC and shown in local time', () => {
  const stamp = 'abcdef1-20261018131500';
  const expected = new Date(Date.UTC(2026, 9, 18, 13, 15, 0)).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  assert.equal(formatVersion(stamp, 'en-US'), `abcdef1 · ${expected}`);
});

test('an unstamped local copy says so', () => {
  assert.equal(formatVersion('__VERSION__'), 'Development build');
});

test('missing or odd values never throw', () => {
  assert.equal(formatVersion(null), 'Unknown');
  assert.equal(formatVersion(undefined), 'Unknown');
  assert.equal(formatVersion(42), 'Unknown');
  assert.equal(formatVersion(''), 'Unknown');
  assert.equal(formatVersion('something-else'), 'something-else');
});
