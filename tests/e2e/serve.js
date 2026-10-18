// Minimal static file server for the e2e tests — serves the repo root
// on 127.0.0.1. Test tooling only. (localhost counts as a secure
// context, so service workers, IndexedDB and crypto.randomUUID behave
// as they do on the real HTTPS site.)
//
// Simulates deploys, the way GitHub Actions stamps sw.js:
// - sw.js is served with __VERSION__ replaced by the current test
//   version, so tests can "deploy" a new version mid-test.
// - GET /__test__/state?version=…&slowInstallMs=… changes that
//   version, and can delay service-worker install fetches (requests
//   that bypass the HTTP cache) to hold a new worker mid-install.
//   Either parameter may be omitted. Responds with the current state.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.argv[2] || 8765);

// Same shape as a real deploy stamp: <40-char sha>-<YYYYMMDDHHMMSS>.
const INITIAL_VERSION = '0123456789abcdef0123456789abcdef01234567-20261018131500';

const state = { version: INITIAL_VERSION, slowInstallMs: 0 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const urlPath = decodeURIComponent(url.pathname);

  if (urlPath === '/__test__/state') {
    if (url.searchParams.has('version')) state.version = url.searchParams.get('version');
    if (url.searchParams.has('slowInstallMs')) state.slowInstallMs = Number(url.searchParams.get('slowInstallMs'));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(state));
    return;
  }

  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }

  // sw.js's install pre-cache uses cache: 'reload', which Chromium
  // sends with Cache-Control: no-cache.
  const bypassesCache = /no-cache/.test(req.headers['cache-control'] || '');
  if (state.slowInstallMs > 0 && bypassesCache && urlPath !== '/sw.js') {
    await sleep(state.slowInstallMs);
  }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    let body = data;
    if (urlPath === '/sw.js') {
      body = Buffer.from(data.toString('utf8').replaceAll('__VERSION__', state.version));
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
