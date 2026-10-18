// Enforces the service-worker pre-cache rule from PROJECT_NOTES.md:
// sw.js's APP_SHELL must list every ES module reachable from
// js/main.js. A module missing from the list isn't versioned with the
// rest, so an installed iPad can end up running mismatched old/new
// code. This test fails the deploy instead of letting that ship.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readAppShell() {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const match = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(match, 'APP_SHELL array not found in sw.js');
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

// Follows static relative imports (`import ... from './x.js'` and
// bare `import './x.js'`) starting at main.js. Dynamic import() isn't
// used in the app; if it ever is, extend this.
function reachableModules() {
  const seen = new Set();
  const queue = ['js/main.js'];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      // Ignore commented-out imports.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const specifiers = [
      ...source.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      queue.push(resolved);
    }
  }
  return [...seen];
}

test('every module reachable from main.js is in the service-worker pre-cache', () => {
  const shell = new Set(readAppShell().map((p) => p.replace(/^\.\//, '')));
  const missing = reachableModules().filter((m) => !shell.has(m));
  assert.deepEqual(missing, [], `Add these to APP_SHELL in sw.js: ${missing.join(', ')}`);
});

test('every pre-cache entry exists on disk', () => {
  const missing = readAppShell()
    .map((p) => p.replace(/^\.\//, ''))
    .filter((p) => p !== '' && !fs.existsSync(path.join(ROOT, p)));
  assert.deepEqual(missing, [], `APP_SHELL lists files that don't exist: ${missing.join(', ')}`);
});
