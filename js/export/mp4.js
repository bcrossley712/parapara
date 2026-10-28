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
// Tracks: video (H.264 'avc1') and, when the animation has sound
// (6b), audio (AAC 'mp4a' + 'esds') — `buildTrack` is shared, only the
// sample entry and the media header differ. 32-bit offsets (stco):
// fine below 4 GB.
//
// The audio track has an edit list (edts/elst, 6b): an AAC encoder
// puts some silence ("priming") before the sound, so the edit starts
// the track `priming` samples in — the sound starts with frame 1, as
// she set it — and ends it with the video (the last block is padded).
// Players skip the priming by the edit; Apple's honor it.

const MOVIE_TIMESCALE = 1000; // mvhd/tkhd durations in ms

// video: {
//   width, height,            // pixels, as encoded
//   timescale,                // ticks per second for `duration`
//   description,              // Uint8Array: the AVCDecoderConfigurationRecord
//                             //   (WebCodecs' decoderConfig.description)
//   samples: [{ data: Uint8Array, duration, key }],  // in decode order
// }
// audio (optional, 6b): {
//   sampleRate, channels,     // as encoded; sampleRate is the timescale
//   description,              // Uint8Array: the AudioSpecificConfig
//   samples: [{ data, duration }],  // AAC frames, duration in samples (1024)
//   priming,                  // samples of encoder silence to skip (≥ 0)
//   playSeconds,              // how long the sound should play (the video's length)
// }
// Returns { parts: Uint8Array[], size } — the file, in order, as parts
// so the caller can make a Blob without copying every sample again.
export function muxMP4({ video, audio = null }) {
  if (!video || !video.samples?.length) throw new Error('No video frames to save');
  if (!(video.description instanceof Uint8Array) || video.description.length === 0) {
    throw new Error('Missing H.264 decoder configuration');
  }
  const tracks = [{ ...video, kind: 'video', id: 1 }];
  if (audio) {
    if (!audio.samples?.length) throw new Error('No audio frames to save');
    if (!(audio.description instanceof Uint8Array) || audio.description.length === 0) {
      throw new Error('Missing AAC decoder configuration');
    }
    tracks.push({
      ...audio,
      kind: 'audio',
      id: 2,
      timescale: audio.sampleRate,
      samples: audio.samples.map((s) => ({ ...s, key: true })),
      edit: audioEdit(audio),
    });
  }

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

// The audio track's edit: start `priming` samples in, play
// `playSeconds` (never past the end of what was encoded).
function audioEdit({ sampleRate, samples, priming = 0, playSeconds }) {
  const total = samples.reduce((sum, s) => sum + s.duration, 0);
  const start = Math.max(0, Math.min(Math.round(priming) || 0, total - 1));
  const available = total - start;
  const wanted = Number.isFinite(playSeconds) && playSeconds > 0
    ? Math.round(playSeconds * sampleRate)
    : available;
  return { mediaTime: start, duration: Math.max(1, Math.min(wanted, available)) };
}

// The track's length as presented, in its own ticks: the edit's, if any.
function presentedDuration(track) {
  return track.edit ? track.edit.duration : trackDuration(track);
}

function buildMoov(tracks, chunkOffsets) {
  const movieDuration = Math.max(...tracks.map((t) => toMovieTime(presentedDuration(t), t.timescale)));
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
  const presented = toMovieTime(presentedDuration(track), track.timescale);
  const tkhd = fullBox('tkhd', 0, 0x3, [ // enabled | in movie
    u32(0), u32(0),
    u32(track.id), zeros(4),
    u32(presented),
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
  // edts/elst: one edit — `presented` ms of the track, from mediaTime
  // (in the track's ticks), at normal speed.
  const edts = track.edit
    ? [box('edts', [fullBox('elst', 0, 0, [
      u32(1), u32(presented), u32(track.edit.mediaTime), u16(1), u16(0),
    ])])]
    : [];
  return box('trak', [tkhd, ...edts, box('mdia', [mdhd, hdlr, box('minf', [mediaHeader, dinf, stbl])])]);
}

function sampleEntry(track) {
  if (track.kind === 'audio') return audioSampleEntry(track);
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

// AAC: 'mp4a' with an 'esds' carrying the AudioSpecificConfig (our
// own — see aac.js for why the encoder's isn't used).
function audioSampleEntry(track) {
  const bytes = track.samples.map((s) => s.data.length);
  const seconds = trackDuration(track) / track.timescale;
  const avgBitrate = seconds > 0 ? Math.round((bytes.reduce((a, b) => a + b, 0) * 8) / seconds) : 0;
  const maxFrame = Math.max(...bytes);
  const maxBitrate = Math.round((maxFrame * 8 * track.timescale) / 1024);
  const decoderSpecific = descriptor(5, [track.description]);
  const decoderConfig = descriptor(4, [
    u8(0x40),                      // object type: MPEG-4 Audio
    u8((0x05 << 2) | 1),           // stream type: audio, reserved bit
    u24(maxFrame), u32(maxBitrate), u32(avgBitrate),
    decoderSpecific,
  ]);
  const es = descriptor(3, [
    u16(0),                        // ES_ID
    u8(0),                         // no dependency, URL or OCR
    decoderConfig,
    descriptor(6, [u8(2)]),        // SLConfig: predefined for MP4
  ]);
  return box('mp4a', [
    zeros(6), u16(1),              // reserved, data reference index
    zeros(8),                      // reserved
    u16(track.channels), u16(16),  // channel count, sample size
    u16(0), u16(0),                // pre_defined, reserved
    u32(track.timescale * 0x10000), // sample rate, 16.16
    fullBox('esds', 0, 0, [es]),
  ]);
}

// An MPEG-4 descriptor: tag, size (one byte while < 128, else the
// 4-byte form), body.
function descriptor(tag, children) {
  const body = concat(children);
  const size = body.length < 0x80
    ? [body.length]
    : [0x80 | ((body.length >> 21) & 0x7f), 0x80 | ((body.length >> 14) & 0x7f), 0x80 | ((body.length >> 7) & 0x7f), body.length & 0x7f];
  return concat([Uint8Array.from([tag, ...size]), body]);
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

function u8(n) {
  return Uint8Array.of(n & 0xff);
}

function u24(n) {
  return Uint8Array.of((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
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
