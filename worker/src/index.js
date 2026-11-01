// worker/src/index.js
//
// Parapara!'s backup Worker (step 7b): a thin, private store in front
// of an R2 bucket. The iPad does the real work — it encrypts every
// blob and manifest before upload (the Worker never sees a drawing or
// a project name) and names blobs by a keyed hash, so identical files
// share one copy. Plain JS, no libraries; deployed by
// .github/workflows/worker.yml (see worker/README.md).
//
// Identity: a passkey (synced by iCloud Keychain). Joining needs a
// family's invite code; a passkey sign-in (restore, push 2) gets a new
// device a token. Everyday requests use that token:
// `Authorization: Bearer <vaultId>.<token>` (the Worker keeps only its
// SHA-256). Removing a family's invite from INVITES stops its vaults.
//
// R2 layout (all under vaults/<vaultId>/):
//   vault.json                 passkeys, wrapped keys, device tokens
//   b/<name>                   an encrypted blob
//   p/<projectId>/m/<savedAt>.json  a manifest: { savedAt, deleted,
//                              refs, data } (data: encrypted, base64url)
//   p/<projectId>/index.json   { latestLive, deletedAt, refs: { name: lastRef } }
//   settings.json              encrypted app settings
// meta/usage.json, meta/cleanup.json — see cleanup.js.
//
// Bindings and settings (wrangler.toml, secrets in the dashboard):
//   BUCKET (R2), RP_ID, ALLOWED_ORIGINS (comma list), PAUSED (any
//   non-empty value pauses everything), INVITES (secret,
//   "name:code,name:code"), SIGNING_KEY (secret, for challenges);
//   optional limit overrides VAULT_LIMIT_BYTES, TOTAL_LIMIT_BYTES,
//   UPLOAD_LIMIT_BYTES (tests).

import { HttpError, fromB64u, isB64uId, json, randomBytes, sameText, sha256, toB64u, utf8 } from './util.js';
import { checkAuthData, checkClientData, checkSignature, makeChallenge, ALG_ES256, ALG_RS256 } from './webauthn.js';
import { USAGE_KEY, blobKey, indexKey, manifestKey, runCleanup, vaultPrefix } from './cleanup.js';

export const LIMITS = {
  vaultBytes: 1024 ** 3,          // 1 GB per vault
  totalBytes: 8 * 1024 ** 3,      // 8 GB in all (R2's free tier is 10)
  uploadBytes: 25 * 1024 ** 2,    // 25 MB per upload
};
const MAX_DEVICES = 20;
const MAX_NAMES = 500;           // per "which are missing?" request
const MAX_NEW_REFS_CHECKED = 600;

const limitsFor = (env) => ({
  vaultBytes: Number(env.VAULT_LIMIT_BYTES) || LIMITS.vaultBytes,
  totalBytes: Number(env.TOTAL_LIMIT_BYTES) || LIMITS.totalBytes,
  uploadBytes: Number(env.UPLOAD_LIMIT_BYTES) || LIMITS.uploadBytes,
});

const origins = (env) => String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || !origins(env).includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

// INVITES: "name:code,name:code". Returns the name for `code`, or null.
export function inviteName(env, code) {
  if (typeof code !== 'string' || code.length < 8) return null;
  let found = null;
  for (const pair of String(env.INVITES ?? '').split(',')) {
    const at = pair.indexOf(':');
    if (at < 1) continue;
    const name = pair.slice(0, at).trim();
    if (sameText(pair.slice(at + 1).trim(), code.trim())) found = name;
  }
  return found;
}

const inviteActive = (env, name) =>
  String(env.INVITES ?? '').split(',').some((pair) => pair.split(':')[0].trim() === name);

async function readBody(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > max) throw new HttpError(413, 'too-large');
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > max) throw new HttpError(413, 'too-large');
  return new Uint8Array(buffer);
}

async function readJsonBody(request, max = 2 * 1024 * 1024) {
  const bytes = await readBody(request, max);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'bad-request', 'not JSON');
  }
}

async function getJson(bucket, key) {
  const obj = await bucket.get(key);
  return obj ? obj.json() : null;
}

const vaultKey = (vaultId) => `${vaultPrefix(vaultId)}vault.json`;

async function newDeviceToken(vault, now) {
  const token = toB64u(randomBytes(32));
  vault.devices = [...(vault.devices ?? []), { tokenHash: toB64u(await sha256(utf8(token))), createdAt: now }]
    .slice(-MAX_DEVICES);
  return token;
}

// Bearer <vaultId>.<token> -> the vault record, or throws.
async function authenticate(request, env) {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer ([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{32,64})$/);
  if (!match) throw new HttpError(401, 'unauthorized');
  const [, vaultId, token] = match;
  const vault = await getJson(env.BUCKET, vaultKey(vaultId));
  if (!vault) throw new HttpError(401, 'unauthorized');
  const hash = toB64u(await sha256(utf8(token)));
  if (!(vault.devices ?? []).some((d) => sameText(d.tokenHash, hash))) throw new HttpError(401, 'unauthorized');
  if (!inviteActive(env, vault.invite)) throw new HttpError(403, 'revoked');
  return vault;
}

async function usageOf(env, vaultId) {
  const usage = (await getJson(env.BUCKET, USAGE_KEY)) ?? { vaults: {}, total: 0 };
  return { vault: usage.vaults?.[vaultId]?.bytes ?? 0, total: usage.total ?? 0 };
}

async function checkRoom(env, vaultId, bytes) {
  const limits = limitsFor(env);
  const used = await usageOf(env, vaultId);
  if (used.vault + bytes > limits.vaultBytes || used.total + bytes > limits.totalBytes) {
    throw new HttpError(507, 'over-limit');
  }
}

// --- handlers ---

async function challenge(request, env) {
  const body = await readJsonBody(request, 4096).catch(() => ({}));
  if (body?.invite != null && !inviteName(env, body.invite)) throw new HttpError(403, 'bad-invite');
  return json({ challenge: await makeChallenge(env.SIGNING_KEY) });
}

// Join: a new vault, from an invite and a new passkey.
async function join(request, env, now) {
  const body = await readJsonBody(request, 16 * 1024);
  const invite = inviteName(env, body?.invite);
  if (!invite) throw new HttpError(403, 'bad-invite');
  const { vaultId, passkey, wrappedKey } = body;
  if (!isB64uId(vaultId, { min: 22, max: 64 })) throw new HttpError(400, 'bad-request', 'vaultId');
  if (!passkey || !isB64uId(passkey.id) || !isB64uId(passkey.publicKey, { min: 40, max: 1024 })
    || ![ALG_ES256, ALG_RS256].includes(passkey.alg)) throw new HttpError(400, 'bad-request', 'passkey');
  if (!wrappedKey || !isB64uId(wrappedKey.iv, { min: 16, max: 16 }) || !isB64uId(wrappedKey.data, { min: 32, max: 256 })) {
    throw new HttpError(400, 'bad-request', 'wrappedKey');
  }
  await checkClientData(passkey.clientDataJSON, {
    type: 'webauthn.create', secret: env.SIGNING_KEY, origins: origins(env), now,
  });
  const auth = await checkAuthData(passkey.authenticatorData, { rpId: env.RP_ID, registration: true });
  if (auth.credentialId !== passkey.id) throw new HttpError(400, 'bad-request', 'credential id');
  if (await env.BUCKET.head(vaultKey(vaultId))) throw new HttpError(409, 'exists');

  const vault = {
    version: 1,
    id: vaultId,
    invite,
    createdAt: now,
    passkeys: [{ id: passkey.id, publicKey: passkey.publicKey, alg: passkey.alg, createdAt: now }],
    keys: [{ passkeyId: passkey.id, iv: wrappedKey.iv, data: wrappedKey.data }],
    devices: [],
  };
  const token = await newDeviceToken(vault, now);
  await env.BUCKET.put(vaultKey(vaultId), JSON.stringify(vault));
  return json({ vaultId, token }, 201);
}

// Sign in with a passkey (restore onto a new device): a new token and
// the vault key wrapped for that passkey.
async function signIn(request, env, now) {
  const body = await readJsonBody(request, 16 * 1024);
  const { credentialId, userHandle, clientDataJSON, authenticatorData, signature } = body ?? {};
  if (!isB64uId(userHandle, { min: 22, max: 64 }) || !isB64uId(credentialId)) throw new HttpError(400, 'bad-request');
  const vault = await getJson(env.BUCKET, vaultKey(userHandle));
  const passkey = vault?.passkeys?.find((p) => p.id === credentialId);
  if (!passkey) throw new HttpError(404, 'not-found');
  if (!inviteActive(env, vault.invite)) throw new HttpError(403, 'revoked');
  const clientDataRaw = await checkClientData(clientDataJSON, {
    type: 'webauthn.get', secret: env.SIGNING_KEY, origins: origins(env), now,
  });
  const auth = await checkAuthData(authenticatorData, { rpId: env.RP_ID });
  await checkSignature({ publicKey: passkey.publicKey, alg: passkey.alg, authData: auth.bytes, clientDataRaw, signatureB64u: signature });
  const token = await newDeviceToken(vault, now);
  await env.BUCKET.put(vaultKey(vault.id), JSON.stringify(vault));
  const key = vault.keys.find((k) => k.passkeyId === credentialId) ?? null;
  return json({ vaultId: vault.id, token, key });
}

async function missingBlobs(request, env, vault) {
  const body = await readJsonBody(request, 64 * 1024);
  const names = body?.names;
  if (!Array.isArray(names) || names.length > MAX_NAMES || !names.every((n) => isB64uId(n, { min: 43, max: 43 }))) {
    throw new HttpError(400, 'bad-request', 'names');
  }
  const unique = [...new Set(names)];
  const found = await Promise.all(unique.map((n) => env.BUCKET.head(blobKey(vault.id, n))));
  return json({ missing: unique.filter((_, i) => !found[i]) });
}

async function putBlob(request, env, vault, name) {
  const bytes = await readBody(request, limitsFor(env).uploadBytes);
  if (bytes.length < 28) throw new HttpError(400, 'bad-request', 'too short to be encrypted');
  await checkRoom(env, vault.id, bytes.length);
  await env.BUCKET.put(blobKey(vault.id, name), bytes);
  return json({ ok: true }, 201);
}

async function getObject(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) throw new HttpError(404, 'not-found');
  return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream' } });
}

// A manifest (or a deleted marker). Every blob it names must already
// be stored; names the project's index has seen before are trusted
// (cleanup keeps them while they're referenced), new ones are checked.
async function putManifest(request, env, vault, projectId) {
  const max = limitsFor(env).uploadBytes;
  const body = await readJsonBody(request, max);
  const { savedAt, deleted = false, refs = [], data = null } = body ?? {};
  if (!Number.isSafeInteger(savedAt) || savedAt <= 0) throw new HttpError(400, 'bad-request', 'savedAt');
  if (!Array.isArray(refs) || !refs.every((n) => isB64uId(n, { min: 43, max: 43 }))) throw new HttpError(400, 'bad-request', 'refs');
  if (deleted ? refs.length > 0 : typeof data !== 'string' || data.length === 0) throw new HttpError(400, 'bad-request', 'data');

  const index = (await getJson(env.BUCKET, indexKey(vault.id, projectId))) ?? { latestLive: null, deletedAt: null, refs: {} };
  const fresh = [...new Set(refs)].filter((n) => !(n in index.refs));
  if (fresh.length > MAX_NEW_REFS_CHECKED) throw new HttpError(400, 'bad-request', 'too many new blobs at once');
  const present = await Promise.all(fresh.map((n) => env.BUCKET.head(blobKey(vault.id, n))));
  const absent = fresh.filter((_, i) => !present[i]);
  if (absent.length) return json({ error: 'missing-blobs', missing: absent }, 409);

  const text = JSON.stringify({ savedAt, deleted, refs, data });
  await checkRoom(env, vault.id, text.length);
  await env.BUCKET.put(manifestKey(vault.id, projectId, savedAt), text);
  if (deleted) {
    index.deletedAt = Math.max(index.deletedAt ?? 0, savedAt);
  } else {
    for (const n of refs) index.refs[n] = Math.max(index.refs[n] ?? 0, savedAt);
    if (savedAt > (index.latestLive ?? 0)) index.latestLive = savedAt;
    if (index.deletedAt && savedAt > index.deletedAt) index.deletedAt = null;
  }
  await env.BUCKET.put(indexKey(vault.id, projectId), JSON.stringify(index));
  return json({ ok: true }, 201);
}

// Latest manifest per project: [{ projectId, savedAt, deleted }].
async function listProjects(env, vault) {
  const prefix = `${vaultPrefix(vault.id)}p/`;
  const latest = new Map();
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    for (const obj of page.objects) {
      const m = obj.key.slice(prefix.length).match(/^([^/]+)\/m\/(\d+)\.json$/);
      if (m && Number(m[2]) > (latest.get(m[1]) ?? 0)) latest.set(m[1], Number(m[2]));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const out = [];
  for (const [projectId, savedAt] of latest) {
    const index = await getJson(env.BUCKET, indexKey(vault.id, projectId));
    out.push({ projectId, savedAt, deleted: Boolean(index?.deletedAt && index.deletedAt >= savedAt), latestLive: index?.latestLive ?? null });
  }
  return json({ projects: out });
}

async function getManifest(env, vault, projectId, savedAt) {
  const obj = await env.BUCKET.get(manifestKey(vault.id, projectId, savedAt));
  if (!obj) throw new HttpError(404, 'not-found');
  return new Response(obj.body, { headers: { 'content-type': 'application/json' } });
}

async function putSettings(request, env, vault) {
  const body = await readJsonBody(request, 256 * 1024);
  if (typeof body?.data !== 'string' || !Number.isSafeInteger(body?.savedAt)) throw new HttpError(400, 'bad-request');
  const text = JSON.stringify({ savedAt: body.savedAt, data: body.data });
  await checkRoom(env, vault.id, text.length);
  await env.BUCKET.put(`${vaultPrefix(vault.id)}settings.json`, text);
  return json({ ok: true }, 201);
}

async function status(env, vault) {
  const used = await usageOf(env, vault.id);
  return json({ used: used.vault, limit: limitsFor(env).vaultBytes });
}

async function route(request, env, now) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  if (env.PAUSED) throw new HttpError(503, 'paused');

  if (method === 'POST' && path === '/v1/challenge') return challenge(request, env);
  if (method === 'POST' && path === '/v1/vaults') return join(request, env, now);
  if (method === 'POST' && path === '/v1/sessions') return signIn(request, env, now);

  const vault = await authenticate(request, env);
  let m;
  if (method === 'GET' && path === '/v1/status') return status(env, vault);
  if (method === 'POST' && path === '/v1/blobs/missing') return missingBlobs(request, env, vault);
  if ((m = path.match(/^\/v1\/blobs\/([A-Za-z0-9_-]{43})$/))) {
    if (method === 'PUT') return putBlob(request, env, vault, m[1]);
    if (method === 'GET') return getObject(env, blobKey(vault.id, m[1]));
  }
  if (method === 'GET' && path === '/v1/projects') return listProjects(env, vault);
  if ((m = path.match(/^\/v1\/projects\/([A-Za-z0-9_-]{1,64})$/)) && method === 'PUT') {
    return putManifest(request, env, vault, m[1]);
  }
  if ((m = path.match(/^\/v1\/projects\/([A-Za-z0-9_-]{1,64})\/(\d{1,15})$/)) && method === 'GET') {
    return getManifest(env, vault, m[1], Number(m[2]));
  }
  if (path === '/v1/settings') {
    if (method === 'PUT') return putSettings(request, env, vault);
    if (method === 'GET') return getObject(env, `${vaultPrefix(vault.id)}settings.json`);
  }
  throw new HttpError(404, 'not-found');
}

export async function handle(request, env, now = Date.now()) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let response;
  try {
    response = await route(request, env, now);
  } catch (err) {
    if (err instanceof HttpError) response = json({ error: err.code }, err.status);
    else {
      console.error(err);
      response = json({ error: 'server' }, 500);
    }
  }
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(runCleanup(env)),
};

// For tests and tools.
export { fromB64u };
