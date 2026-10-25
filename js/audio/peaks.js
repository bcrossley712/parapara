// js/audio/peaks.js
//
// Owns: the sound panel's waveform data (5b) — how loud the sound is
// over time, worked out once per clip from its decoded samples, so
// drawing the waveform (at the tiles' scale, and the whole-file
// overview) never walks the samples again. Pure: takes plain sample
// arrays, no Web Audio. Unit-tested in tests/unit/peaks.test.js.
//
// A peak is the loudest sample (0–1, any channel) in a short bucket of
// time. 100 a second keeps a 3-minute song at 18,000 numbers (~70 KB),
// and is finer than the tiles' scale at 30 fps (~2,700 px a second
// would want more, but one bar per bucket still reads as a waveform).

export const PEAKS_PER_SECOND = 100;

// channels: Float32Array per channel (AudioBuffer.getChannelData);
// sampleRate: samples a second. Returns a Float32Array of peaks.
export function computePeaks(channels, sampleRate, perSecond = PEAKS_PER_SECOND) {
  const samples = channels.length ? channels[0].length : 0;
  if (!(sampleRate > 0) || samples === 0) return new Float32Array(0);
  const bucket = sampleRate / perSecond;
  const count = Math.ceil(samples / bucket);
  const peaks = new Float32Array(count);
  for (const data of channels) {
    for (let b = 0; b < count; b++) {
      const from = Math.floor(b * bucket);
      const to = Math.min(samples, Math.floor((b + 1) * bucket));
      let max = peaks[b];
      for (let i = from; i < to; i++) {
        const v = data[i] < 0 ? -data[i] : data[i];
        if (v > max) max = v;
      }
      peaks[b] = max > 1 ? 1 : max;
    }
  }
  return peaks;
}

// The loudest peak between `from` and `to` seconds (at least the one
// bucket `from` falls in). 0 outside the sound.
export function peakBetween(peaks, from, to, perSecond = PEAKS_PER_SECOND) {
  const first = Math.max(0, Math.floor(from * perSecond));
  const last = Math.min(peaks.length, Math.max(first + 1, Math.ceil(to * perSecond)));
  let max = 0;
  for (let i = first; i < last; i++) if (peaks[i] > max) max = peaks[i];
  return max;
}
