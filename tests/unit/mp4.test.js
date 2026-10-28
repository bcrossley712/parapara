// Unit tests for js/export/mp4.js — the MP4 muxer (step 6a).
// The file is read back with a small box parser written here (not the
// muxer's own code), checking the index a player relies on.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { muxMP4 } from '../../js/export/mp4.js';

function join(parts) {
  const size = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const CONTAINERS = new Set(['moov', 'trak', 'edts', 'mdia', 'minf', 'stbl', 'dinf']);

// [{ type, start, size, body (start..end of payload), children? }]
function parse(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let at = start;
  while (at < end) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    assert.ok(size >= 8 && at + size <= end, `box ${type} at ${at} has a bad size ${size}`);
    const entry = { type, start: at, size, bodyStart: at + 8 };
    if (CONTAINERS.has(type)) entry.children = parse(bytes, at + 8, at + size);
    boxes.push(entry);
    at += size;
  }
  assert.equal(at, end, 'boxes fill their parent exactly');
  return boxes;
}

function find(boxes, path) {
  const [head, ...rest] = path.split('/');
  const hit = boxes.find((b) => b.type === head);
  if (!hit || rest.length === 0) return hit;
  return find(hit.children ?? [], rest.join('/'));
}

const u32At = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
const u16At = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(at);

function sample(fill, length, key = false, duration = 1000) {
  return { data: new Uint8Array(length).fill(fill), duration, key };
}

function video(overrides = {}) {
  return {
    width: 1920,
    height: 1080,
    timescale: 12000,
    description: Uint8Array.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0]),
    samples: [sample(1, 50, true), sample(2, 20), sample(3, 30), sample(4, 40, true), sample(5, 10)],
    ...overrides,
  };
}

test('ftyp, then moov (fast start), then mdat; parts add up to size', () => {
  const { parts, size } = muxMP4({ video: video() });
  const bytes = join(parts);
  assert.equal(bytes.length, size);
  const top = parse(bytes);
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), 'isom');
});

test('each sample sits in mdat where stco + stsz say', () => {
  const v = video();
  const bytes = join(muxMP4({ video: v }).parts);
  const top = parse(bytes);
  const stbl = find(top, 'moov/trak/mdia/minf/stbl');
  const stsz = stbl.children.find((b) => b.type === 'stsz');
  const stco = stbl.children.find((b) => b.type === 'stco');
  const stsc = stbl.children.find((b) => b.type === 'stsc');
  // stsc: one chunk holding every sample
  assert.equal(u32At(bytes, stsc.bodyStart + 4), 1);
  assert.equal(u32At(bytes, stsc.bodyStart + 12), v.samples.length);
  assert.equal(u32At(bytes, stco.bodyStart + 4), 1);
  let offset = u32At(bytes, stco.bodyStart + 8);
  const mdat = top.find((b) => b.type === 'mdat');
  assert.equal(offset, mdat.bodyStart);
  assert.equal(u32At(bytes, stsz.bodyStart + 4), 0, 'sizes listed per sample');
  assert.equal(u32At(bytes, stsz.bodyStart + 8), v.samples.length);
  v.samples.forEach((s, i) => {
    const size = u32At(bytes, stsz.bodyStart + 12 + i * 4);
    assert.equal(size, s.data.length);
    assert.ok(bytes.subarray(offset, offset + size).every((b) => b === s.data[0]), `sample ${i} bytes`);
    offset += size;
  });
  assert.equal(offset, mdat.start + mdat.size);
});

test('keyframes in stss (1-based); left out when every sample is a key', () => {
  const bytes = join(muxMP4({ video: video() }).parts);
  const stbl = find(parse(bytes), 'moov/trak/mdia/minf/stbl');
  const stss = stbl.children.find((b) => b.type === 'stss');
  assert.equal(u32At(bytes, stss.bodyStart + 4), 2);
  assert.equal(u32At(bytes, stss.bodyStart + 8), 1);
  assert.equal(u32At(bytes, stss.bodyStart + 12), 4);

  const allKeys = video({ samples: [sample(1, 5, true), sample(2, 5, true)] });
  const stbl2 = find(parse(join(muxMP4({ video: allKeys }).parts)), 'moov/trak/mdia/minf/stbl');
  assert.equal(stbl2.children.find((b) => b.type === 'stss'), undefined);
});

test('durations: stts runs, mdhd in track ticks, mvhd/tkhd in ms', () => {
  const v = video({
    timescale: 7000, // 7 fps, 1000 ticks a frame
    samples: [sample(1, 5, true), sample(2, 5), sample(3, 5, false, 2000), sample(4, 5)],
  });
  const bytes = join(muxMP4({ video: v }).parts);
  const top = parse(bytes);
  const stts = find(top, 'moov/trak/mdia/minf/stbl').children.find((b) => b.type === 'stts');
  const runs = [];
  const count = u32At(bytes, stts.bodyStart + 4);
  for (let i = 0; i < count; i++) {
    runs.push([u32At(bytes, stts.bodyStart + 8 + i * 8), u32At(bytes, stts.bodyStart + 12 + i * 8)]);
  }
  assert.deepEqual(runs, [[2, 1000], [1, 2000], [1, 1000]]);

  const mdhd = find(top, 'moov/trak/mdia').children.find((b) => b.type === 'mdhd');
  assert.equal(u32At(bytes, mdhd.bodyStart + 12), 7000, 'timescale');
  assert.equal(u32At(bytes, mdhd.bodyStart + 16), 5000, 'duration in ticks');

  const mvhd = find(top, 'moov/mvhd');
  assert.equal(u32At(bytes, mvhd.bodyStart + 12), 1000);
  assert.equal(u32At(bytes, mvhd.bodyStart + 16), 714, '5/7 s in ms');
  const tkhd = find(top, 'moov/trak/tkhd');
  assert.equal(u32At(bytes, tkhd.bodyStart + 20), 714);
});

test('size and decoder config go into tkhd and the avc1 entry', () => {
  const v = video({ width: 1280, height: 720 });
  const bytes = join(muxMP4({ video: v }).parts);
  const top = parse(bytes);
  const tkhd = find(top, 'moov/trak/tkhd');
  assert.equal(u32At(bytes, tkhd.start + tkhd.size - 8), 1280 * 0x10000);
  assert.equal(u32At(bytes, tkhd.start + tkhd.size - 4), 720 * 0x10000);
  const hdlr = find(top, 'moov/trak/mdia').children.find((b) => b.type === 'hdlr');
  assert.equal(String.fromCharCode(...bytes.subarray(hdlr.bodyStart + 8, hdlr.bodyStart + 12)), 'vide');

  const stsd = find(top, 'moov/trak/mdia/minf/stbl').children.find((b) => b.type === 'stsd');
  const entry = stsd.bodyStart + 8;
  assert.equal(String.fromCharCode(...bytes.subarray(entry + 4, entry + 8)), 'avc1');
  assert.equal(u16At(bytes, entry + 8 + 24), 1280);
  assert.equal(u16At(bytes, entry + 8 + 26), 720);
  const avcC = entry + 8 + 78;
  assert.equal(String.fromCharCode(...bytes.subarray(avcC + 4, avcC + 8)), 'avcC');
  assert.equal(u32At(bytes, avcC), 8 + v.description.length);
  assert.deepEqual([...bytes.subarray(avcC + 8, avcC + 8 + v.description.length)], [...v.description]);
  assert.equal(avcC + 8 + v.description.length, stsd.start + stsd.size, 'avcC ends the entry');
});

test('refuses no frames or a missing decoder config', () => {
  assert.throws(() => muxMP4({ video: video({ samples: [] }) }), /No video frames/);
  assert.throws(() => muxMP4({ video: video({ description: null }) }), /decoder configuration/);
});

// --- the audio track (6b) ---

const ASC = Uint8Array.of(0x11, 0x90);

function audio(overrides = {}) {
  return {
    sampleRate: 48000,
    channels: 2,
    description: ASC,
    samples: Array.from({ length: 60 }, (_, i) => ({ data: new Uint8Array(10 + (i % 3)).fill(100 + (i % 50)), duration: 1024 })),
    priming: 2112,
    playSeconds: 1,
    ...overrides,
  };
}

function traks(bytes) {
  return parse(bytes).find((b) => b.type === 'moov').children.filter((b) => b.type === 'trak');
}

// Finds a box by type anywhere under `start..end` by scanning (for
// boxes inside sample entries, which parse() doesn't open).
function scanFor(bytes, type, start, end) {
  for (let at = start; at < end - 8; at++) {
    if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === type) return at;
  }
  return -1;
}

test('audio: a second trak with mp4a, our AudioSpecificConfig in esds, sound handler', () => {
  const { parts } = muxMP4({ video: video(), audio: audio() });
  const bytes = join(parts);
  const [, soundTrak] = traks(bytes);
  assert.ok(soundTrak, 'two tracks');
  const hdlr = find(soundTrak.children, 'mdia/hdlr');
  assert.equal(String.fromCharCode(...bytes.subarray(hdlr.bodyStart + 8, hdlr.bodyStart + 12)), 'soun');
  assert.ok(find(soundTrak.children, 'mdia/minf/smhd'), 'sound media header');
  const stsd = find(soundTrak.children, 'mdia/minf/stbl/stsd');
  const entry = stsd.bodyStart + 8;
  assert.equal(String.fromCharCode(...bytes.subarray(entry + 4, entry + 8)), 'mp4a');
  assert.equal(u16At(bytes, entry + 8 + 16), 2);                 // channels
  assert.equal(u16At(bytes, entry + 8 + 18), 16);                // sample size
  assert.equal(u32At(bytes, entry + 8 + 24), 48000 * 0x10000);   // rate 16.16
  const esds = scanFor(bytes, 'esds', entry, stsd.start + stsd.size);
  assert.ok(esds > 0, 'esds present');
  const esdsEnd = esds + u32At(bytes, esds);
  // DecoderSpecificInfo: tag 5, length 2, then the config.
  const dsi = bytes.subarray(esds, esdsEnd).findIndex((b, i, a) => b === 5 && a[i + 1] === 2);
  assert.deepEqual([...bytes.subarray(esds + dsi + 2, esds + dsi + 4)], [0x11, 0x90]);
  // Object type 0x40 (MPEG-4 audio), stream type audio.
  assert.ok(bytes.subarray(esds, esdsEnd).some((b, i, a) => b === 0x40 && a[i + 1] === 0x15));
  // Every AAC frame is a sync sample: no stss.
  assert.equal(find(soundTrak.children, 'mdia/minf/stbl/stss'), undefined);
});

test('audio: timescale = sample rate; the edit skips the priming and ends with the video', () => {
  const { parts } = muxMP4({ video: video(), audio: audio({ priming: 2112, playSeconds: 1 }) });
  const bytes = join(parts);
  const [videoTrak, soundTrak] = traks(bytes);
  const mdhd = find(soundTrak.children, 'mdia/mdhd');
  assert.equal(u32At(bytes, mdhd.bodyStart + 12), 48000);
  assert.equal(u32At(bytes, mdhd.bodyStart + 16), 60 * 1024);    // all that was encoded
  const elst = find(soundTrak.children, 'edts/elst');
  assert.ok(elst, 'edit list');
  assert.equal(u32At(bytes, elst.bodyStart + 4), 1);             // one edit
  assert.equal(u32At(bytes, elst.bodyStart + 8), 1000);          // 1 s, in movie ms
  assert.equal(u32At(bytes, elst.bodyStart + 12), 2112);         // starts past the priming
  assert.equal(u16At(bytes, elst.bodyStart + 16), 1);            // rate 1
  const tkhd = find(soundTrak.children, 'tkhd');
  assert.equal(u32At(bytes, tkhd.bodyStart + 20), 1000);         // presented length
  assert.equal(u16At(bytes, tkhd.bodyStart + 36), 0x0100);       // volume 1
  // The video has no edit; the movie is the longer of the two.
  assert.equal(find(videoTrak.children, 'edts'), undefined);
  const mvhd = find(parse(bytes), 'moov/mvhd');
  assert.equal(u32At(bytes, mvhd.bodyStart + 16), 1000);
  assert.equal(u32At(bytes, mvhd.bodyStart + 96), 3);            // next track id
});

test('audio: the edit never runs past what was encoded; no priming = from the start', () => {
  const short = join(muxMP4({ video: video(), audio: audio({ priming: 1024, playSeconds: 5 }) }).parts);
  const elst = find(traks(short)[1].children, 'edts/elst');
  assert.equal(u32At(short, elst.bodyStart + 12), 1024);
  assert.equal(u32At(short, elst.bodyStart + 8), Math.round(((60 * 1024 - 1024) / 48000) * 1000));
  const none = join(muxMP4({ video: video(), audio: audio({ priming: 0 }) }).parts);
  assert.equal(u32At(none, find(traks(none)[1].children, 'edts/elst').bodyStart + 12), 0);
});

test('audio samples sit in mdat after the video’s, where stco + stsz say', () => {
  const v = video();
  const a = audio();
  const bytes = join(muxMP4({ video: v, audio: a }).parts);
  const [videoTrak, soundTrak] = traks(bytes);
  const videoStco = find(videoTrak.children, 'mdia/minf/stbl/stco');
  const soundStco = find(soundTrak.children, 'mdia/minf/stbl/stco');
  const soundStsz = find(soundTrak.children, 'mdia/minf/stbl/stsz');
  const videoBytes = v.samples.reduce((sum, s) => sum + s.data.length, 0);
  let at = u32At(bytes, soundStco.bodyStart + 8);
  assert.equal(at, u32At(bytes, videoStco.bodyStart + 8) + videoBytes);
  assert.equal(u32At(bytes, soundStsz.bodyStart + 8), a.samples.length);
  a.samples.forEach((s, i) => {
    const size = u32At(bytes, soundStsz.bodyStart + 12 + i * 4);
    assert.equal(size, s.data.length);
    assert.deepEqual(bytes.subarray(at, at + size), s.data);
    at += size;
  });
  assert.equal(at, bytes.length);
});

test('audio without frames or a config is refused; none at all is a video-only file', () => {
  assert.throws(() => muxMP4({ video: video(), audio: audio({ samples: [] }) }), /audio frames/);
  assert.throws(() => muxMP4({ video: video(), audio: audio({ description: new Uint8Array() }) }), /AAC/);
  assert.equal(traks(join(muxMP4({ video: video(), audio: null }).parts)).length, 1);
});
