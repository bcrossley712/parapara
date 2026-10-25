// Unit tests for js/audio/peaks.js — the sound panel's waveform data
// (5b).
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computePeaks, peakBetween } from '../../js/audio/peaks.js';

test('computePeaks: the loudest sample per bucket, across channels', () => {
  // 1 s at 8 samples a second, 4 peaks a second → 2 samples a bucket.
  const left = Float32Array.from([0.1, -0.5, 0, 0, 0.2, 0.1, 0, 0]);
  const right = Float32Array.from([0, 0, 0.3, 0, 0, -0.9, 0, 0]);
  const peaks = computePeaks([left, right], 8, 4);
  assert.deepEqual([...peaks].map((v) => Math.round(v * 10) / 10), [0.5, 0.3, 0.9, 0]);
});

test('computePeaks: a partial last bucket counts; nothing gives nothing', () => {
  assert.equal(computePeaks([Float32Array.from([0, 0, 0.5])], 4, 2).length, 2);
  assert.equal(computePeaks([], 44100).length, 0);
  assert.equal(computePeaks([new Float32Array(0)], 44100).length, 0);
});

test('peakBetween: the loudest peak in a span, at least one bucket', () => {
  const peaks = Float32Array.from([0.25, 0.75, 0.5, 0.125]);
  assert.equal(peakBetween(peaks, 0, 4, 1), 0.75);
  assert.equal(peakBetween(peaks, 2.2, 2.3, 1), 0.5);
  assert.equal(peakBetween(peaks, 10, 12, 1), 0);
});
