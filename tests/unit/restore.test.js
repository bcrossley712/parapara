// Unit tests for restore (step 7b push 2): js/backup/restore.js and the
// restore sheet's wording, plus backup.js's restore hooks. One device
// backs up to the real Worker (worker/src) on an in-memory R2; a
// second, fresh device (a new fake IndexedDB) signs in with the same
// software passkey and brings the drawings back.
//
// Run: npm run test:unit

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as storage from '../../js/storage/storage.js';
import { newVaultSecret, wrapSecret } from '../../js/backup/crypto.js';
import { createBackup } from '../../js/backup/backup.js';
import { createBackupClient } from '../../js/backup/client.js';
import { createRestore } from '../../js/backup/restore.js';
import { defaultPicks, restoreButtonLabel, restoreDoneText } from '../../js/ui/restore-sheet.js';
import { handle } from '../../worker/src/index.js';
import { FakeR2 } from '../support/fake-r2.js';
import { b64u, unb64u, makeSoftPasskey } from '../support/soft-passkey.js';

function freshDevice() {
  storage._resetForTests();
  globalThis.indexedDB = new IDBFactory();
  storage.onStorageChange(null);
}

beforeEach(freshDevice);

const png = (n, size = 200) => new Blob([new Uint8Array(size).fill(n)], { type: 'image/png' });
const PRF = new Uint8Array(32).fill(7);

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
  const passkey = await makeSoftPasskey();
  const vaultId = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const secret = newVaultSecret();
  const challenge = await client.challenge('invite-code-123');
  const { token } = await client.join({
    invite: 'invite-code-123', vaultId,
    passkey: await passkey.registration(challenge),
    wrappedKey: await wrapSecret(PRF, secret),
  });
  let t = 1_700_000_000_000;
  const now = () => (t += 1000);
  const logs = [];
  const log = (event, fields) => logs.push({ event, ...fields });

  // A device: its own backup and restore over whatever storage is current.
  async function device() {
    const backup = createBackup({ storage, client, now, log, appVersion: async () => 'test' });
    storage.onStorageChange((id, kind) => backup.changed(id, kind));
    await backup.load();
    const restore = createRestore({ storage, client, backup, now, log });
    return { backup, restore };
  }

  // What signInWithPasskey would give on a device with her passkey.
  async function signIn({ prf = PRF } = {}) {
    const c = await client.challenge();
    const a = await passkey.assertion(c, vaultId);
    return {
      credentialId: unb64u(a.credentialId),
      userHandle: unb64u(vaultId),
      prf: { first: prf },
      response: { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature },
    };
  }

  return { env, calls, client, vaultId, token, secret, logs, device, signIn };
}

// Her first iPad: two projects drawn, one deleted, settings, backed up.
async function firstIPad(s) {
  const a = await s.device();
  const bunny = await storage.createProject('Bunny');
  const bunnyRef = bunny.frames[0].bitmapRefs[bunny.project.layers[0].id];
  await storage.saveLayerBitmap(bunny.project.id, bunnyRef, png(1));
  await storage.saveThumbnail(bunny.project.id, png(9));
  const cat = await storage.createProject('Cat');
  await storage.saveLayerBitmap(cat.project.id, cat.frames[0].bitmapRefs[cat.project.layers[0].id], png(2));
  const gone = await storage.createProject('Old one');
  await storage.saveLayerBitmap(gone.project.id, gone.frames[0].bitmapRefs[gone.project.layers[0].id], png(3));
  await storage.saveToolSettings({ tool: 'erase', size: 12 });
  await storage.saveRecentColors(['#123456']);
  await a.backup.enable({ vaultId: s.vaultId, token: s.token, passkeyId: 'p', secret: s.secret });
  assert.equal((await a.backup.run()).ok, true);
  await storage.deleteProject(gone.project.id);
  assert.equal((await a.backup.run()).deleted, 1);
  return { bunny, bunnyRef, cat, gone };
}

test('a fresh iPad signs in, sees the backup, and gets the drawings back as themselves', async () => {
  const s = await setUp();
  const { bunny, bunnyRef, cat, gone } = await firstIPad(s);

  freshDevice();
  const b = await s.device();
  assert.equal(b.backup.enabled, false);
  const { settings } = await b.restore.connect(await s.signIn(), { fresh: true });
  assert.equal(b.backup.enabled, true, 'signing in turns backup on here');
  assert.deepEqual(settings.toolSettings, { tool: 'erase', size: 12 });
  assert.deepEqual(await storage.loadToolSettings(), { tool: 'erase', size: 12 });
  assert.deepEqual(await storage.loadRecentColors(), ['#123456']);

  const items = await b.restore.list();
  assert.deepEqual(items.map((i) => [i.name, i.deleted, i.here]).sort(), [
    ['Bunny', false, false], ['Cat', false, false], ['Old one', true, false],
  ]);
  const bunnyItem = items.find((i) => i.projectId === bunny.project.id);
  assert.equal(bunnyItem.frameCount, 1);
  assert.deepEqual(bunnyItem.thumbnail.bytes, new Uint8Array(200).fill(9), 'the thumbnail, decrypted');
  assert.equal(items.find((i) => i.projectId === cat.project.id).thumbnail, null, 'none was saved');
  assert.deepEqual([...defaultPicks(items)].sort(), [bunny.project.id, cat.project.id].sort(), 'deleted ones start unticked');

  const progress = [];
  const result = await b.restore.restore(items.filter((i) => !i.deleted), { onProgress: (p) => progress.push(p) });
  assert.equal(result.restored, 2);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(progress.map((p) => p.done), [0, 1, 2]);

  // Same ids, same pixels.
  const back = await storage.loadProject(bunny.project.id);
  assert.equal(back.project.name, 'Bunny');
  assert.equal(back.frames[0].id, bunny.frames[0].id);
  const blobs = await storage.loadBlobs([bunnyRef]);
  assert.deepEqual(new Uint8Array(blobs.get(bunnyRef).buffer), new Uint8Array(200).fill(1));
  assert.ok(await storage.loadThumbnail(bunny.project.id), 'the gallery thumbnail came back');
  assert.equal(await storage.loadProject(gone.project.id), null, 'not chosen, not restored');

  // The backup sees them as unchanged: nothing goes up again (only the
  // settings, which a sign-in always sends once).
  s.calls.length = 0;
  const run = await b.backup.run();
  assert.equal(run.ok, true);
  assert.equal(run.projects, 0, s.calls.join(', '));
  assert.ok(!s.calls.some((c) => c.startsWith('PUT /v1/projects') || c.startsWith('PUT /v1/blobs')), s.calls.join(', '));

  const log = s.logs.find((l) => l.event === 'restore');
  assert.equal(log.projects, 2);
});

test('a deleted project comes back and is live in the backup again', async () => {
  const s = await setUp();
  const { gone } = await firstIPad(s);
  freshDevice();
  const b = await s.device();
  await b.restore.connect(await s.signIn());
  const item = (await b.restore.list()).find((i) => i.projectId === gone.project.id);
  assert.equal(item.deleted, true);
  assert.equal((await b.restore.restore([item])).restored, 1);
  assert.equal((await storage.loadProject(gone.project.id)).project.name, 'Old one');

  const run = await b.backup.run();
  assert.equal(run.projects, 1, 'uploaded again (only the manifest: the blobs are there)');
  assert.equal(run.blobs, 0);
  const listed = await s.client.listProjects(`${s.vaultId}.${b.backup.access().auth.split('.')[1]}`);
  assert.equal(listed.find((p) => p.projectId === gone.project.id).deleted, false);
});

test('restoring again skips what is already here (a cut-off restore resumes)', async () => {
  const s = await setUp();
  const { bunny } = await firstIPad(s);
  freshDevice();
  const b = await s.device();
  await b.restore.connect(await s.signIn());
  const items = (await b.restore.list()).filter((i) => !i.deleted);
  await b.restore.restore(items.filter((i) => i.projectId === bunny.project.id));

  const again = await b.restore.list();
  assert.equal(again.find((i) => i.projectId === bunny.project.id).here, true);
  const result = await b.restore.restore(items);
  assert.equal(result.restored, 1);
  assert.equal(result.skipped, 1);
});

test('settings stay as they are unless the device is fresh', async () => {
  const s = await setUp();
  await firstIPad(s);
  freshDevice();
  await storage.saveToolSettings({ tool: 'draw', size: 3 });
  const b = await s.device();
  const { settings } = await b.restore.connect(await s.signIn(), { fresh: false });
  assert.equal(settings, false);
  assert.deepEqual(await storage.loadToolSettings(), { tool: 'draw', size: 3 });
});

test('a blob missing from the backup comes back blank and is reported', async () => {
  const s = await setUp();
  const { cat } = await firstIPad(s);
  freshDevice();
  const b = await s.device();
  await b.restore.connect(await s.signIn());
  const item = (await b.restore.list()).find((i) => i.projectId === cat.project.id);
  const name = item.manifest.blobs[0].name;
  s.env.BUCKET.objects.delete(`vaults/${s.vaultId}/b/${name}`);
  const result = await b.restore.restore([item]);
  assert.equal(result.restored, 1);
  assert.equal(result.missingBlobs, 1);
  assert.match(restoreDoneText(result), /came back blank/);
  // Not marked as sent: the next run sends what this device has.
  assert.equal((await b.backup.run()).projects, 1);
});

test('sign-in problems: wrong PRF secret, no user handle, offline', async () => {
  const s = await setUp();
  await firstIPad(s);
  freshDevice();
  const b = await s.device();
  await assert.rejects(b.restore.connect(await s.signIn({ prf: new Uint8Array(32).fill(1) })), { code: 'unreadable' });
  assert.equal(b.backup.enabled, false);
  const noHandle = { ...(await s.signIn()), userHandle: null };
  await assert.rejects(b.restore.connect(noHandle), { code: 'no-passkey' });
  const noPrf = { ...(await s.signIn()), prf: {} };
  await assert.rejects(b.restore.connect(noPrf), { code: 'no-prf' });
  const offline = createRestore({
    storage,
    client: createBackupClient({ baseUrl: 'https://backup.test', fetchFn: async () => { throw new TypeError('Load failed'); } }),
    backup: b.backup,
  });
  await assert.rejects(offline.connect(await s.signIn()), { code: 'offline' });
});

test('turn off on this iPad forgets the vault here; signing in again reconnects', async () => {
  const s = await setUp();
  await firstIPad(s);
  freshDevice();
  const b = await s.device();
  await b.restore.connect(await s.signIn());
  await b.backup.disable();
  assert.equal(b.backup.enabled, false);
  assert.equal(b.backup.access(), null);
  assert.equal(await storage.loadMeta('backupKeys'), null);
  await assert.rejects(b.restore.list(), { code: 'not-on' });

  // After a relaunch it's still off.
  const relaunched = await s.device();
  assert.equal(relaunched.backup.enabled, false);
  await relaunched.restore.connect(await s.signIn());
  assert.equal((await relaunched.restore.list()).length, 3);
});

test('restore sheet wording', () => {
  assert.equal(restoreButtonLabel(0), 'Restore');
  assert.equal(restoreButtonLabel(3), 'Restore 3');
  assert.equal(restoreDoneText({ restored: 1, failed: [], missingBlobs: 0 }), 'Brought back 1 animation.');
  assert.equal(restoreDoneText({ restored: 0, failed: [], missingBlobs: 0 }), 'Nothing new to bring back.');
  assert.equal(
    restoreDoneText({ restored: 2, failed: [{ name: 'Cat', code: 'unreadable' }], missingBlobs: 0 }),
    "Brought back 2 animations. One couldn't be restored: Cat.",
  );
});
