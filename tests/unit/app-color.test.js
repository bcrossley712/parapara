// Unit tests for the App color choice: js/ui/app-color.js.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  APP_COLORS,
  DEFAULT_APP_COLOR,
  APP_COLOR_STORAGE_KEY,
  sanitizeAppColor,
  appColorVars,
  applyAppColor,
  readStoredAppColor,
  writeStoredAppColor,
} from '../../js/ui/app-color.js';

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('a missing or unknown saved color is purple', () => {
  assert.equal(DEFAULT_APP_COLOR, 'purple');
  for (const bad of [undefined, null, '', 'rainbow', 3, {}]) {
    assert.equal(sanitizeAppColor(bad), 'purple');
  }
  for (const { id } of APP_COLORS) assert.equal(sanitizeAppColor(id), id);
});

test('every choice keeps white text readable on its accent, and dark text on its bars', () => {
  for (const c of APP_COLORS) {
    assert.ok(contrast(c.accent, '#ffffff') >= 4.5, `${c.id}: white on accent`);
    assert.ok(contrast(c.accentActive, c.accentSoft) >= 4.5, `${c.id}: New animation text`);
    assert.ok(contrast('#2f2d33', c.surface) >= 7, `${c.id}: text on the bars`);
    assert.ok(luminance(c.surface) > 0.8, `${c.id}: bars stay light (status bar text stays dark)`);
  }
});

test("purple's values match the stylesheet's own", () => {
  const css = fs.readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  for (const [name, value] of Object.entries(appColorVars('purple'))) {
    const match = root.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
    assert.ok(match, `${name} is in :root`);
    assert.equal(match[1].toLowerCase(), value, name);
  }
});

function fakeDoc() {
  const props = new Map();
  const meta = { content: '#f5f1fc', setAttribute(k, v) { this[k] = v; } };
  return {
    props,
    meta,
    documentElement: {
      style: {
        setProperty: (k, v) => props.set(k, v),
        removeProperty: (k) => props.delete(k),
      },
    },
    querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null),
  };
}

test('applying a color sets the tokens and theme-color; purple clears them', () => {
  const doc = fakeDoc();
  assert.equal(applyAppColor(doc, 'pink'), 'pink');
  assert.equal(doc.props.get('--pp-accent'), '#c23d78');
  assert.equal(doc.meta.content, '#fcf1f6');
  assert.equal(applyAppColor(doc, 'nonsense'), 'purple');
  assert.equal(doc.props.size, 0);
  assert.equal(doc.meta.content, '#f5f1fc');
});

test('the localStorage copy round-trips and survives storage errors', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(readStoredAppColor(storage), 'purple');
  writeStoredAppColor(storage, 'teal');
  assert.equal(store.get(APP_COLOR_STORAGE_KEY), 'teal');
  assert.equal(readStoredAppColor(storage), 'teal');
  const broken = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
  assert.equal(readStoredAppColor(broken), 'purple');
  assert.doesNotThrow(() => writeStoredAppColor(broken, 'pink'));
  assert.equal(readStoredAppColor(undefined), 'purple');
});
