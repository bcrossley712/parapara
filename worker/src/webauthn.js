// worker/src/webauthn.js
//
// The passkey checks the backup Worker needs (step 7b), with WebCrypto
// only, no libraries:
// - challenges: stateless — random bytes + time + an HMAC under the
//   Worker's SIGNING_KEY secret — so handing one out writes nothing
//   (the challenge endpoint is open to anyone); valid 5 minutes;
// - registration: clientDataJSON (type, challenge, origin) and
//   authenticatorData (this site's rpIdHash, user present and
//   verified, the credential id). The public key comes from the
//   browser's getPublicKey() (SPKI); with attestation 'none' there is
//   nothing more to check, and a client lying about its key only
//   locks itself out;
// - sign-in: the same checks plus the signature over
//   authenticatorData || SHA-256(clientDataJSON), with the stored key.

import { HttpError, concat, fromB64u, randomBytes, sameBytes, sha256, toB64u, utf8 } from './util.js';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const ALG_ES256 = -7;
export const ALG_RS256 = -257;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

async function hmacKey(secret) {
  if (!secret) throw new HttpError(500, 'not-configured', 'SIGNING_KEY is not set');
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

// 16 random bytes, 8 bytes of time (ms, big-endian), 16 bytes of MAC.
export async function makeChallenge(secret, now = Date.now()) {
  const body = new Uint8Array(24);
  body.set(randomBytes(16), 0);
  new DataView(body.buffer).setBigUint64(16, BigInt(now));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), body)).slice(0, 16);
  return toB64u(concat(body, mac));
}

export async function checkChallenge(secret, challenge, now = Date.now()) {
  let bytes;
  try {
    bytes = fromB64u(challenge);
  } catch {
    throw new HttpError(400, 'bad-challenge');
  }
  if (bytes.length !== 40) throw new HttpError(400, 'bad-challenge');
  const body = bytes.slice(0, 24);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), body)).slice(0, 16);
  if (!sameBytes(mac, bytes.slice(24))) throw new HttpError(400, 'bad-challenge');
  const at = Number(new DataView(body.buffer).getBigUint64(16));
  if (now - at > CHALLENGE_TTL_MS || at - now > 60_000) throw new HttpError(400, 'old-challenge');
}

// Parses and checks clientDataJSON; returns its bytes for hashing.
export async function checkClientData(clientDataB64u, { type, secret, origins, now }) {
  let raw;
  let data;
  try {
    raw = fromB64u(clientDataB64u);
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new HttpError(400, 'bad-client-data');
  }
  if (data?.type !== type) throw new HttpError(400, 'bad-client-data', 'wrong type');
  if (!origins.includes(data.origin)) throw new HttpError(403, 'bad-origin');
  await checkChallenge(secret, data.challenge, now);
  return raw;
}

// Checks authenticatorData against this site; returns { bytes, flags,
// credentialId (registration only) }.
export async function checkAuthData(authDataB64u, { rpId, registration = false }) {
  let bytes;
  try {
    bytes = fromB64u(authDataB64u);
  } catch {
    throw new HttpError(400, 'bad-auth-data');
  }
  if (bytes.length < 37) throw new HttpError(400, 'bad-auth-data');
  if (!sameBytes(bytes.slice(0, 32), await sha256(utf8(rpId)))) throw new HttpError(403, 'bad-rp');
  const flags = bytes[32];
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV)) throw new HttpError(403, 'not-verified');
  let credentialId = null;
  if (registration) {
    if (!(flags & FLAG_AT) || bytes.length < 55) throw new HttpError(400, 'bad-auth-data', 'no credential');
    const len = (bytes[53] << 8) | bytes[54];
    if (bytes.length < 55 + len) throw new HttpError(400, 'bad-auth-data');
    credentialId = toB64u(bytes.slice(55, 55 + len));
  }
  return { bytes, flags, credentialId };
}

// DER ECDSA signature (SEQUENCE of two INTEGERs) -> raw r||s, 32 bytes
// each, the form WebCrypto verifies.
export function derToRaw(der) {
  const fail = () => { throw new HttpError(400, 'bad-signature'); };
  if (der[0] !== 0x30) fail();
  let at = 2;
  if (der[1] & 0x80) at = 2 + (der[1] & 0x7f);
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[at] !== 0x02) fail();
    const len = der[at + 1];
    let int = der.slice(at + 2, at + 2 + len);
    at += 2 + len;
    while (int.length > 32 && int[0] === 0) int = int.slice(1);
    if (int.length > 32) fail();
    out.set(int, part * 32 + (32 - int.length));
  }
  return out;
}

export async function importPublicKey(spkiB64u, alg) {
  const spki = fromB64u(spkiB64u);
  if (alg === ALG_ES256) {
    return crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  if (alg === ALG_RS256) {
    return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  throw new HttpError(400, 'bad-alg');
}

export async function checkSignature({ publicKey, alg, authData, clientDataRaw, signatureB64u }) {
  let signature;
  try {
    signature = fromB64u(signatureB64u);
  } catch {
    throw new HttpError(400, 'bad-signature');
  }
  const key = await importPublicKey(publicKey, alg);
  const signed = concat(authData, await sha256(clientDataRaw));
  const ok = alg === ALG_ES256
    ? await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), signed)
    : await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signed);
  if (!ok) throw new HttpError(403, 'bad-signature');
}
