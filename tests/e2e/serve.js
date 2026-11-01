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
//
// Hosts the backup Worker (step 7b): /__backup__/… runs the real
// worker/src code on an in-memory R2 (tests/support/fake-r2.js), with
// RP_ID localhost — specs open the app as localhost (an IP address
// isn't a valid passkey domain) and point it here by setting
// window.__PARAPARA_BACKUP_URL__. Invite code: e2e-invite-code.
// GET /__test__/backup?vault=<id> lists that vault's stored keys.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../../worker/src/index.js';
import { FakeR2 } from '../support/fake-r2.js';

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

const backupEnv = {
  BUCKET: new FakeR2(),
  RP_ID: 'localhost',
  ALLOWED_ORIGINS: `http://localhost:${PORT},http://127.0.0.1:${PORT}`,
  INVITES: 'e2e:e2e-invite-code',
  SIGNING_KEY: 'e2e-signing-key',
};

async function serveBackup(req, res, urlPath, search) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const request = new Request(`http://localhost:${PORT}${urlPath.slice('/__backup__'.length)}${search}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const response = await worker.fetch(request, backupEnv);
  const out = {};
  response.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(response.status, { ...out, 'Cache-Control': 'no-store' });
  res.end(Buffer.from(await response.arrayBuffer()));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const urlPath = decodeURIComponent(url.pathname);

  if (urlPath.startsWith('/__backup__/')) {
    await serveBackup(req, res, urlPath, url.search);
    return;
  }
  if (urlPath === '/__test__/backup') {
    const vault = url.searchParams.get('vault') ?? '';
    const keys = [...backupEnv.BUCKET.objects.keys()].filter((k) => k.startsWith(`vaults/${vault}/`));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ keys }));
    return;
  }

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
