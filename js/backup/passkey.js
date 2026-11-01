// js/backup/passkey.js
//
// Owns: passkeys with the PRF extension (step 7b). A passkey proves a
// device's backups are its own, and its PRF output — a secret only
// that passkey can produce, the same every time for the same salt —
// becomes the key that unlocks the backup's encryption key. iCloud
// Keychain (or Google Password Manager) syncs the passkey, so a wiped
// or new iPad signed into the same account gets the key back with one
// Touch ID, and there's no recovery code to keep.
//
// Thin wrappers over navigator.credentials plus pure helpers (flags,
// base64url), unit-tested in Node. No storage, no DOM beyond
// `navigator`. Backup setup uses createPasskey; restore (7b push 2)
// will use signInWithPasskey. The dev Passkey test that proved this on
// her iPad (2026-11-01) was removed with 7b push 1.
//
// **createPasskey and signInWithPasskey must be called synchronously
// inside a tap** (no await before them): Safari refuses WebAuthn
// without a fresh user gesture (NotAllowedError). One tap allows one
// ceremony, so "create, then sign in" takes two taps.

export const PASSKEY_TIMEOUT_MS = 60_000;

// authenticatorData flags byte (offset 32): user present, user
// verified, backup eligible (may be synced), backed up (is synced).
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

export function passkeysSupported() {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential === 'function'
    && typeof navigator.credentials?.create === 'function';
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (const b of view) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// { up, uv, be, bs } from authenticatorData (ArrayBuffer or bytes),
// or null if it's too short to hold the flags.
export function authenticatorFlags(authData) {
  if (!authData) return null;
  const view = authData instanceof Uint8Array ? authData : new Uint8Array(authData);
  if (view.length < 33) return null;
  const f = view[32];
  return {
    up: (f & FLAG_UP) !== 0,
    uv: (f & FLAG_UV) !== 0,
    be: (f & FLAG_BE) !== 0,
    bs: (f & FLAG_BS) !== 0,
  };
}

// The PRF output from getClientExtensionResults(), as bytes, or null.
// `enabled` is only reported at creation.
export function readPrf(extensionResults) {
  const prf = extensionResults?.prf;
  const first = prf?.results?.first;
  return {
    enabled: prf?.enabled === true,
    first: first ? new Uint8Array(first) : null,
  };
}

// Creates a discoverable passkey on this device with PRF turned on.
// `challenge` (bytes) is the Worker's when it will check the result.
// Resolves { credentialId (bytes), userId, prf: { enabled, first },
// flags, response: { clientDataJSON, authenticatorData, publicKey
// (SPKI), alg } } — `response` is what the Worker checks, base64url.
// `prf.first` is set when the authenticator already answers at
// creation (CTAP 2.2; iCloud Keychain on iPadOS 27 does); otherwise it
// comes at the first sign-in. Call inside a tap.
export function createPasskey({ rpName, userName, displayName, userId = randomBytes(16), salt, challenge = randomBytes(32) }) {
  const pending = navigator.credentials.create({
    publicKey: {
      rp: { name: rpName }, // id defaults to this page's host
      user: { id: userId, name: userName, displayName: displayName ?? userName },
      challenge,
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },   // ES256
        { type: 'public-key', alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      timeout: PASSKEY_TIMEOUT_MS,
      attestation: 'none',
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  return pending.then((cred) => {
    if (!cred) throw new Error('no passkey was made');
    const authData = cred.response.getAuthenticatorData?.() ?? null;
    const publicKey = cred.response.getPublicKey?.() ?? null;
    return {
      credentialId: new Uint8Array(cred.rawId),
      userId: new Uint8Array(userId),
      prf: readPrf(cred.getClientExtensionResults?.()),
      flags: authenticatorFlags(authData),
      response: {
        clientDataJSON: toBase64Url(cred.response.clientDataJSON),
        authenticatorData: authData ? toBase64Url(authData) : null,
        publicKey: publicKey ? toBase64Url(publicKey) : null,
        alg: cred.response.getPublicKeyAlgorithm?.() ?? null,
      },
    };
  });
}

// Signs in with a passkey for this site and evaluates PRF with
// `salt`. With no `credentialIds`, the iPad lists every passkey for
// the site (how restore on a fresh iPad finds the backup). Resolves
// { credentialId, userHandle, prf: { first }, flags, response:
// { clientDataJSON, authenticatorData, signature } } (base64url, for
// the Worker). Call inside a tap.
export function signInWithPasskey({ salt, credentialIds = [], challenge = randomBytes(32) }) {
  const pending = navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: credentialIds.map((id) => ({ type: 'public-key', id })),
      userVerification: 'required',
      timeout: PASSKEY_TIMEOUT_MS,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  return pending.then((cred) => {
    if (!cred) throw new Error('no passkey was chosen');
    return {
      credentialId: new Uint8Array(cred.rawId),
      userHandle: cred.response.userHandle ? new Uint8Array(cred.response.userHandle) : null,
      prf: readPrf(cred.getClientExtensionResults?.()),
      flags: authenticatorFlags(cred.response.authenticatorData),
      response: {
        clientDataJSON: toBase64Url(cred.response.clientDataJSON),
        authenticatorData: toBase64Url(cred.response.authenticatorData),
        signature: toBase64Url(cred.response.signature),
      },
    };
  });
}
