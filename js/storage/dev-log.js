// js/storage/dev-log.js
//
// DEV ONLY (added while hunting a frame that lost its drawing, after
// 4b): an activity log of the last few hundred things that happened —
// strokes, saves with their sizes, frame loads, undo/redo, playback.
// One line each, newest last, kept in localStorage so it survives the
// app being closed or reloaded. Read from the gear menu's Developer
// section (ui/dev-log-view.js) and copied out when something goes
// wrong. Remove with the rest of the Developer section.
//
// Never throws: a log that can't be written is just a shorter log.
// createDevLog is unit-tested (tests/unit/dev-log.test.js) with a fake
// storage; the app uses the shared `devLog` below.

export const DEV_LOG_KEY = 'parapara-dev-log';
export const DEV_LOG_MAX = 300;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked storage throws on access
  }
}

// "13:42:07.315"
function clock(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

// A value as a short log token: numbers and strings as they are,
// objects as k=v pairs, null/undefined as '-'.
function token(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function createDevLog({ storage = defaultStorage(), now = () => new Date(), max = DEV_LOG_MAX } = {}) {
  let lines = null; // loaded lazily

  function load() {
    if (lines) return lines;
    lines = [];
    try {
      const saved = JSON.parse(storage?.getItem(DEV_LOG_KEY) ?? '[]');
      if (Array.isArray(saved)) lines = saved.filter((l) => typeof l === 'string').slice(-max);
    } catch {
      // unreadable: start over
    }
    return lines;
  }

  function persist() {
    try {
      storage?.setItem(DEV_LOG_KEY, JSON.stringify(lines));
    } catch {
      // full or blocked: keep it in memory only
    }
  }

  return {
    // add('save', { frame: 'f2#ab12', bytes: 5120 }) →
    // "13:42:07.315 save frame=f2#ab12 bytes=5120"
    add(event, details = {}) {
      load();
      const parts = [clock(now()), event];
      if (typeof details === 'string') {
        parts.push(details);
      } else {
        for (const [k, v] of Object.entries(details)) parts.push(`${k}=${token(v)}`);
      }
      lines.push(parts.join(' '));
      if (lines.length > max) lines.splice(0, lines.length - max);
      persist();
    },

    // The log as text, oldest first.
    read() {
      return load().join('\n');
    },

    clear() {
      lines = [];
      persist();
    },
  };
}

export const devLog = createDevLog();
