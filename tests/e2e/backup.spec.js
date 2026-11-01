// End-to-end tests for automatic backup (step 7b push 1): turning it
// on from the gear menu's Backup sheet (invite, then a passkey), the
// first upload, only changed blobs after that, a failed run waiting
// and then succeeding, and a deleted project's marker. The real Worker
// runs inside the test server (serve.js, /__backup__/, in-memory R2);
// Chromium's virtual authenticator (CDP, with PRF) stands in for
// iCloud Keychain. The app is opened as localhost — an IP address
// isn't a valid passkey domain.
//
// Not covered here: her 3-day notice and the scheduler's timing
// (unit-tested in backup.test.js); the real iPad (Touch ID, iCloud
// sync, iOS cutting a run short in the background).
//
// Run: npx playwright test backup

import { test, expect } from '@playwright/test';
import { readDb, savedDrawingBytes, waitForDrawingSave } from './helpers.js';

const INVITE = 'e2e-invite-code';

async function openApp(page, baseURL) {
  const url = new URL('/index.html', baseURL);
  url.hostname = 'localhost';
  await page.addInitScript((backupUrl) => { window.__PARAPARA_BACKUP_URL__ = backupUrl; }, `${url.origin}/__backup__`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true, hasPrf: true,
      defaultBackupEligibility: true, defaultBackupState: true,
    },
  });
  await page.goto(url.href);
  await page.locator('.pp-canvas, .pp-gallery').first().waitFor();
  if (await page.locator('.pp-gallery').count()) await page.getByRole('button', { name: 'New animation' }).click();
  await page.locator('.pp-canvas').waitFor();
}

async function stroke(page, dy = 0) {
  const before = await savedDrawingBytes(page);
  const box = await page.locator('.pp-canvas').boundingBox();
  await page.mouse.move(box.x + 200, box.y + 200 + dy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 200 + i * 25, box.y + 200 + dy);
  await page.mouse.up();
  await waitForDrawingSave(page, before);
}

const sheet = (page) => page.locator('.pp-backup');
const message = (page) => sheet(page).locator('.pp-backup__message');

async function openSheet(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Backup', exact: true }).click();
  await expect(sheet(page)).toBeVisible();
}

async function turnOn(page) {
  await openSheet(page);
  await sheet(page).getByLabel('Invite code').fill(INVITE);
  await sheet(page).getByRole('button', { name: 'Next' }).click();
  await sheet(page).getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet(page)).toHaveAttribute('data-phase', 'on');
  await expect(message(page)).toHaveText(/^Backed up /);
}

const vaultId = async (page) => (await readDb(page, 'meta', 'backup'))?.value?.vaultId;

async function storedKeys(page) {
  const id = await vaultId(page);
  const res = await page.request.get(`/__test__/backup?vault=${id}`);
  return (await res.json()).keys;
}
const blobsOf = (keys) => keys.filter((k) => k.includes('/b/'));

// PUT /__backup__/v1/blobs/… requests from now on.
function countBlobUploads(page) {
  const seen = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().includes('/__backup__/v1/blobs/')) seen.push(req.url());
  });
  return seen;
}

test('turning on backs everything up, encrypted; after that only what changed goes up', async ({ page, baseURL }) => {
  await openApp(page, baseURL);
  await stroke(page);
  await turnOn(page);

  const first = await storedKeys(page);
  expect(blobsOf(first).length).toBeGreaterThanOrEqual(1);
  expect(first.some((k) => /\/p\/[^/]+\/m\/\d+\.json$/.test(k))).toBe(true);
  expect(first.some((k) => k.endsWith('/settings.json'))).toBe(true);
  expect(first.some((k) => k.endsWith('/vault.json'))).toBe(true);

  // The keys stayed on the iPad, unexportable.
  const keys = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('parapara');
    req.onsuccess = () => {
      const r = req.result.transaction('meta').objectStore('meta').get('backupKeys');
      r.onsuccess = () => resolve({ enc: r.result.value.enc.extractable, name: r.result.value.name.extractable });
    };
  }));
  expect(keys).toEqual({ enc: false, name: false });

  // One more stroke on the same layer: one blob up.
  await page.getByRole('button', { name: 'Close' }).click();
  const uploads = countBlobUploads(page);
  await stroke(page, 60);
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Back up now' }).click();
  await expect.poll(() => uploads.length).toBe(1);
  await expect(message(page)).toHaveText(/^Backed up just now\.$/);
  await expect(sheet(page).locator('.pp-backup__detail')).toHaveText(/^Using /);
});

test('a wrong invite is refused with a note', async ({ page, baseURL }) => {
  await openApp(page, baseURL);
  await openSheet(page);
  await sheet(page).getByLabel('Invite code').fill('not-the-code');
  await sheet(page).getByRole('button', { name: 'Next' }).click();
  await expect(sheet(page).locator('.pp-backup__note')).toHaveText(/invite code didn't work/);
  await expect(sheet(page)).toHaveAttribute('data-phase', 'off');
});

test('with the backup unreachable the work waits, then goes up', async ({ page, baseURL }) => {
  await openApp(page, baseURL);
  await turnOn(page);
  await page.getByRole('button', { name: 'Close' }).click();

  await page.route('**/__backup__/**', (route) => route.abort());
  await stroke(page);
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Back up now' }).click();
  await expect(message(page)).toHaveText(/isn’t working right now: there’s no internet/);

  await page.unroute('**/__backup__/**');
  const uploads = countBlobUploads(page);
  await sheet(page).getByRole('button', { name: 'Back up now' }).click();
  await expect(message(page)).toHaveText(/^Backed up just now\.$/);
  expect(uploads.length).toBeGreaterThanOrEqual(1);
});

test('deleting a project leaves a deleted marker in the backup', async ({ page, baseURL }) => {
  await openApp(page, baseURL);
  await stroke(page);
  await turnOn(page);
  await page.getByRole('button', { name: 'Close' }).click();
  const projectId = (await readDb(page, 'meta', 'lastProjectId'))?.value;
  const before = (await storedKeys(page)).filter((k) => k.includes(`/p/${projectId}/m/`)).length;

  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await page.locator('.pp-gallery').waitFor();
  const name = await page.locator('.pp-gallery-card__name').first().textContent();
  await page.getByRole('button', { name: `More for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.locator('.pp-dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.pp-gallery-card')).toHaveCount(0);

  // Leaving the editor and deleting both ask for a run soon.
  await expect.poll(async () => (await storedKeys(page)).filter((k) => k.includes(`/p/${projectId}/m/`)).length, { timeout: 15000 })
    .toBeGreaterThan(before);
  const state = (await readDb(page, 'meta', 'backup')).value;
  await expect.poll(async () => {
    const projects = await page.evaluate(async ({ id, token }) => {
      const res = await fetch(`${window.__PARAPARA_BACKUP_URL__}/v1/projects`, { headers: { authorization: `Bearer ${id}.${token}` } });
      return (await res.json()).projects;
    }, { id: state.vaultId, token: state.token });
    return projects.find((p) => p.projectId === projectId)?.deleted;
  }, { timeout: 15000 }).toBe(true);
});

// --- restore (7b push 2) ---

const restoreSheet = (page) => page.locator('.pp-restore');

// A fresh install on the same "iPad": the app's database and local
// storage gone, the passkey (the virtual authenticator) still there —
// as on a new iPad with the same iCloud Keychain.
async function wipeAppData(page) {
  await page.goto(new URL('/manifest.json', page.url()).href);
  await page.evaluate(() => new Promise((resolve, reject) => {
    localStorage.clear();
    const req = indexedDB.deleteDatabase('parapara');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  }));
  await page.goto(new URL('/index.html', page.url()).href);
  await page.locator('.pp-gallery').waitFor();
  await expect(page.locator('.pp-gallery-card')).toHaveCount(0);
}

const projectIds = (page) => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('parapara');
  req.onsuccess = () => {
    const r = req.result.transaction('projects').objectStore('projects').getAllKeys();
    r.onsuccess = () => { req.result.close(); resolve(r.result.sort()); };
  };
}));

test('a fresh install restores from the empty gallery with the passkey; nothing goes up again', async ({ page, baseURL }) => {
  await openApp(page, baseURL);
  await stroke(page);
  await turnOn(page);
  await page.getByRole('button', { name: 'Close' }).click();
  // Leaving the editor saves the gallery thumbnail; back it up too.
  await page.getByRole('button', { name: 'Gallery', exact: true }).click();
  await expect(page.locator('.pp-gallery-card')).toHaveCount(1);
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Back up now' }).click();
  await expect(message(page)).toHaveText(/^Backed up just now\.$/);
  await expect.poll(async () => (await storedKeys(page)).filter((k) => k.includes('/b/')).length).toBe(2);
  await sheet(page).getByRole('button', { name: 'Close' }).click();
  const vault = await vaultId(page);
  const before = await projectIds(page);
  const drawn = await savedDrawingBytes(page);

  await wipeAppData(page);
  await page.getByRole('button', { name: 'Restore from backup' }).click();
  await restoreSheet(page).getByRole('button', { name: 'Continue' }).click();
  await expect(restoreSheet(page)).toHaveAttribute('data-phase', 'pick');
  await expect(restoreSheet(page).locator('.pp-restore__item')).toHaveCount(1);
  await expect(restoreSheet(page).locator('.pp-restore__item img')).toHaveCount(1);

  const uploads = countBlobUploads(page);
  await restoreSheet(page).getByRole('button', { name: 'Restore 1' }).click();
  await expect(restoreSheet(page)).toHaveAttribute('data-phase', 'done');
  await expect(restoreSheet(page).locator('.pp-restore__message')).toHaveText('Brought back 1 animation.');
  await restoreSheet(page).getByRole('button', { name: 'Done' }).click();

  // Back as itself, with its drawing, in the gallery.
  await expect(page.locator('.pp-gallery-card')).toHaveCount(1);
  expect(await projectIds(page)).toEqual(before);
  expect(await savedDrawingBytes(page)).toEqual(drawn);
  expect(await vaultId(page)).toBe(vault);

  // Backup is on here now, and has nothing to send.
  await openSheet(page);
  await expect(sheet(page)).toHaveAttribute('data-phase', 'on');
  await sheet(page).getByRole('button', { name: 'Back up now' }).click();
  await expect(message(page)).toHaveText(/^Backed up just now\.$/);
  expect(uploads).toEqual([]);
});

test('with backup on, Restore lists right away; Turn off on this iPad forgets the vault here', async ({ page, baseURL }) => {
  await openApp(page, baseURL);
  await stroke(page);
  await turnOn(page);

  await sheet(page).getByRole('button', { name: 'Restore…' }).click();
  await expect(restoreSheet(page)).toHaveAttribute('data-phase', 'pick');
  const item = restoreSheet(page).locator('.pp-restore__item');
  await expect(item).toHaveCount(1);
  await expect(item).toBeDisabled();
  await expect(item).toContainText('On this iPad');
  await expect(restoreSheet(page).getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  await restoreSheet(page).getByRole('button', { name: 'Cancel' }).click();

  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Turn off on this iPad' }).click();
  await page.locator('.pp-dialog').getByRole('button', { name: 'Turn off' }).click();
  await expect(sheet(page)).toHaveAttribute('data-phase', 'off');
  expect(await vaultId(page)).toBeUndefined();
  expect((await readDb(page, 'meta', 'backupKeys'))?.value ?? null).toBeNull();
});
