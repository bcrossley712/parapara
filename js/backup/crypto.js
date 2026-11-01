// js/backup/crypto.js
//
// Owns: backup encryption (step 7b), WebCrypto only. Everything the
// iPad uploads is encrypted here first, so the Worker and Cloudflare
// see random names and sizes — never a drawing or a project name.
//
// - A vault has one random 32-byte secret. From it, HKDF derives two
//   keys that never leave the device: `enc` (AES-GCM, for blobs,
//   manifests and settings) and `name` (HMAC-SHA-256, for blob names —
//   a keyed hash of the plain bytes, so the same file always gets the
//   same name and is stored once, but the name says nothing about it).
//   Both are made non-extractable and kept in IndexedDB (meta
//   `backupKeys`), so everyday backups need no Touch ID.
// - The secret itself is stored in the vault only *wrapped*: encrypted
//   under a key derived from the passkey's PRF output. Restore (push 2)
//   signs in with the passkey, gets the same PRF output, unwraps it.
// - Sealed data is iv (12 bytes) || AES-GCM ciphertext. Each kind gets
//   its own associated data (a blob its name, a manifest its project
//   id), so a stored piece can't be passed off as another.
// Pure (no storage, no DOM); unit-tested in Node.

const enc = new TextEncoder();
export const PRF_SALT = enc.encode('parapara backup v1');
const HKDF_SALT = enc.encode('parapara');

export function newVaultSecret() {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function hkdf(secret, info, algorithm, usages) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: enc.encode(info) },
    base, algorithm, false, usages,
  );
}

// { enc, name } CryptoKeys from the vault secret.
export async function vaultKeys(secret) {
  const [encKey, nameKey] = await Promise.all([
    hkdf(secret, 'parapara backup enc v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    hkdf(secret, 'parapara backup name v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  ]);
  return { enc: encKey, name: nameKey };
}

const wrapKey = (prfOutput) =>
  hkdf(prfOutput, 'parapara backup wrap v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);

const b64u = (bytes) => {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (text) => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
export { b64u as toB64u, unb64u as fromB64u };

const WRAP_AAD = enc.encode('parapara vault secret');

// The vault secret under the passkey's PRF output: { iv, data },
// base64url, as the Worker stores it.
export async function wrapSecret(prfOutput, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: WRAP_AAD }, await wrapKey(prfOutput), secret,
  ));
  return { iv: b64u(iv), data: b64u(data) };
}

export async function unwrapSecret(prfOutput, wrapped) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(wrapped.iv), additionalData: WRAP_AAD },
    await wrapKey(prfOutput), unb64u(wrapped.data),
  ));
}

// The blob's name: base64url HMAC of its plain bytes (43 characters).
export async function blobName(keys, bytes) {
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', keys.name, bytes)));
}

export async function seal(keys, bytes, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, keys.enc, bytes,
  ));
  const out = new Uint8Array(12 + data.length);
  out.set(iv, 0);
  out.set(data, 12);
  return out;
}

export async function unseal(keys, sealed, aad) {
  const bytes = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, keys.enc, bytes.slice(12),
  ));
}

export const blobAad = (name) => `blob:${name}`;
export const manifestAad = (projectId) => `manifest:${projectId}`;
export const SETTINGS_AAD = 'settings';

// A short hex fingerprint (to tell "unchanged since the last upload").
export async function fingerprint(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
