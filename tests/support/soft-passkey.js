// tests/support/soft-passkey.js
//
// A software passkey for the backup Worker's unit tests: an ES256 key
// pair plus the authenticatorData / clientDataJSON / DER signature a
// browser would send. Test tooling only.

const enc = new TextEncoder();

export const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
export const unb64u = (text) => new Uint8Array(Buffer.from(text, 'base64url'));

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function concat(...parts) {
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

// raw r||s -> DER, as authenticators send it.
export function rawToDer(raw) {
  const int = (bytes) => {
    let b = bytes;
    while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.slice(1);
    if (b[0] & 0x80) b = concat([0], b);
    return concat([0x02, b.length], b);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat([0x30, r.length + s.length], r, s);
}

export async function makeSoftPasskey({ rpId = 'localhost', origin = 'http://localhost:8765' } = {}) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const rpIdHash = await sha256(enc.encode(rpId));

  const clientData = (type, challenge, o = origin) =>
    enc.encode(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));

  return {
    id: b64u(credentialId),
    publicKey: b64u(spki),
    alg: -7,
    // What the app sends to join.
    async registration(challenge, { flags = 0x5d, rp = rpIdHash, originOverride } = {}) {
      const authData = concat(rp, [flags], [0, 0, 0, 0], new Uint8Array(16), [0, credentialId.length], credentialId);
      return {
        id: b64u(credentialId),
        publicKey: b64u(spki),
        alg: -7,
        clientDataJSON: b64u(clientData('webauthn.create', challenge, originOverride)),
        authenticatorData: b64u(authData),
      };
    },
    // What the app sends to sign in.
    async assertion(challenge, userHandle, { flags = 0x1d, tamper = false } = {}) {
      const authData = concat(rpIdHash, [flags], [0, 0, 0, 1]);
      const cd = clientData('webauthn.get', challenge);
      const raw = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, concat(authData, await sha256(cd)),
      ));
      if (tamper) raw[5] ^= 1;
      return {
        credentialId: b64u(credentialId),
        userHandle,
        clientDataJSON: b64u(cd),
        authenticatorData: b64u(authData),
        signature: b64u(rawToDer(raw)),
      };
    },
  };
}
