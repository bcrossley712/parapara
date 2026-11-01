// Unit tests for the backup Worker (worker/src, step 7b) against an
// in-memory R2 (tests/support/fake-r2.js) and a software passkey
// (tests/support/soft-passkey.js): joining, signing in, blobs,
// manifests, limits, CORS, pausing, and the scheduled cleanup.
//
// Run: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, inviteName } from '../../worker/src/index.js';
import { derToRaw, makeChallenge } from '../../worker/src/webauthn.js';
import {
  DAY, HOUR, cleanVault, manifestsToKeep, protectedBlobs, runCleanup, blobKey, manifestKey, indexKey,
} from '../../worker/src/cleanup.js';
import { FakeR2 } from '../support/fake-r2.js';
import { b64u, makeSoftPasskey, rawToDer } from '../support/soft-passkey.js';

const ORIGIN = 'http://localhost:8765';
const BASE = 'https://backup.test';

function makeEnv(extra = {}) {
  return {
    BUCKET: new FakeR2(),
    RP_ID: 'localhost',
    ALLOWED_ORIGINS: ORIGIN,
    INVITES: 'hers:invite-code-123,maya:other-code-456',
    SIGNING_KEY: 'test-signing-key',
    ...extra,
  };
}

function call(env, method, path, { body, token, headers = {}, raw } = {}) {
  const init = { method, headers: { origin: ORIGIN, ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (raw) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return handle(new Request(BASE + path, init), env);
}

const vaultIdOf = () => b64u(crypto.getRandomValues(new Uint8Array(16)));
const wrapped = () => ({ iv: b64u(new Uint8Array(12).fill(1)), data: b64u(new Uint8Array(48).fill(2)) });
const blobName = (seed) => b64u(new Uint8Array(32).fill(seed));
const encrypted = (n = 64) => new Uint8Array(n).fill(9);

async function getChallenge(env, invite) {
  const res = await call(env, 'POST', '/v1/challenge', { body: invite ? { invite } : {} });
  assert.equal(res.status, 200);
  return (await res.json()).challenge;
}

// A joined vault: { env, passkey, vaultId, auth }.
async function joined(env = makeEnv()) {
  const passkey = await makeSoftPasskey();
  const vaultId = vaultIdOf();
  const challenge = await getChallenge(env, 'invite-code-123');
  const res = await call(env, 'POST', '/v1/vaults', {
    body: { invite: 'invite-code-123', vaultId, passkey: await passkey.registration(challenge), wrappedKey: wrapped() },
  });
  assert.equal(res.status, 201);
  const { token } = await res.json();
  return { env, passkey, vaultId, auth: `${vaultId}.${token}` };
}

test('invite names: matched exactly, unknown or short codes refused', () => {
  const env = makeEnv();
  assert.equal(inviteName(env, 'invite-code-123'), 'hers');
  assert.equal(inviteName(env, ' other-code-456 '), 'maya');
  assert.equal(inviteName(env, 'invite-code-124'), null);
  assert.equal(inviteName(env, 'short'), null);
  assert.equal(inviteName(env, undefined), null);
});

test('a challenge needs a good invite when one is given', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/v1/challenge', { body: { invite: 'nope-nope-nope' } })).status, 403);
  assert.ok(await getChallenge(env, 'invite-code-123'));
  assert.ok(await getChallenge(env)); // restore asks without one
});

test('joining makes a vault with the passkey, wrapped key and a device token', async () => {
  const { env, passkey, vaultId, auth } = await joined();
  const vault = await (await env.BUCKET.get(`vaults/${vaultId}/vault.json`)).json();
  assert.equal(vault.invite, 'hers');
  assert.equal(vault.passkeys[0].id, passkey.id);
  assert.equal(vault.keys.length, 1);
  assert.equal(vault.devices.length, 1);
  assert.ok(!JSON.stringify(vault).includes(auth.split('.')[1]), 'only the token hash is stored');
  const status = await call(env, 'GET', '/v1/status', { token: auth });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { used: 0, limit: 1024 ** 3 });
});

test('joining is refused for a bad invite, origin, site, stale challenge or an existing vault', async () => {
  const env = makeEnv();
  const passkey = await makeSoftPasskey();
  const vaultId = vaultIdOf();
  const attempt = async (overrides = {}, regOptions = {}, challenge) => {
    const ch = challenge ?? await getChallenge(env);
    return call(env, 'POST', '/v1/vaults', {
      body: {
        invite: 'invite-code-123', vaultId, wrappedKey: wrapped(),
        passkey: await passkey.registration(ch, regOptions), ...overrides,
      },
    });
  };
  assert.equal((await attempt({ invite: 'wrong-code-xx' })).status, 403);
  assert.equal((await attempt({}, { originOverride: 'https://evil.example' })).status, 403);
  assert.equal((await attempt({}, { rp: new Uint8Array(32) })).status, 403);
  assert.equal((await attempt({}, { flags: 0x41 })).status, 403, 'not user-verified');
  const old = await makeChallenge(env.SIGNING_KEY, Date.now() - 6 * 60 * 1000);
  assert.equal((await attempt({}, {}, old)).status, 400);
  const forged = await makeChallenge('another-key');
  assert.equal((await attempt({}, {}, forged)).status, 400);
  assert.equal((await attempt()).status, 201);
  assert.equal((await attempt()).status, 409);
});

test('signing in with the passkey gives a new token and the wrapped key; a bad signature is refused', async () => {
  const { env, passkey, vaultId } = await joined();
  const bad = await call(env, 'POST', '/v1/sessions', { body: await passkey.assertion(await getChallenge(env), vaultId, { tamper: true }) });
  assert.equal(bad.status, 403);
  const res = await call(env, 'POST', '/v1/sessions', { body: await passkey.assertion(await getChallenge(env), vaultId) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.vaultId, vaultId);
  assert.deepEqual(body.key, { passkeyId: passkey.id, ...wrapped() });
  assert.equal((await call(env, 'GET', '/v1/status', { token: `${vaultId}.${body.token}` })).status, 200);
  const other = await makeSoftPasskey();
  const unknown = await call(env, 'POST', '/v1/sessions', { body: await other.assertion(await getChallenge(env), vaultId) });
  assert.equal(unknown.status, 404);
});

test('requests need a valid token, and a removed invite stops the vault', async () => {
  const { env, vaultId, auth } = await joined();
  assert.equal((await call(env, 'GET', '/v1/status')).status, 401);
  assert.equal((await call(env, 'GET', '/v1/status', { token: `${vaultId}.${'x'.repeat(43)}` })).status, 401);
  env.INVITES = 'maya:other-code-456';
  const res = await call(env, 'GET', '/v1/status', { token: auth });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'revoked' });
});

test('blobs: which are missing, upload, download', async () => {
  const { env, auth } = await joined();
  const a = blobName(1);
  const b = blobName(2);
  let res = await call(env, 'POST', '/v1/blobs/missing', { token: auth, body: { names: [a, b, a] } });
  assert.deepEqual(await res.json(), { missing: [a, b] });
  assert.equal((await call(env, 'PUT', `/v1/blobs/${a}`, { token: auth, raw: encrypted() })).status, 201);
  res = await call(env, 'POST', '/v1/blobs/missing', { token: auth, body: { names: [a, b] } });
  assert.deepEqual(await res.json(), { missing: [b] });
  res = await call(env, 'GET', `/v1/blobs/${a}`, { token: auth });
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), encrypted());
  assert.equal((await call(env, 'GET', `/v1/blobs/${b}`, { token: auth })).status, 404);
  assert.equal((await call(env, 'POST', '/v1/blobs/missing', { token: auth, body: { names: ['short'] } })).status, 400);
});

test('manifests: refused until their blobs are there, then indexed and listed; a deleted marker', async () => {
  const { env, vaultId, auth } = await joined();
  const a = blobName(1);
  const t1 = 1_700_000_000_000;
  let res = await call(env, 'PUT', '/v1/projects/proj1', { token: auth, body: { savedAt: t1, refs: [a], data: 'ZW5j' } });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'missing-blobs', missing: [a] });
  await call(env, 'PUT', `/v1/blobs/${a}`, { token: auth, raw: encrypted() });
  res = await call(env, 'PUT', '/v1/projects/proj1', { token: auth, body: { savedAt: t1, refs: [a], data: 'ZW5j' } });
  assert.equal(res.status, 201);
  const index = await (await env.BUCKET.get(indexKey(vaultId, 'proj1'))).json();
  assert.deepEqual(index, { latestLive: t1, deletedAt: null, refs: { [a]: t1 } });

  // A known blob is trusted without a check, even after it's gone from
  // the bucket (cleanup keeps referenced blobs).
  await env.BUCKET.delete(blobKey(vaultId, a));
  res = await call(env, 'PUT', '/v1/projects/proj1', { token: auth, body: { savedAt: t1 + 1000, refs: [a], data: 'ZW5j' } });
  assert.equal(res.status, 201);

  res = await call(env, 'GET', `/v1/projects/proj1/${t1}`, { token: auth });
  assert.deepEqual(await res.json(), { savedAt: t1, deleted: false, refs: [a], data: 'ZW5j' });

  res = await call(env, 'PUT', '/v1/projects/proj1', { token: auth, body: { savedAt: t1 + 2000, deleted: true } });
  assert.equal(res.status, 201);
  res = await call(env, 'GET', '/v1/projects', { token: auth });
  assert.deepEqual(await res.json(), {
    projects: [{ projectId: 'proj1', savedAt: t1 + 2000, deleted: true, latestLive: t1 + 1000 }],
  });
  // A deleted marker carries no blobs; a live manifest needs data.
  assert.equal((await call(env, 'PUT', '/v1/projects/proj1', { token: auth, body: { savedAt: t1 + 3000, deleted: true, refs: [a] } })).status, 400);
  assert.equal((await call(env, 'PUT', '/v1/projects/proj1', { token: auth, body: { savedAt: t1 + 3000, refs: [] } })).status, 400);
});

test('settings are stored and read back', async () => {
  const { env, auth } = await joined();
  assert.equal((await call(env, 'GET', '/v1/settings', { token: auth })).status, 404);
  assert.equal((await call(env, 'PUT', '/v1/settings', { token: auth, body: { savedAt: 5, data: 'c2V0' } })).status, 201);
  const res = await call(env, 'GET', '/v1/settings', { token: auth });
  assert.deepEqual(await res.json(), { savedAt: 5, data: 'c2V0' });
});

test('limits: an upload too big, a vault or the whole bucket over its limit', async () => {
  const { env, vaultId, auth } = await joined(makeEnv({ UPLOAD_LIMIT_BYTES: '100', VAULT_LIMIT_BYTES: '1000', TOTAL_LIMIT_BYTES: '5000' }));
  assert.equal((await call(env, 'PUT', `/v1/blobs/${blobName(1)}`, { token: auth, raw: encrypted(101) })).status, 413);
  await env.BUCKET.put('meta/usage.json', JSON.stringify({ vaults: { [vaultId]: { bytes: 950 } }, total: 950 }));
  const over = await call(env, 'PUT', `/v1/blobs/${blobName(1)}`, { token: auth, raw: encrypted(60) });
  assert.equal(over.status, 507);
  assert.deepEqual(await over.json(), { error: 'over-limit' });
  assert.equal((await call(env, 'PUT', `/v1/blobs/${blobName(1)}`, { token: auth, raw: encrypted(40) })).status, 201);
  await env.BUCKET.put('meta/usage.json', JSON.stringify({ vaults: { [vaultId]: { bytes: 0 } }, total: 4990 }));
  assert.equal((await call(env, 'PUT', `/v1/blobs/${blobName(2)}`, { token: auth, raw: encrypted(40) })).status, 507);
});

test('PAUSED stops everything; CORS answers only the allowed origin', async () => {
  const env = makeEnv();
  let res = await call(env, 'OPTIONS', '/v1/challenge');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  res = await call(env, 'POST', '/v1/challenge', { headers: { origin: 'https://evil.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  env.PAUSED = '1';
  res = await call(env, 'POST', '/v1/challenge');
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'paused' });
});

test('derToRaw undoes DER, including short and padded integers', () => {
  const raw = new Uint8Array(64);
  raw[0] = 0x80; raw[31] = 1; // r: high bit set (DER pads with 0)
  raw[32] = 0; raw[33] = 0; raw[63] = 7; // s: leading zeros (DER trims)
  assert.deepEqual(derToRaw(rawToDer(raw)), raw);
});

// --- cleanup ---

const NOW = Date.UTC(2026, 10, 1, 12);

test('versions kept: latest, latest live, newest per hour for 48 h and per day for 30 days', () => {
  const ms = [
    NOW - 10 * 60e3, NOW - 20 * 60e3,          // same hour: keep the newer
    NOW - 3 * HOUR,
    NOW - 50 * HOUR, NOW - 50.2 * HOUR,        // past 48 h: one per day
    NOW - 10 * DAY, NOW - 10 * DAY - HOUR,
    NOW - 40 * DAY,                            // too old
  ].map((savedAt) => ({ key: `k${savedAt}`, savedAt }));
  const keep = manifestsToKeep(ms, { now: NOW });
  const kept = ms.filter((m) => keep.has(m.key)).map((m) => m.savedAt);
  assert.deepEqual(kept, [NOW - 10 * 60e3, NOW - 3 * HOUR, NOW - 50 * HOUR, NOW - 10 * DAY]);
  // The latest live one survives even when old (a deleted project).
  const withLive = manifestsToKeep(ms, { now: NOW, latestLive: NOW - 40 * DAY });
  assert.ok(withLive.has(`k${NOW - 40 * DAY}`));
});

test('protected blobs: referenced in the last 30 days or in the latest live manifest', () => {
  const index = { latestLive: NOW - 60 * DAY, refs: { a: NOW - DAY, b: NOW - 31 * DAY, c: NOW - 60 * DAY } };
  assert.deepEqual([...protectedBlobs(index, NOW)].sort(), ['a', 'c']);
});

async function seedVault(bucket, vaultId, at) {
  await bucket.put(`vaults/${vaultId}/vault.json`, '{}');
  bucket.age(`vaults/${vaultId}/vault.json`, at);
}

test('cleanVault: drops old versions and unneeded blobs, keeps fresh uploads', async () => {
  const bucket = new FakeR2({ now: () => NOW });
  const v = 'vaultaaaaaaaaaaaaaaaaa';
  await seedVault(bucket, v, NOW - DAY);
  for (const [name, at] of [['old', NOW - 40 * DAY], ['kept', NOW - 40 * DAY], ['fresh', NOW - HOUR]]) {
    await bucket.put(blobKey(v, name), encrypted(10));
    bucket.age(blobKey(v, name), at);
  }
  const t = [NOW - 40 * DAY, NOW - 2 * DAY];
  for (const savedAt of t) await bucket.put(manifestKey(v, 'p1', savedAt), '{}');
  await bucket.put(indexKey(v, 'p1'), JSON.stringify({ latestLive: t[1], deletedAt: null, refs: { kept: t[1], old: t[0] } }));
  const bytes = await cleanVault(bucket, v, NOW);
  assert.ok(!(await bucket.head(blobKey(v, 'old'))));
  assert.ok(await bucket.head(blobKey(v, 'kept')));
  assert.ok(await bucket.head(blobKey(v, 'fresh')), 'its manifest may be on the way');
  assert.ok(!(await bucket.head(manifestKey(v, 'p1', t[0]))));
  assert.ok(await bucket.head(manifestKey(v, 'p1', t[1])));
  assert.equal(bytes, [...bucket.objects.values()].reduce((n, e) => n + e.bytes.length, 0));
});

test('cleanVault: a project deleted over 90 days ago goes; an idle vault goes whole', async () => {
  const bucket = new FakeR2({ now: () => NOW });
  const v = 'vaultbbbbbbbbbbbbbbbbb';
  await seedVault(bucket, v, NOW - DAY);
  await bucket.put(manifestKey(v, 'gone', NOW - 100 * DAY), '{}');
  await bucket.put(blobKey(v, 'x'), encrypted(10));
  bucket.age(blobKey(v, 'x'), NOW - 100 * DAY);
  await bucket.put(indexKey(v, 'gone'), JSON.stringify({ latestLive: NOW - 100 * DAY, deletedAt: NOW - 91 * DAY, refs: { x: NOW - 100 * DAY } }));
  await cleanVault(bucket, v, NOW);
  assert.ok(!(await bucket.head(indexKey(v, 'gone'))));
  assert.ok(!(await bucket.head(blobKey(v, 'x'))));

  const idle = 'vaultcccccccccccccccccc';
  await seedVault(bucket, idle, NOW - 366 * DAY);
  assert.equal(await cleanVault(bucket, idle, NOW), null);
  assert.equal((await bucket.list({ prefix: `vaults/${idle}/` })).objects.length, 0);
});

test('runCleanup writes usage per vault and the total', async () => {
  const bucket = new FakeR2({ now: () => NOW });
  await seedVault(bucket, 'v1aaaaaaaaaaaaaaaaaaaa', NOW);
  await seedVault(bucket, 'v2aaaaaaaaaaaaaaaaaaaa', NOW);
  await bucket.put(blobKey('v2aaaaaaaaaaaaaaaaaaaa', 'b'), encrypted(100));
  const result = await runCleanup({ BUCKET: bucket }, NOW);
  assert.equal(result.finished, true);
  const usage = await (await bucket.get('meta/usage.json')).json();
  assert.equal(usage.vaults.v1aaaaaaaaaaaaaaaaaaaa.bytes, 2);
  assert.equal(usage.vaults.v2aaaaaaaaaaaaaaaaaaaa.bytes, 102);
  assert.equal(usage.total, 104);
});
