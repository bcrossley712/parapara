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

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf']);

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
