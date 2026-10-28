// js/export/mp4.js
//
// Owns: writing an MP4 file (ISO BMFF) from already-encoded samples
// (step 6a) — the "muxer". The encoders (WebCodecs, export.js) make
// the compressed frames; this file only lays them out with the index a
// player needs. Pure: no DOM, no browser APIs, so it's unit-tested
// (tests/unit/mp4.test.js).
//
// Layout: ftyp, moov (the index), mdat (the samples) — the index first
// ("fast start"), so a phone can start playing before reading the
// whole file. Everything is in memory (an export is a few MB), so the
// index is written after all samples are known. Each track's samples
// are one chunk in mdat, tracks one after another — no interleaving;
// short files don't need it.
//
// Tracks: video (H.264 'avc1') now; step 6b adds an audio track
// ('mp4a') beside it — `buildTrack` is shared, only the sample entry
// and the media header differ. 32-bit offsets (stco): fine below 4 GB.

const MOVIE_TIMESCALE = 1000; // mvhd/tkhd durations in ms

// video: {
//   width, height,            // pixels, as encoded
//   timescale,                // ticks per second for `duration`
//   description,              // Uint8Array: the AVCDecoderConfigurationRecord
//                             //   (WebCodecs' decoderConfig.description)
//   samples: [{ data: Uint8Array, duration, key }],  // in decode order
// }
// Returns { parts: Uint8Array[], size } — the file, in order, as parts
// so the caller can make a Blob without copying every sample again.
export function muxMP4({ video }) {
  if (!video || !video.samples?.length) throw new Error('No video frames to save');
  if (!(video.description instanceof Uint8Array) || video.description.length === 0) {
    throw new Error('Missing H.264 decoder configuration');
  }
  const tracks = [{ ...video, kind: 'video', id: 1 }];

  const ftyp = box('ftyp', [
    str4('isom'), u32(0x200),
    str4('isom'), str4('iso2'), str4('avc1'), str4('mp41'),
  ]);

  // The moov's size doesn't depend on the offsets in it (stco entries
  // are fixed-size), so build once to measure, then again with them.
  const offsetsFor = (moovSize) => {
    let at = ftyp.length + moovSize + 8; // + mdat header
    return tracks.map((track) => {
      const offset = at;
      at += track.samples.reduce((sum, s) => sum + s.data.length, 0);
      return offset;
    });
  };
  const draft = buildMoov(tracks, tracks.map(() => 0));
  const moov = buildMoov(tracks, offsetsFor(draft.length));

  const payload = tracks.flatMap((track) => track.samples.map((s) => s.data));
  const payloadSize = payload.reduce((sum, d) => sum + d.length, 0);
  const mdatHeader = concat([u32(8 + payloadSize), str4('mdat')]);

  const parts = [ftyp, moov, mdatHeader, ...payload];
  const size = parts.reduce((sum, p) => sum + p.length, 0);
  return { parts, size };
}

// --- moov ---

function buildMoov(tracks, chunkOffsets) {
  const movieDuration = Math.max(...tracks.map((t) => toMovieTime(trackDuration(t), t.timescale)));
  const mvhd = fullBox('mvhd', 0, 0, [
    u32(0), u32(0),                // creation, modification time
    u32(MOVIE_TIMESCALE), u32(movieDuration),
    u32(0x00010000),               // rate 1.0
    u16(0x0100), zeros(2),         // volume 1.0, reserved
    zeros(8),                      // reserved
    matrix(),
    zeros(24),                     // pre_defined
    u32(tracks.length + 1),        // next track id
  ]);
  return box('moov', [mvhd, ...tracks.map((t, i) => buildTrack(t, chunkOffsets[i]))]);
}

function buildTrack(track, chunkOffset) {
  const video = track.kind === 'video';
  const duration = trackDuration(track);
  const tkhd = fullBox('tkhd', 0, 0x3, [ // enabled | in movie
    u32(0), u32(0),
    u32(track.id), zeros(4),
    u32(toMovieTime(duration, track.timescale)),
    zeros(8),
    u16(0), u16(0),                // layer, alternate group
    u16(video ? 0 : 0x0100), zeros(2), // volume (audio only)
    matrix(),
    u32(video ? track.width * 0x10000 : 0),
    u32(video ? track.height * 0x10000 : 0),
  ]);
  const mdhd = fullBox('mdhd', 0, 0, [
    u32(0), u32(0),
    u32(track.timescale), u32(duration),
    u16(0x55c4),                   // language 'und'
    u16(0),
  ]);
  const hdlr = fullBox('hdlr', 0, 0, [
    u32(0),
    str4(video ? 'vide' : 'soun'),
    zeros(12),
    ascii(video ? 'VideoHandler\0' : 'SoundHandler\0'),
  ]);
  const mediaHeader = video
    ? fullBox('vmhd', 0, 1, [u16(0), zeros(6)])
    : fullBox('smhd', 0, 0, [u16(0), u16(0)]);
  const dinf = box('dinf', [
    fullBox('dref', 0, 0, [u32(1), fullBox('url ', 0, 1, [])]),
  ]);
  const stbl = box('stbl', [
    fullBox('stsd', 0, 0, [u32(1), sampleEntry(track)]),
    stts(track.samples),
    ...(track.samples.every((s) => s.key) ? [] : [stss(track.samples)]),
    fullBox('stsc', 0, 0, [u32(1), u32(1), u32(track.samples.length), u32(1)]),
    fullBox('stsz', 0, 0, [u32(0), u32(track.samples.length), ...track.samples.map((s) => u32(s.data.length))]),
    fullBox('stco', 0, 0, [u32(1), u32(chunkOffset)]),
  ]);
  return box('trak', [tkhd, box('mdia', [mdhd, hdlr, box('minf', [mediaHeader, dinf, stbl])])]);
}

function sampleEntry(track) {
  if (track.kind !== 'video') throw new Error(`Unsupported track kind ${track.kind}`);
  return box('avc1', [
    zeros(6), u16(1),              // reserved, data reference index
    zeros(16),                     // pre_defined, reserved
    u16(track.width), u16(track.height),
    u32(0x00480000), u32(0x00480000), // 72 dpi
    zeros(4),
    u16(1),                        // frame count
    zeros(32),                     // compressor name
    u16(0x0018), u16(0xffff),      // depth, pre_defined -1
    box('avcC', [track.description]),
  ]);
}

// Sample durations, run-length coded.
function stts(samples) {
  const runs = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last.duration === s.duration) last.count++;
    else runs.push({ count: 1, duration: s.duration });
  }
  return fullBox('stts', 0, 0, [u32(runs.length), ...runs.flatMap((r) => [u32(r.count), u32(r.duration)])]);
}

// Keyframes, 1-based sample numbers.
function stss(samples) {
  const keys = [];
  samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
  return fullBox('stss', 0, 0, [u32(keys.length), ...keys.map(u32)]);
}

function trackDuration(track) {
  return track.samples.reduce((sum, s) => sum + s.duration, 0);
}

function toMovieTime(duration, timescale) {
  return Math.round((duration * MOVIE_TIMESCALE) / timescale);
}

// --- bytes ---

function box(type, children) {
  const body = concat(children);
  return concat([u32(8 + body.length), str4(type), body]);
}

function fullBox(type, version, flags, children) {
  return box(type, [u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...children]);
}

function matrix() {
  return concat([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
  ]);
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff);
  return b;
}

function zeros(n) {
  return new Uint8Array(n);
}

function str4(s) {
  if (s.length !== 4) throw new Error(`Box type must be 4 characters: ${s}`);
  return ascii(s);
}

function ascii(s) {
  return Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}

function concat(parts) {
  const size = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
