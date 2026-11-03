// js/ui/app-color.js
//
// App color (after the light theme): she picks the app's color in the
// gear menu. Each choice is a set of values for the color tokens in
// style.css's :root — the strong accent (white text on it, every one
// checked at ≥ 4.5:1), its pressed shade, its pale tint (selected
// rows, pressed buttons), the bars' very pale tint, and a partner
// color for the Voice waveform so it never blends into Music (which
// follows the accent). Everything else (borders, the gallery's
// backdrop) is mixed from these in style.css.
//
// Saved app-wide in uiState.appColor (missing = 'purple'), mirrored to
// localStorage so the launch can paint her color before the database
// opens.
//
// No DOM access at import time (unit-tested in Node).

export const APP_COLORS = [
  { id: 'purple', name: 'Purple', accent: '#7a52c7', accentActive: '#6643ad', accentSoft: '#e6dcf8', surface: '#f5f1fc', voice: '#1f9e9a' },
  { id: 'pink',   name: 'Pink',   accent: '#c23d78', accentActive: '#a83266', accentSoft: '#f8dbe8', surface: '#fcf1f6', voice: '#1f9e9a' },
  { id: 'teal',   name: 'Teal',   accent: '#127f7a', accentActive: '#0e6b67', accentSoft: '#d3f0ee', surface: '#eff8f7', voice: '#8a63d2' },
  { id: 'blue',   name: 'Blue',   accent: '#2f6fd0', accentActive: '#255cb1', accentSoft: '#dce8fa', surface: '#f1f5fc', voice: '#d0631a' },
  { id: 'orange', name: 'Orange', accent: '#bf5610', accentActive: '#a3480c', accentSoft: '#fbe2cf', surface: '#fcf4ee', voice: '#2f6fd0' },
  { id: 'green',  name: 'Green',  accent: '#2e7d32', accentActive: '#256a29', accentSoft: '#dcefd9', surface: '#f2f8f1', voice: '#8a63d2' },
];

export const DEFAULT_APP_COLOR = 'purple';

// The localStorage copy, read at launch before the database is open.
export const APP_COLOR_STORAGE_KEY = 'parapara-app-color';

// Any saved value → a known id (missing or unknown = purple).
export function sanitizeAppColor(id) {
  return APP_COLORS.some((c) => c.id === id) ? id : DEFAULT_APP_COLOR;
}

export function getAppColor(id) {
  return APP_COLORS.find((c) => c.id === sanitizeAppColor(id));
}

// The CSS custom properties a choice sets on :root.
export function appColorVars(id) {
  const c = getAppColor(id);
  return {
    '--pp-accent': c.accent,
    '--pp-accent-active': c.accentActive,
    '--pp-accent-soft': c.accentSoft,
    '--pp-surface': c.surface,
    '--pp-sound-voice': c.voice,
  };
}

// Paints a choice: the tokens on <html>, and theme-color to match the
// top bar (iPadOS picks the status bar's text color from it; every
// choice is light, so the text should stay dark). Purple is the
// stylesheet's own values, so it clears the overrides instead.
export function applyAppColor(doc, id) {
  const clean = sanitizeAppColor(id);
  const root = doc.documentElement;
  for (const [name, value] of Object.entries(appColorVars(clean))) {
    if (clean === DEFAULT_APP_COLOR) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getAppColor(clean).surface);
  return clean;
}

// The localStorage copy. Either may fail (private mode, storage off);
// then the launch just starts purple until the database answers.
export function readStoredAppColor(storage) {
  try {
    return sanitizeAppColor(storage?.getItem(APP_COLOR_STORAGE_KEY));
  } catch {
    return DEFAULT_APP_COLOR;
  }
}

export function writeStoredAppColor(storage, id) {
  try {
    storage?.setItem(APP_COLOR_STORAGE_KEY, sanitizeAppColor(id));
  } catch {
    // Not worth interrupting her; the database copy still has it.
  }
}
