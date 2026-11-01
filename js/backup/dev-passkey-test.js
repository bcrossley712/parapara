// js/backup/dev-passkey-test.js
//
// DEV ONLY (before 7b; remove with the Developer section): gear menu →
// Developer → Passkey test. Checks, inside the installed app on her
// iPad, what 7b's backup depends on — Safari passed the same checks on
// Corbado's demo (2026-11-01), but a home-screen app can differ:
//   tap 1 — make a test passkey with PRF (Touch ID);
//   tap 2 — sign in with it, listing every passkey for the site as a
//           fresh install's restore would, and check the PRF secret is
//           the same as at creation.
// Then each tap signs in again. A failed sign-in forgets the test
// passkey, so the next tap makes a new one. The result goes in a
// notice and a `passkey-test` activity-log line (fields below).
//
// Only a fingerprint of the secret is kept (localStorage
// `parapara-dev-passkey`), enough to tell "same" from "different".
// The test passkey appears in the Passwords app under this site's
// name ("Parapara! passkey test"); delete it there when done.
//
// runPasskeyTest must be called synchronously in the tap (passkey.js).

import { createPasskey, passkeysSupported, signInWithPasskey, toBase64Url } from './passkey.js';

const STORE_KEY = 'parapara-dev-passkey';
const SALT = new TextEncoder().encode('parapara passkey test v1');

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    return saved && typeof saved.id === 'string' ? saved : null;
  } catch {
    return null;
  }
}

function writeSaved(value) {
  try {
    if (value) localStorage.setItem(STORE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Private mode or storage off: the test still reports this tap.
  }
}

async function fingerprint(bytes) {
  if (!bytes) return null;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches === true || navigator.standalone === true;
}

const yesNo = (v) => (v ? 'yes' : 'no');

function flagFields(flags) {
  if (!flags) return { flags: 'none' };
  return { uv: yesNo(flags.uv), be: yesNo(flags.be), bs: yesNo(flags.bs) };
}

// log(fields) adds a `passkey-test` line; notice(text) tells her.
export function runPasskeyTest({ log, notice }) {
  const base = { app: isStandalone() ? 'installed' : 'browser' };
  if (!passkeysSupported()) {
    log({ ...base, step: 'none', result: 'unsupported' });
    notice("Passkey test: passkeys aren't available here.");
    return;
  }
  const saved = readSaved();
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);

  const failed = (step) => (err) => {
    const name = String(err?.name ?? 'Error');
    log({ ...base, step, result: 'failed', error: name, message: String(err?.message ?? err), ms: ms() });
    if (step === 'sign-in') writeSaved(null);
    const next = step === 'sign-in' ? ' Tap Passkey test again to make a new test passkey.' : '';
    const why = name === 'NotAllowedError'
      ? ' It was cancelled or not allowed. If no Touch ID sheet appeared, check iCloud Passwords and AutoFill in Settings.'
      : ` (${name})`;
    notice(`Passkey test: ${step === 'create' ? 'making' : 'signing in with'} the passkey didn't work.${why}${next}`);
  };

  if (!saved) {
    // Tap 1: make one. No await before this call (the tap's gesture).
    createPasskey({
      rpName: 'Parapara!',
      userName: 'Parapara! passkey test',
      salt: SALT,
    }).then(async (made) => {
      const fp = await fingerprint(made.prf.first);
      writeSaved({ id: toBase64Url(made.credentialId), prf: fp });
      log({
        ...base, step: 'create', result: 'ok', ms: ms(),
        prf: yesNo(made.prf.enabled), secret: yesNo(made.prf.first), ...flagFields(made.flags),
      });
      const synced = made.flags?.bs ? 'synced to iCloud' : 'not synced';
      const prf = made.prf.enabled ? 'PRF on' : 'PRF off';
      notice(`Passkey test: made a test passkey (${prf}, ${synced}). Tap Passkey test again to sign in with it.`);
    }, failed('create'));
    return;
  }

  // Tap 2 and after: sign in, listing every passkey (as restore will).
  signInWithPasskey({ salt: SALT }).then(async (signedIn) => {
    const fp = await fingerprint(signedIn.prf.first);
    const id = toBase64Url(signedIn.credentialId);
    const samePasskey = id === saved.id;
    let same = 'n/a';
    if (fp && samePasskey && saved.prf) same = yesNo(fp === saved.prf);
    log({
      ...base, step: 'sign-in', result: 'ok', ms: ms(),
      secret: yesNo(fp), same, passkey: samePasskey ? 'test' : 'other',
      handle: yesNo(signedIn.userHandle), ...flagFields(signedIn.flags),
    });
    writeSaved({ id, prf: fp ?? (samePasskey ? saved.prf : null) });
    if (!fp) {
      notice('Passkey test: signed in, but no secret came back. PRF isn\'t working in this app.');
    } else if (!samePasskey) {
      notice('Passkey test: signed in with a different passkey than the test one. Tap again to check its secret repeats.');
    } else if (same === 'yes') {
      notice('Passkey test passed: signed in and got the same secret back. The details are in the activity log.');
    } else if (same === 'no') {
      notice('Passkey test: signed in, but the secret was different from before. Send the activity log.');
    } else {
      notice('Passkey test: signed in and got a secret. Tap again to check it repeats.');
    }
  }, failed('sign-in'));
}
