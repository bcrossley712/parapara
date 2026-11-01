// End-to-end test for the temporary Passkey test (gear menu →
// Developer → Passkey test; backup/dev-passkey-test.js, using
// backup/passkey.js). Runs against Chromium's virtual authenticator
// (CDP WebAuthn) with PRF and backup flags on, standing in for iCloud
// Keychain. Whether it works in the installed app on her iPad is the
// real check. Remove with the Developer section; passkey.js's
// ceremonies will be covered by 7b's own specs.
//
// Run: npx playwright test passkey

import { test, expect } from '@playwright/test';

// Passkeys need a host name, not an IP address (a SecurityError on
// 127.0.0.1), so this spec opens the same server as localhost — which
// Chromium resolves to 127.0.0.1 and treats as a secure context.
async function openGallery(page, baseURL) {
  const url = new URL('/index.html', baseURL);
  url.hostname = 'localhost';
  await page.goto(url.href);
  await page.locator('.pp-gallery').waitFor();
}

async function addAuthenticator(page, { prf = true } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: prf,
      defaultBackupEligibility: true,
      defaultBackupState: true,
    },
  });
  return { cdp, authenticatorId };
}

async function runTest(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Passkey test' }).click();
}

const notice = (page) => page.locator('#pp-notice-toast .pp-toast__text');

async function dismiss(page) {
  await page.locator('#pp-notice-toast .pp-toast__btn').click();
  await expect(page.locator('#pp-notice-toast')).toHaveCount(0);
}

async function logLines(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('parapara-dev-log') ?? '[]')
    .filter((line) => line.includes('passkey-test')));
}

test('first tap makes a passkey, the next signs in with the same secret', async ({ page, baseURL }) => {
  await openGallery(page, baseURL);
  const { cdp, authenticatorId } = await addAuthenticator(page);

  await runTest(page);
  await expect(notice(page)).toContainText('made a test passkey (PRF on, synced to iCloud)');
  await dismiss(page);
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);
  expect(credentials[0].isResidentCredential).toBe(true);

  await runTest(page);
  await expect(notice(page)).toContainText('Passkey test passed');
  await dismiss(page);

  // Again: still the same secret.
  await runTest(page);
  await expect(notice(page)).toContainText('Passkey test passed');

  await expect.poll(async () => (await logLines(page)).length).toBe(3);
  const lines = await logLines(page);
  expect(lines[0]).toContain('step=create result=ok');
  expect(lines[0]).toContain('prf=yes secret=yes');
  expect(lines[0]).toContain('bs=yes');
  expect(lines[1]).toContain('step=sign-in result=ok');
  expect(lines[1]).toContain('same=yes passkey=test handle=yes');
  expect(lines[2]).toContain('same=yes');
});

test('a sign-in that fails forgets the test passkey, so the next tap makes a new one', async ({ page, baseURL }) => {
  await openGallery(page, baseURL);
  const { cdp, authenticatorId } = await addAuthenticator(page);

  await runTest(page);
  await expect(notice(page)).toContainText('made a test passkey');
  await dismiss(page);

  // As if she deleted it in the Passwords app.
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
  await runTest(page);
  await expect(notice(page)).toContainText("signing in with the passkey didn't work");
  await expect(notice(page)).toContainText('Tap Passkey test again to make a new test passkey');
  await dismiss(page);

  await runTest(page);
  await expect(notice(page)).toContainText('made a test passkey');
});
