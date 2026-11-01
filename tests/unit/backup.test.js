// Unit tests for the app's side of the backup (step 7b push 1):
// js/backup/crypto.js, scheduler.js and backup.js. backup.js runs
// against a real (fake) IndexedDB and the real Worker code
// (worker/src) on an in-memory R2 — the client's fetch calls the
// Worker's handler directly.
//
// Run: npm run test:unit

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as storage from '../../js/storage/storage.js';
import {
  blobAad, blobName, fromB64u, manifestAad, newVaultSecret, seal, unseal, unwrapSecret, vaultKeys, wrapSecret, SETTINGS_AAD,
} from '../../js/backup/crypto.js';
import { createBackupScheduler } from '../../js/backup/scheduler.js';
import { backupNoticeDue, createBackup, NOTICE_AFTER_MS } from '../../js/backup/backup.js';
import { createBackupClient } from '../../js/backup/client.js';
import { handle } from '../../worker/src/index.js';
import { backupStatusText, backupUsageText } from '../../js/ui/backup-sheet.js';
import { FakeR2 } from '../support/fake-r2.js';
import { b64u, makeSoftPasskey } from '../support/soft-passkey.js';

beforeEach(() => {
  storage._resetForTests();
  globalThis.indexedDB = new IDBFactory();
  storage.onStorageChange(null);
});

const enc = (t) => new TextEncoder().encode(t);

// --- crypto ---

test('the vault secret wraps under a PRF output and only that one unwraps it', async () => {
  const secret = newVaultSecret();
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await wrapSecret(prf, secret);
  assert.equal(fromB64u(wrapped.iv).length, 12);
  assert.deepEqual(await unwrapSecret(prf, wrapped), secret);
  await assert.rejects(unwrapSecret(crypto.getRandomValues(new Uint8Array(32)), wrapped));
});

test('blob names: the same bytes get the same name, other vaults other names', async () => {
  const a = await vaultKeys(newVaultSecret());
  const b = await vaultKeys(newVaultSecret());
  const bytes = enc('a layer');
  const name = await blobName(a, bytes);
  assert.match(name, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await blobName(a, enc('a layer')), name);
  assert.notEqual(await blobName(a, enc('another')), name);
  assert.notEqual(await blobName(b, bytes), name);
  assert.equal(a.enc.extractable, false);
  assert.equal(a.name.extractable, false);
});

test('sealed data opens only with its own associated data', async () => {
  const keys = await vaultKeys(newVaultSecret());
  const sealed = await seal(keys, enc('drawing'), blobAad('x'));
  assert.notDeepEqual(sealed.slice(12), enc('drawing'));
  assert.deepEqual(await unseal(keys, sealed, blobAad('x')), enc('drawing'));
  await assert.rejects(unseal(keys, sealed, blobAad('y')));
  await assert.rejects(unseal(keys, sealed, manifestAad('x')));
  assert.notDeepEqual(await seal(keys, enc('drawing'), blobAad('x')), sealed, 'a fresh iv each time');
});

// --- scheduler ---

function fakeClock() {
  let t = 0;
  let timers = [];
  let seq = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        await next.fn();
      }
      t = end;
    },
    get pending() { return timers.length; },
  };
}

test('scheduler: debounced, at most one run per 2 minutes while drawing', async () => {
  const clock = fakeClock();
  const runs = [];
  const s = createBackupScheduler({ run: async () => { runs.push(clock.now()); return { ok: true }; }, ...clock });
  s.changed();
  await clock.advance(5_000);
  s.changed(); // pushes nothing earlier: due stays at 10 s
  await clock.advance(6_000);
  assert.deepEqual(runs, [10_000]);
  s.changed();
  await clock.advance(30_000);
  assert.equal(runs.length, 1, 'not again within 2 minutes');
  await clock.advance(100_000);
  assert.deepEqual(runs, [10_000, 130_000]);
});

test('scheduler: soon() runs right away; failures back off; offline waits', async () => {
  const clock = fakeClock();
  let ok = false;
  let online = true;
  const runs = [];
  const s = createBackupScheduler({
    run: async () => { runs.push(clock.now()); return { ok }; },
    isOnline: () => online,
    ...clock,
  });
  s.soon();
  await clock.advance(1_000);
  assert.deepEqual(runs, [1_000]);
  await clock.advance(60_000);
  assert.deepEqual(runs, [1_000, 61_000], 'retry after 1 minute');
  await clock.advance(5 * 60_000);
  assert.equal(runs.length, 3, 'then after 5');
  ok = true;
  online = false;
  s.soon();
  await clock.advance(2_000);
  assert.equal(runs.length, 3, 'offline: nothing runs');
  online = true;
  s.soon();
  await clock.advance(1_000);
  assert.equal(runs.length, 4);
  assert.equal(s.failures, 0);
});

test('scheduler: a change during a run brings one more run after it', async () => {
  const clock = fakeClock();
  let release;
  const runs = [];
  const s = createBackupScheduler({
    run: () => {
      runs.push(clock.now());
      if (runs.length > 1) return Promise.resolve({ ok: true });
      return new Promise((r) => { release = () => r({ ok: true }); });
    },
    ...clock,
  });
  s.soon();
  const firing = clock.advance(1_000);
  await new Promise((r) => setImmediate(r));
  s.changed();
  release();
  await firing;
  await clock.advance(200_000);
  assert.equal(runs.length, 2);
});

// --- the notice ---

test('her notice: only after something has waited 3 days, at most once a day', () => {
  const now = 10 * NOTICE_AFTER_MS;
  const state = { vaultId: 'v', noticeAt: null };
  const queue = (since) => ({ dirty: { p: { since, at: now } }, deleted: {}, settings: null });
  assert.equal(backupNoticeDue(state, queue(now - NOTICE_AFTER_MS + 1000), now), false);
  assert.equal(backupNoticeDue(state, queue(now - NOTICE_AFTER_MS - 1000), now), true);
  assert.equal(backupNoticeDue({ ...state, noticeAt: now - 3600e3 }, queue(0), now), false, 'told within the day');
  assert.equal(backupNoticeDue(state, { dirty: {}, deleted: {}, settings: null }, now), false, 'nothing waiting');
  assert.equal(backupNoticeDue(null, queue(0), now), false, 'backup off');
});

// --- backup.js against the real Worker ---

async function setUp() {
  const env = {
    BUCKET: new FakeR2(), RP_ID: 'localhost', ALLOWED_ORIGINS: 'http://localhost:8765',
    INVITES: 'hers:invite-code-123', SIGNING_KEY: 'k',
  };
  const calls = [];
  const fetchFn = (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    return handle(new Request(url, { ...init, headers: { ...init.headers, origin: 'http://localhost:8765' } }), env);
  };
  const client = createBackupClient({ baseUrl: 'https://backup.test', fetchFn });
  // Join with a software passkey, as the Backup sheet would.
  const passkey = await makeSoftPasskey();
  const vaultId = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const secret = newVaultSecret();
  const challenge = await client.challenge('invite-code-123');
  const { token } = await client.join({
    invite: 'invite-code-123', vaultId,
    passkey: await passkey.registration(challenge),
    wrappedKey: await wrapSecret(new Uint8Array(32).fill(3), secret),
  });
  let t = 1_700_000_000_000;
  const now = () => (t += 1000);
  const logs = [];
  const backup = createBackup({ storage, client, now, log: (event, fields) => logs.push({ event, ...fields }), appVersion: async () => 'test' });
  storage.onStorageChange((id, kind) => backup.changed(id, kind));
  await backup.load();
  return { env, calls, client, backup, vaultId, token, secret, logs, auth: `${vaultId}.${token}` };
}

const png = (n) => new Blob([new Uint8Array(200).fill(n)], { type: 'image/png' });

async function blobKeys(env, vaultId) {
  return [...env.BUCKET.objects.keys()].filter((k) => k.startsWith(`vaults/${vaultId}/b/`));
}

test('backup: turning on uploads everything once, encrypted; then only what changed', async () => {
  const s = await setUp();
  const { project, frames } = await storage.createProject('Bunny');
  const ref = frames[0].bitmapRefs[project.layers[0].id];
  await storage.saveLayerBitmap(project.id, ref, png(1));
  await storage.saveThumbnail(project.id, png(2));
  await storage.saveToolSettings({ tool: 'draw' });

  assert.equal(s.backup.enabled, false);
  await s.backup.enable({ vaultId: s.vaultId, token: s.token, passkeyId: 'p', secret: s.secret });
  assert.equal(s.backup.enabled, true);
  assert.equal(s.backup.status().pending, 2, 'the project and the settings');

  let result = await s.backup.run();
  assert.equal(result.ok, true);
  assert.equal(result.projects, 1);
  assert.equal(result.blobs, 2);
  assert.equal(s.backup.status().pending, 0);
  assert.equal((await blobKeys(s.env, s.vaultId)).length, 2);

  // Nothing readable reached the bucket: no project name, no PNG bytes.
  const everything = [...s.env.BUCKET.objects.values()].map((e) => Buffer.from(e.bytes).toString('latin1')).join('|');
  assert.ok(!everything.includes('Bunny'));
  assert.ok(!everything.includes('draw'));
  const keys = await vaultKeys(s.secret);
  const stored = s.env.BUCKET.objects.get((await blobKeys(s.env, s.vaultId))[0]).bytes;
  assert.ok(stored.length > 200, 'iv and tag added');

  // The manifest opens with the vault's keys and is the 7a shape.
  const listed = await s.client.listProjects(s.auth);
  assert.equal(listed.length, 1);
  const m = await s.client.getManifest(s.auth, project.id, listed[0].savedAt);
  const manifest = JSON.parse(new TextDecoder().decode(await unseal(keys, fromB64u(m.data), manifestAad(project.id))));
  assert.equal(manifest.format, 'parapara-backup');
  assert.equal(manifest.project.name, 'Bunny');
  assert.equal(manifest.blobs.length, 2);
  assert.deepEqual([...m.refs].sort(), manifest.blobs.map((b) => b.name).sort());

  // Settings went up too.
  const settings = await s.client.getSettings(s.auth);
  const plain = JSON.parse(new TextDecoder().decode(await unseal(keys, fromB64u(settings.data), SETTINGS_AAD)));
  assert.deepEqual(plain.toolSettings, { tool: 'draw' });

  // A stroke on the layer: one blob up, not two.
  s.calls.length = 0;
  await storage.saveLayerBitmap(project.id, ref, png(3));
  result = await s.backup.run();
  assert.equal(result.blobs, 1);
  assert.equal(s.calls.filter((c) => c.startsWith('PUT /v1/blobs/')).length, 1);

  // No change: no upload at all.
  s.calls.length = 0;
  await storage.saveThumbnail(project.id, png(2)); // same bytes as before
  await s.backup.run();
  assert.ok(!s.calls.some((c) => c.startsWith('PUT')), s.calls.join(', '));
});

test('backup: a duplicated project costs no new blobs; a deleted one leaves a marker', async () => {
  const s = await setUp();
  const { project, frames } = await storage.createProject('A');
  await storage.saveLayerBitmap(project.id, frames[0].bitmapRefs[project.layers[0].id], png(1));
  await s.backup.enable({ vaultId: s.vaultId, token: s.token, passkeyId: 'p', secret: s.secret });
  await s.backup.run();
  const before = (await blobKeys(s.env, s.vaultId)).length;

  // A copy with new ids but the same pixels.
  const { copyProjectRecords } = await import('../../js/storage/layers.js');
  const loaded = await storage.loadProject(project.id);
  const copy = copyProjectRecords(loaded.project, loaded.frames, { name: 'A copy' });
  await storage.saveProjectCopy(copy);
  const result = await s.backup.run();
  assert.equal(result.projects, 1);
  assert.equal(result.blobs, 0);
  assert.equal((await blobKeys(s.env, s.vaultId)).length, before);

  await storage.deleteProject(project.id);
  assert.equal(s.backup.status().pending, 1);
  await s.backup.run();
  const listed = await s.client.listProjects(s.auth);
  assert.deepEqual(listed.find((p) => p.projectId === project.id)?.deleted, true);
  assert.equal(listed.find((p) => p.projectId === copy.project.id)?.deleted, false);
});

test('backup: a failure keeps the work queued and is logged; the next run sends it', async () => {
  const s = await setUp();
  const { project, frames } = await storage.createProject('A');
  await storage.saveLayerBitmap(project.id, frames[0].bitmapRefs[project.layers[0].id], png(1));
  await s.backup.enable({ vaultId: s.vaultId, token: s.token, passkeyId: 'p', secret: s.secret });
  s.env.PAUSED = '1';
  let result = await s.backup.run();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'paused');
  assert.equal(s.backup.status().lastError, 'paused');
  assert.ok(s.backup.status().pending >= 1);
  assert.ok(s.logs.some((l) => l.event === 'backup-failed' && l.error === 'paused'));
  delete s.env.PAUSED;
  result = await s.backup.run();
  assert.equal(result.ok, true);
  assert.equal(s.backup.status().pending, 0);
  assert.equal(s.backup.status().lastError, null);
});

test('backup: the queue survives a relaunch, and catch-up finds what changed meanwhile', async () => {
  const s = await setUp();
  const { project, frames } = await storage.createProject('A');
  const ref = frames[0].bitmapRefs[project.layers[0].id];
  await storage.saveLayerBitmap(project.id, ref, png(1));
  await s.backup.enable({ vaultId: s.vaultId, token: s.token, passkeyId: 'p', secret: s.secret });
  await s.backup.run();

  // Changed while nobody was listening (as if the app closed first).
  storage.onStorageChange(null);
  await storage.saveLayerBitmap(project.id, ref, png(5));
  const again = createBackup({ storage, client: s.client, log: () => {} });
  await again.load();
  assert.equal(again.enabled, true, 'the keys came back from IndexedDB');
  await again.catchUp();
  assert.equal(again.status().pending, 1);
  const result = await again.run();
  assert.equal(result.ok, true);
  assert.equal(result.blobs, 1);
});

// --- the Backup sheet's words ---

test('status line: running, offline, a problem, waiting, backed up', () => {
  const now = 1_000_000_000;
  const base = { running: false, pending: 0, lastError: null, lastOkAt: null };
  assert.equal(backupStatusText({ ...base, running: true }, { now }), 'Backing up…');
  assert.match(backupStatusText({ ...base, pending: 2 }, { online: false, now }), /^Waiting for the internet to back up/);
  assert.match(backupStatusText({ ...base, lastError: 'over-limit' }, { now }), /the backup space is full/);
  assert.match(backupStatusText({ ...base, lastError: 'weird' }, { now }), /the backup server had a problem/);
  assert.equal(backupStatusText({ ...base, lastOkAt: now - 30_000 }, { now }), 'Backed up just now.');
  assert.equal(backupStatusText({ ...base, lastOkAt: now - 5 * 60_000 }, { now }), 'Backed up 5 minutes ago.');
  assert.equal(backupStatusText({ ...base, lastOkAt: now - 26 * 3600e3 }, { now }), 'Backed up yesterday.');
  assert.match(backupStatusText({ ...base, lastOkAt: now - 3600e3, pending: 1 }, { now }), /^Backed up 1 hour ago\. Waiting/);
  assert.equal(backupStatusText(base, { now }), 'Not backed up yet.');
});

test('usage line', () => {
  assert.equal(backupUsageText({ used: 0, limit: 1024 ** 3 }), 'Using nothing yet of 1 GB.');
  assert.equal(backupUsageText({ used: 34.5 * 1024 * 1024, limit: 1024 ** 3 }), 'Using 34.5 MB of 1 GB.');
  assert.equal(backupUsageText(null), '');
});
