// Unit tests for js/audio/audio.js — the audio clock and how the clip
// is scheduled on it (step 5), with a fake AudioContext.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAudio, LOOKAHEAD, START_TIMEOUT_MS } from '../../js/audio/audio.js';

// A fake AudioContext: currentTime and state are set by the test;
// every scheduled source is recorded as [when, offset, duration].
function fakeContext({ state = 'running', outputLatency = 0 } = {}) {
  const ctx = {
    currentTime: 0,
    state,
    outputLatency,
    destination: {},
    started: [],
    stopped: 0,
    resumes: 0,
    closed: false,
    gains: [],
    compressors: [],
    createGain() {
      const node = {
        gain: { value: 1, setTargetAtTime(v) { this.value = v; }, cancelScheduledValues() {} },
        connect(to) { node.to = to; },
      };
      ctx.gains.push(node);
      return node;
    },
    createDynamicsCompressor() {
      const param = () => ({ value: 0 });
      const node = { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), connect(to) { node.to = to; } };
      ctx.compressors.push(node);
      return node;
    },
    createBufferSource() {
      return {
        connect(to) { this.to = to; },
        start: (when, offset, duration) => ctx.started.push([round(when), round(offset), round(duration)]),
        stop: () => { ctx.stopped += 1; },
      };
    },
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (c) => data[c] };
    },
    decodeAudioData: (bytes) => (bytes.byteLength > 0 ? Promise.resolve({ duration: 4 }) : Promise.reject(new Error('bad'))),
    resume() { ctx.resumes += 1; return Promise.resolve(); },
    close() { ctx.closed = true; return Promise.resolve(); },
  };
  return ctx;
}

const round = (n) => Math.round(n * 1000) / 1000;
const clip = (fields = {}) => ({ id: 'c', blobRef: 'b', trimStart: 0, trimEnd: 4, offset: 0, ...fields });

function setup({ ctxOptions, clipFields, duration = 4, audioSession = null } = {}) {
  const ctx = fakeContext(ctxOptions);
  let wall = 0;
  const events = [];
  const audio = createAudio({
    createContext: () => ctx,
    wallNow: () => wall,
    audioSession,
    onEvent: (name, detail) => events.push([name, detail]),
  });
  const buffer = ctx.createBuffer(1, Math.round(duration * 100), 100);
  audio.setClips([{ clip: clip(clipFields), buffer }]);
  return { ctx, audio, events, setWall: (ms) => { wall = ms; } };
}

test('no clip: the wall clock, and nothing is scheduled', () => {
  const ctx = fakeContext();
  let wall = 1000;
  const audio = createAudio({ createContext: () => ctx, wallNow: () => wall });
  audio.clock.start({ position: 0, fps: 12, frameCount: 24 });
  assert.equal(audio.clock.mode, 'wall');
  wall = 1250;
  assert.equal(audio.clock.now(), 250);
  assert.deepEqual(ctx.started, []);
});

test('from the first frame, the clip plays from its start, at once', () => {
  const { ctx, audio } = setup();
  ctx.currentTime = 10;
  // 48 frames at 12 fps = 4 s, the clip's length.
  audio.clock.start({ position: 0, fps: 12, frameCount: 48, loop: false });
  assert.equal(audio.clock.mode, 'audio');
  assert.deepEqual(ctx.started, [[10, 0, 4]]);
  ctx.currentTime = 10.5;
  assert.equal(audio.clock.now(), 500);
});

test('starting on a later frame starts the sound at that frame\'s time', () => {
  const { ctx, audio } = setup();
  ctx.currentTime = 2;
  audio.clock.start({ position: 1.5, fps: 12, frameCount: 48, loop: false });
  assert.deepEqual(ctx.started, [[2, 1.5, 2.5]]);
});

test('the animation length wins: sound past its end never plays', () => {
  const { ctx, audio } = setup();
  // 12 frames at 12 fps = 1 s of a 4 s clip.
  audio.clock.start({ position: 0, fps: 12, frameCount: 12, loop: false });
  assert.deepEqual(ctx.started, [[0, 0, 1]]);
});

test('a clip that starts later waits for its moment', () => {
  const { ctx, audio } = setup({ clipFields: { offset: 1, trimEnd: 2 } });
  audio.clock.start({ position: 0, fps: 10, frameCount: 40, loop: false });
  assert.deepEqual(ctx.started, [[1, 0, 2]]);
});

test('starting after the clip has ended this pass plays nothing until the loop', () => {
  // 2 s of sound in a 4 s animation; start at 3 s.
  const { ctx, audio } = setup({ clipFields: { trimEnd: 2 } });
  audio.clock.start({ position: 3, fps: 10, frameCount: 40, loop: true });
  // Next pass starts 1 s from now (4 − 3), within LOOKAHEAD.
  assert.deepEqual(ctx.started, [[1, 0, 2]]);
});

test('with loop, each pass is queued ahead on the audio clock, seamlessly', () => {
  const { ctx, audio } = setup();
  // 2 s animation, 4 s clip: each pass plays the clip's first 2 s.
  audio.clock.start({ position: 0, fps: 10, frameCount: 20, loop: true });
  assert.deepEqual(ctx.started, [[0, 0, 2]]);
  ctx.currentTime = 2 - LOOKAHEAD + 0.01;
  audio.clock.now();
  assert.deepEqual(ctx.started, [[0, 0, 2], [2, 0, 2]]);
  ctx.currentTime = 4 - LOOKAHEAD + 0.01;
  audio.clock.now();
  assert.deepEqual(ctx.started.at(-1), [4, 0, 2]);
  // Pass times come from the run's start, not from when they're asked.
  assert.equal(ctx.started.length, 3);
});

test('without loop, nothing more is queued', () => {
  const { ctx, audio } = setup();
  audio.clock.start({ position: 0, fps: 10, frameCount: 20, loop: false });
  ctx.currentTime = 1.9;
  audio.clock.now();
  assert.equal(ctx.started.length, 1);
});

test('a late start is shifted, never played late', () => {
  const { ctx, audio } = setup();
  audio.clock.start({ position: 0, fps: 10, frameCount: 20, loop: true });
  // The page was busy past the next pass's start (2 s): it starts now,
  // that much into the clip.
  ctx.currentTime = 2.25;
  audio.clock.now();
  assert.deepEqual(ctx.started[1], [2.25, 0.25, 1.75]);
});

test('the frames follow what she hears: output delay is taken off', () => {
  const { ctx, audio } = setup({ ctxOptions: { outputLatency: 0.05 } });
  audio.clock.start({ position: 0, fps: 10, frameCount: 20 });
  ctx.currentTime = 0.5;
  assert.equal(Math.round(audio.clock.now()), 450);
});

test('stop stops every scheduled source', () => {
  const { ctx, audio } = setup();
  audio.clock.start({ position: 0, fps: 10, frameCount: 20, loop: true });
  ctx.currentTime = 1.5;
  audio.clock.now();
  audio.clock.stop();
  assert.equal(ctx.stopped, 2);
  assert.equal(audio.clock.mode, null);
});

test('a context still starting holds the first frame, then runs on sound', () => {
  const { ctx, audio, setWall } = setup({ ctxOptions: { state: 'suspended' } });
  audio.clock.start({ position: 0, fps: 10, frameCount: 20 });
  assert.equal(audio.clock.mode, 'audio');
  setWall(300);
  assert.equal(audio.clock.now(), 0);
  ctx.state = 'running';
  ctx.currentTime = 0.4;
  assert.equal(Math.round(audio.clock.now()), 400);
});

test('a context that never starts goes silent and carries on with the wall clock', () => {
  const { ctx, audio, setWall } = setup({ ctxOptions: { state: 'suspended' } });
  audio.clock.start({ position: 0, fps: 10, frameCount: 20 });
  setWall(10);
  audio.clock.now();
  setWall(10 + START_TIMEOUT_MS + 1);
  assert.equal(audio.clock.now(), 0);
  assert.equal(audio.clock.mode, 'wall');
  assert.equal(ctx.stopped, 1);
  setWall(10 + START_TIMEOUT_MS + 201);
  assert.equal(audio.clock.now(), 200);
});

test('unlock resumes a suspended context, only when there is sound', () => {
  const { ctx, audio } = setup({ ctxOptions: { state: 'suspended' } });
  audio.unlock();
  assert.equal(ctx.resumes, 1);
  audio.setClips([]);
  audio.unlock();
  assert.equal(ctx.resumes, 1);
});

test('unlock also starts the context for a sound still loading (Play while opening)', () => {
  const ctx = fakeContext({ state: 'suspended' });
  let made = 0;
  const audio = createAudio({ createContext: () => { made += 1; return ctx; }, wallNow: () => 0, audioSession: null });
  // Nothing decoded yet, so no context exists until the tap asks.
  audio.unlock({ expectSound: true });
  assert.equal(made, 1);
  assert.equal(ctx.resumes, 1);
});

test('the audio session is set to playback, so Silent mode does not mute it', async () => {
  const session = { type: 'auto' };
  const { audio } = setup({ ctxOptions: { state: 'suspended' }, audioSession: session });
  assert.equal(session.type, 'auto'); // nothing until sound is used
  await audio.decode(new ArrayBuffer(8)); // creates the context
  assert.equal(session.type, 'playback');
  session.type = 'auto'; // something else changed it
  audio.unlock();
  assert.equal(session.type, 'playback');
  assert.deepEqual(audio.debugState, { ctx: 'suspended', session: 'playback' });
});

test('an audio session that refuses the type does not stop the sound', async () => {
  const session = { get type() { return 'auto'; }, set type(_) { throw new Error('nope'); } };
  const { ctx, audio } = setup({ audioSession: session });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await audio.decode(new ArrayBuffer(8));
    audio.clock.start({ position: 0, fps: 10, frameCount: 20 });
  } finally {
    console.warn = warn;
  }
  assert.equal(audio.clock.mode, 'audio');
  assert.equal(ctx.started.length, 1);
});

test('the log hears when a run\'s sound starts, once', () => {
  const { ctx, audio, events, setWall } = setup({ ctxOptions: { state: 'suspended' } });
  audio.clock.start({ position: 0, fps: 10, frameCount: 20 });
  setWall(120);
  audio.clock.now();
  assert.deepEqual(events, []);
  ctx.state = 'running';
  audio.clock.now();
  audio.clock.now();
  assert.deepEqual(events, [['sound-start', { waitedMs: 120 }]]);
});

test('the log hears a sound that never started', () => {
  const { audio, events, setWall } = setup({ ctxOptions: { state: 'suspended' } });
  audio.clock.start({ position: 0, fps: 10, frameCount: 20 });
  setWall(1);
  audio.clock.now();
  setWall(2 + START_TIMEOUT_MS);
  audio.clock.now();
  assert.deepEqual(events, [['sound-silent', { reason: 'did-not-start', state: 'suspended' }]]);
});

test('the log hears a resume that fails', async () => {
  const { ctx, audio, events } = setup({ ctxOptions: { state: 'suspended' } });
  ctx.resume = () => Promise.reject(new Error('not allowed'));
  const warn = console.warn;
  console.warn = () => {};
  try {
    audio.unlock();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(events, [['sound-unlock-failed', { error: 'not allowed' }]]);
});

test('decode rejects what the device can\'t play', async () => {
  const { audio } = setup();
  await assert.rejects(audio.decode(new ArrayBuffer(0)));
  assert.deepEqual(await audio.decode(new ArrayBuffer(8)), { duration: 4 });
});

test('keepFirst cuts a long sound to the cap, leaves a short one alone', () => {
  const { ctx, audio } = setup();
  const long = ctx.createBuffer(2, 1000, 100); // 10 s
  long.getChannelData(1)[499] = 0.5;
  const cut = audio.keepFirst(long, 5);
  assert.equal(cut.length, 500);
  assert.equal(cut.numberOfChannels, 2);
  assert.equal(cut.getChannelData(1)[499], 0.5);
  const short = ctx.createBuffer(1, 100, 100);
  assert.equal(audio.keepFirst(short, 5), short);
});

test('without Web Audio: playback stays on the wall clock, decode refuses', async () => {
  const audio = createAudio({ createContext: () => null, wallNow: () => 0 });
  await assert.rejects(audio.decode(new ArrayBuffer(8)));
  audio.clock.start({ position: 0, fps: 12, frameCount: 12 });
  assert.equal(audio.clock.mode, 'wall');
});

test('destroy closes the context', async () => {
  const { ctx, audio } = setup();
  await audio.decode(new ArrayBuffer(8)); // creates it
  audio.destroy();
  assert.equal(ctx.closed, true);
  assert.equal(audio.hasSound, false);
});

test('Music and Voice play together, each where its clip says', () => {
  const { ctx, audio } = setup();
  const voiceBuffer = ctx.createBuffer(1, 200, 100); // 2 s
  audio.setClips([
    { clip: clip({ kind: 'music' }), buffer: ctx.createBuffer(1, 400, 100) },
    { clip: clip({ id: 'v', kind: 'voice', trimStart: 0.5, trimEnd: 2, offset: 1 }), buffer: voiceBuffer },
  ]);
  audio.clock.start({ position: 0, fps: 10, frameCount: 40, loop: false });
  assert.deepEqual(ctx.started, [[0, 0, 4], [1, 0.5, 1.5]]);
});

test('skip leaves the Voice out of a run (recording), the Music still plays', () => {
  const { ctx, audio } = setup();
  audio.setClips([
    { clip: clip({ kind: 'music' }), buffer: ctx.createBuffer(1, 400, 100) },
    { clip: clip({ id: 'v', kind: 'voice' }), buffer: ctx.createBuffer(1, 400, 100) },
  ]);
  audio.clock.start({ position: 0, fps: 10, frameCount: 40, loop: false, skip: ['voice'] });
  assert.deepEqual(ctx.started, [[0, 0, 4]]);
  assert.equal(audio.clock.mode, 'audio');
});

test('only a skipped Voice: the run is on the wall clock, silently', () => {
  const { ctx, audio } = setup();
  audio.setClips([{ clip: clip({ kind: 'voice' }), buffer: ctx.createBuffer(1, 400, 100) }]);
  audio.clock.start({ position: 0, fps: 10, frameCount: 40, loop: false, skip: ['voice'] });
  assert.deepEqual(ctx.started, []);
  assert.equal(audio.clock.mode, 'wall');
});

test('with loop, each pass queues both clips', () => {
  const { ctx, audio } = setup();
  audio.setClips([
    { clip: clip({ kind: 'music', trimEnd: 1 }), buffer: ctx.createBuffer(1, 400, 100) },
    { clip: clip({ id: 'v', kind: 'voice', trimEnd: 1, offset: 0.5 }), buffer: ctx.createBuffer(1, 400, 100) },
  ]);
  audio.clock.start({ position: 0, fps: 10, frameCount: 20, loop: true });
  ctx.currentTime = 2 - LOOKAHEAD + 0.01;
  audio.clock.now();
  assert.deepEqual(ctx.started, [[0, 0, 1], [0.5, 0, 1], [2, 0, 1], [2.5, 0, 1]]);
});

test('recording switches the audio session to play-and-record, and back', async () => {
  const session = { type: 'auto' };
  const { audio } = setup({ audioSession: session });
  await audio.decode(new ArrayBuffer(8));
  audio.setRecording(true);
  assert.equal(session.type, 'play-and-record');
  audio.unlock(); // a tap while recording keeps it
  assert.equal(session.type, 'play-and-record');
  audio.setRecording(false);
  assert.equal(session.type, 'playback');
});

test('a clip\'s gain plays through a GainNode; no gain, no node', () => {
  const { ctx, audio } = setup();
  audio.setClips([
    { clip: clip({ kind: 'music' }), buffer: ctx.createBuffer(1, 400, 100) },
    { clip: clip({ id: 'v', kind: 'voice', gain: 4 }), buffer: ctx.createBuffer(1, 400, 100) },
  ]);
  audio.clock.start({ position: 0, fps: 10, frameCount: 40, loop: false });
  assert.equal(ctx.started.length, 2);
  assert.deepEqual(ctx.gains.filter((g) => !g.bus).map((g) => g.gain.value), [4]);
});

test('wake resumes a paused context outside a tap', async () => {
  const { ctx, audio } = setup({ ctxOptions: { state: 'suspended' } });
  audio.wake(); // no context yet: nothing
  assert.equal(ctx.resumes, 0);
  await audio.decode(new ArrayBuffer(8));
  audio.wake();
  assert.equal(ctx.resumes, 1);
  ctx.state = 'running';
  audio.wake();
  assert.equal(ctx.resumes, 1);
});

// --- after 5c: the mix and listening ---

const bus = (ctx, kind) => ctx.gains.find((g) => g.bus === kind);

test('each row plays through its own volume, into a limiter', async () => {
  const { ctx, audio } = setup({ clipFields: { kind: 'music', volume: 0.5 } });
  await audio.decode(new ArrayBuffer(8)); // makes the context
  assert.equal(bus(ctx, 'music').gain.value, 0.5);
  assert.equal(bus(ctx, 'voice').gain.value, 1);
  assert.equal(bus(ctx, 'music').to, ctx.compressors[0]); // the limiter
  assert.equal(ctx.compressors[0].to, ctx.destination);
  audio.setVolume('music', 0.8); // live, while she drags
  assert.equal(bus(ctx, 'music').gain.value, 0.8);
});

test('a loudness-leveled take goes through its own compressor', async () => {
  const { ctx, audio } = setup({ clipFields: { kind: 'voice', gain: 3, leveling: 'loudness' } });
  ctx.currentTime = 1;
  audio.clock.start({ position: 0, fps: 12, frameCount: 48, loop: false });
  const leveling = ctx.gains.find((g) => !g.bus);
  assert.equal(leveling.gain.value, 3);
  assert.equal(leveling.to, ctx.compressors[1]); // [0] is the limiter
  assert.equal(ctx.compressors[1].to, bus(ctx, 'voice'));
});

test('listen plays the song alone from a point, and says where it is', () => {
  const { ctx, audio } = setup({ clipFields: { kind: 'music' } });
  ctx.currentTime = 5;
  assert.equal(audio.listen({ from: 1.5 }), true);
  assert.deepEqual(ctx.started.at(-1).slice(0, 2), [5, 1.5]); // now, from 1.5 s into the file
  assert.equal(audio.listening, true);
  ctx.currentTime = 6.25;
  assert.equal(audio.listenPosition(), 2.75);
  audio.stopListening();
  assert.equal(audio.listening, false);
  assert.equal(audio.listenPosition(), null);
});

test('listen ends at the file\'s end; playback stops it', () => {
  const { ctx, audio } = setup({ clipFields: { kind: 'music' } });
  let ended = 0;
  audio.listen({ from: 0, onEnd: () => { ended += 1; } });
  audio.clock.start({ position: 0, fps: 12, frameCount: 24 });
  assert.equal(audio.listening, false);
  assert.equal(ended, 0);
  assert.equal(ctx.stopped > 0, true);
});

test('listen with no music plays nothing', () => {
  const { audio } = setup({ clipFields: { kind: 'voice' } });
  assert.equal(audio.listen({ from: 0 }), false);
});
