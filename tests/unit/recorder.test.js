// Unit tests for js/audio/recorder.js — opening the mic, recording one
// take and closing the mic again (5c), with a fake mic and recorder.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRecorder, micError, micSettings, MIC_CONSTRAINTS, START_EVENT_TIMEOUT_MS } from '../../js/audio/recorder.js';

function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return { tracks, getTracks: () => tracks, get closed() { return tracks.every((t) => t.stopped); } };
}

// A MediaRecorder that starts and stops when the test says.
class FakeRecorder {
  static last = null;
  constructor(stream) {
    this.stream = stream;
    this.state = 'inactive';
    this.mimeType = 'audio/mp4';
    FakeRecorder.last = this;
  }
  start() { this.state = 'recording'; }
  fireStart() { this.onstart?.(); }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['abc'], { type: 'audio/mp4' }) });
    this.onstop?.();
  }
}

function setup({ getUserMedia, Recorder = FakeRecorder } = {}) {
  let time = 100;
  const timers = [];
  const asked = [];
  const recorder = createRecorder({
    mediaDevices: { getUserMedia: getUserMedia ?? ((c) => { asked.push(c); return Promise.resolve(fakeStream()); }) },
    MediaRecorderCtor: Recorder,
    now: () => time,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  });
  return { recorder, asked, timers, setTime: (t) => { time = t; } };
}

test('the mic is asked for with echo cancellation off', async () => {
  const { recorder, asked } = setup();
  await recorder.open();
  assert.deepEqual(asked, [MIC_CONSTRAINTS]);
  assert.equal(MIC_CONSTRAINTS.audio.echoCancellation, false);
});

test('a take: start resolves when the recorder starts; stop gives the file and closes the mic', async () => {
  const { recorder, setTime } = setup();
  const stream = await recorder.open();
  const started = recorder.start(stream);
  setTime(250);
  FakeRecorder.last.fireStart();
  assert.deepEqual(await started, { startedAt: 250 });
  assert.equal(recorder.recording, true);
  const blob = await recorder.stop();
  assert.equal(blob.type, 'audio/mp4');
  assert.equal(blob.size, 3);
  assert.equal(stream.closed, true);
  assert.equal(recorder.recording, false);
});

test('a recorder that never says it started carries on after the timeout', async () => {
  const { recorder, timers } = setup();
  const started = recorder.start(await recorder.open());
  assert.equal(timers[0].ms, START_EVENT_TIMEOUT_MS);
  timers[0].fn();
  assert.deepEqual(await started, { startedAt: 100 });
});

test('stopping a take that never started gives nothing and closes the mic', async () => {
  class Stuck extends FakeRecorder {
    start() { /* stays inactive */ }
  }
  const { recorder, timers } = setup({ Recorder: Stuck });
  const stream = await recorder.open();
  const started = recorder.start(stream);
  timers[0].fn();
  await started;
  assert.equal(await recorder.stop(), null);
  assert.equal(stream.closed, true);
});

test('a recorder that throws on start rejects and closes the mic', async () => {
  class Broken extends FakeRecorder {
    start() { throw new Error('no'); }
  }
  const { recorder } = setup({ Recorder: Broken });
  const stream = await recorder.open();
  await assert.rejects(recorder.start(stream));
  assert.equal(stream.closed, true);
  assert.equal(recorder.recording, false);
});

test('close shuts a stream that was never recorded', async () => {
  const { recorder } = setup();
  const stream = await recorder.open();
  recorder.close(stream);
  assert.equal(stream.closed, true);
});

test('micError sorts why the mic could not open', () => {
  assert.equal(micError({ name: 'NotAllowedError' }), 'denied');
  assert.equal(micError({ name: 'SecurityError' }), 'denied');
  assert.equal(micError({ name: 'NotFoundError' }), 'no-mic');
  assert.equal(micError(new Error('x')), 'failed');
  assert.equal(micError(undefined), 'failed');
});

test('without MediaRecorder: not supported, and open refuses', async () => {
  const recorder = createRecorder({ mediaDevices: { getUserMedia: () => Promise.resolve(fakeStream()) }, MediaRecorderCtor: null });
  assert.equal(recorder.supported, false);
  await assert.rejects(recorder.open());
});

test('micSettings reports what the browser applied', () => {
  const track = { getSettings: () => ({ echoCancellation: false, autoGainControl: true, sampleRate: 48000 }) };
  assert.deepEqual(micSettings({ getAudioTracks: () => [track] }), { echo: false, agc: true, noise: '?', rate: 48000 });
  assert.deepEqual(micSettings(null), { echo: '?', agc: '?', noise: '?', rate: '?' });
});

test('automatic gain is asked for, echo cancellation stays off', () => {
  assert.equal(MIC_CONSTRAINTS.audio.autoGainControl, true);
  assert.equal(MIC_CONSTRAINTS.audio.echoCancellation, false);
});
