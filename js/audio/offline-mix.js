// js/audio/offline-mix.js
//
// Owns: the export's sound (step 6b) — the project's clips mixed into
// one AudioBuffer as long as the video, on an OfflineAudioContext
// (faster than real time). export/aac.js encodes it.
//
// It must sound like Play (Sound → Don't break): the same buildMix
// (each take's leveling, the loudness compressor, the row volumes, the
// limiter) and the same placement (clipPlacement — where each clip
// starts, its trim, cut at the last frame), from frame 1 with no loop:
// the video is the animation once.
//
// Pure apart from the context, which is passed in (tests use a fake).

import { buildMix } from './audio.js';
import { clipPlacement, clipVolume, CLIP_KINDS } from './clip.js';

// What plays where: [{ clip, buffer, at, from, to }] for each decoded
// clip that sounds within `seconds` (entries without a buffer — not
// decoded, or failed — are left out, as Play leaves them out).
export function mixPlan(entries, seconds) {
  const plan = [];
  for (const entry of entries ?? []) {
    if (!entry?.clip || !entry.buffer) continue;
    const placement = clipPlacement(entry.clip, seconds);
    if (placement) plan.push({ clip: entry.clip, buffer: entry.buffer, ...placement });
  }
  return plan;
}

function defaultOfflineContext(channels, length, sampleRate) {
  const Ctor = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Ctor) throw new Error('This browser can’t mix sound offline');
  return new Ctor(channels, length, sampleRate);
}

// Mixes `entries` ([{ clip, buffer }]) for `seconds`. Resolves the
// AudioBuffer (sampleRate × channels), or null when nothing would play
// (no sound, or all of it after the last frame).
export async function renderMix({
  entries,
  seconds,
  sampleRate,
  channels = 2,
  createContext = defaultOfflineContext,
}) {
  const plan = mixPlan(entries, seconds);
  if (plan.length === 0 || !(seconds > 0)) return null;
  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const ctx = createContext(channels, length, sampleRate);
  const mix = buildMix(ctx);
  for (const kind of CLIP_KINDS) {
    const entry = plan.find((p) => (p.clip.kind ?? 'music') === kind);
    mix.setVolume(kind, entry ? clipVolume(entry.clip) : 1, { immediate: true });
  }
  for (const { clip, buffer, at, from, to } of plan) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    mix.connect(source, clip);
    source.start(at, from, to - from);
  }
  return ctx.startRendering();
}
