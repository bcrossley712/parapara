// js/backup/restore.js
//
// Owns: getting drawings back from the backup (step 7b push 2) —
// signing this device into a vault with a passkey sign-in, listing
// what the vault holds (names and thumbnails, read from each project's
// latest encrypted manifest), and bringing chosen projects back as
// themselves (same ids, buildProject with keepIds), plus the settings
// on a fresh install. backup.js keeps the vault's keys and token;
// this reads through backup.access().
//
// The passkey ceremony itself stays in main.js, inside the tap
// (Safari); connect() takes its result.
//
// A restore is resumable: each project is saved in one transaction,
// and one already on this device is skipped, so running Restore again
// after the app was closed partway brings back only what's missing.
//
// Storage and the client are injected, so this is unit-tested in Node
// against the real Worker's handler (tests/unit/restore.test.js).

import { BACKUP_FORMAT, pool, projectFingerprint } from './backup.js';
import {
  SETTINGS_AAD, blobAad, fromB64u, manifestAad, toB64u, unseal, unwrapSecret, vaultKeys,
} from './crypto.js';
import { buildProject } from '../storage/project-file.js';
import { thumbnailBlobId } from '../storage/storage.js';

const DOWNLOADS_AT_ONCE = 3;
const dec = new TextDecoder();

// code: 'no-passkey' (the sign-in gave no vault), 'no-prf' (no secret
// from the passkey), 'not-found' (the vault or this passkey is gone),
// 'unreadable' (the key or a manifest won't decrypt), or a BackupError
// code ('offline', 'revoked', 'paused', …).
export class RestoreError extends Error {
  constructor(code, { cause } = {}) {
    super(`restore: ${code}`, cause ? { cause } : undefined);
    this.name = 'RestoreError';
    this.code = code;
  }
}

// storage: { listProjects, saveImportedProject, saveToolSettings,
// saveRecentColors }; client: createBackupClient(); backup:
// createBackup() (already loaded).
export function createRestore({ storage, client, backup, now = Date.now, log = () => {} }) {
  const access = () => {
    const a = backup.access();
    if (!a) throw new RestoreError('not-on');
    return a;
  };

  async function readManifest(auth, keys, projectId, savedAt) {
    const record = await client.getManifest(auth, projectId, savedAt);
    if (!record?.data) throw new RestoreError('unreadable');
    let manifest;
    try {
      const plain = await unseal(keys, fromB64u(record.data), manifestAad(projectId));
      manifest = JSON.parse(dec.decode(plain));
    } catch (err) {
      throw new RestoreError('unreadable', { cause: err });
    }
    if (manifest?.format !== BACKUP_FORMAT) throw new RestoreError('unreadable');
    return manifest;
  }

  // A blob's plain bytes, or null if the Worker no longer has it.
  async function readBlob(auth, keys, name) {
    let sealed;
    try {
      sealed = await client.getBlob(auth, name);
    } catch (err) {
      if (err?.code === 'not-found') return null;
      throw err;
    }
    try {
      return await unseal(keys, sealed, blobAad(name));
    } catch (err) {
      throw new RestoreError('unreadable', { cause: err });
    }
  }

  return {
    // After a passkey sign-in (signInWithPasskey's result): a device
    // token for the vault the passkey names, and the vault secret.
    // When `fresh` (nothing on this device yet), the settings come back
    // first — before backup.enable, so no run can send this device's
    // defaults over them. Then backup is on for this device.
    async connect(signedIn, { fresh = false } = {}) {
      if (!signedIn?.userHandle?.length) throw new RestoreError('no-passkey');
      if (!signedIn.prf?.first) throw new RestoreError('no-prf');
      const result = await client.signIn({
        credentialId: toB64u(signedIn.credentialId),
        userHandle: toB64u(signedIn.userHandle),
        ...signedIn.response,
      });
      if (!result?.key) throw new RestoreError('not-found');
      let secret;
      try {
        secret = await unwrapSecret(signedIn.prf.first, result.key);
      } catch (err) {
        throw new RestoreError('unreadable', { cause: err });
      }
      let settings = false;
      if (fresh) {
        try {
          settings = await this.restoreSettings({ auth: `${result.vaultId}.${result.token}`, keys: await vaultKeys(secret) });
        } catch (err) {
          // Niceties, not her work: the drawings still come back.
          log('restore-failed', { step: 'settings', error: err?.code ?? String(err?.message ?? err) });
        }
      }
      await backup.enable({ vaultId: result.vaultId, token: result.token, passkeyId: toB64u(signedIn.credentialId), secret });
      return { settings };
    },

    // Tool settings and recent colors from the vault. Resolves whether
    // there were any; the caller updates what's in memory.
    async restoreSettings({ auth, keys } = access()) {
      let record;
      try {
        record = await client.getSettings(auth);
      } catch (err) {
        if (err?.code === 'not-found') return null;
        throw err;
      }
      const plain = await unseal(keys, fromB64u(record.data), SETTINGS_AAD);
      const settings = JSON.parse(dec.decode(plain));
      if (settings?.toolSettings) await storage.saveToolSettings(settings.toolSettings);
      if (Array.isArray(settings?.recentColors)) await storage.saveRecentColors(settings.recentColors);
      return settings;
    },

    // What the vault holds, newest first: [{ projectId, savedAt,
    // deleted, name, updatedAt, frameCount, thumbnail: { type, bytes }
    // | null, here, manifest }]. A deleted project is offered from its
    // latest live manifest; one with none is left out. `here`: already
    // on this device (restoring skips it).
    async list() {
      const { auth, keys } = access();
      const entries = await client.listProjects(auth);
      const local = new Set((await storage.listProjects()).map((p) => p.id));
      const items = [];
      await pool(entries, DOWNLOADS_AT_ONCE, async (entry) => {
        const savedAt = entry.deleted ? entry.latestLive : entry.savedAt;
        if (!savedAt) return;
        let manifest;
        try {
          manifest = await readManifest(auth, keys, entry.projectId, savedAt);
        } catch (err) {
          if (err?.code !== 'not-found' && err?.code !== 'unreadable') throw err;
          log('restore-failed', { step: 'list', project: entry.projectId.slice(-4), error: err.code });
          return;
        }
        const project = manifest.project ?? {};
        const thumbEntry = manifest.blobs?.find((b) => b.id === thumbnailBlobId(entry.projectId));
        let thumbnail = null;
        if (thumbEntry) {
          const bytes = await readBlob(auth, keys, thumbEntry.name).catch(() => null);
          if (bytes) thumbnail = { type: thumbEntry.type || 'image/png', bytes };
        }
        items.push({
          projectId: entry.projectId,
          savedAt,
          deleted: entry.deleted,
          name: typeof project.name === 'string' && project.name.trim() ? project.name : 'Untitled',
          updatedAt: Number.isFinite(project.updatedAt) ? project.updatedAt : savedAt,
          frameCount: Array.isArray(project.frames) ? project.frames.length : 0,
          thumbnail,
          here: local.has(entry.projectId),
          manifest,
        });
      });
      return items.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    // Brings back the chosen items (from list()). onProgress({ done,
    // total, name }) before each. Resolves { restored, skipped,
    // missingBlobs, failed: [{ name, code }], ids }. A project that
    // fails is reported and the rest carry on; a lost connection stops
    // the whole restore (BackupError 'offline').
    async restore(items, { onProgress = () => {} } = {}) {
      const { auth, keys } = access();
      const local = new Set((await storage.listProjects()).map((p) => p.id));
      const out = { restored: 0, skipped: 0, missingBlobs: 0, failed: [], ids: [] };
      const started = now();
      const todo = items.filter((item) => {
        if (local.has(item.projectId)) {
          out.skipped++;
          return false;
        }
        return true;
      });
      for (let i = 0; i < todo.length; i++) {
        const item = todo[i];
        onProgress({ done: i, total: todo.length, name: item.name });
        try {
          const { manifest } = item;
          const names = new Map(manifest.blobs.map((b) => [b.id, b.name]));
          // Download in parallel, then build (buildProject reads in order).
          const wanted = [...new Set(manifest.blobs.map((b) => b.name))];
          const bytesByName = new Map();
          await pool(wanted, DOWNLOADS_AT_ONCE, async (name) => {
            bytesByName.set(name, await readBlob(auth, keys, name));
          });
          const built = await buildProject(
            manifest,
            async (entry) => bytesByName.get(names.get(entry.id)) ?? null,
            { keepIds: true, where: 'name' },
          );
          const missing = manifest.blobs.filter((b) => !bytesByName.get(b.name)).length;
          out.missingBlobs += missing;
          // A deleted project isn't marked sent: the next run uploads
          // it again, which takes it off the vault's deleted list.
          if (!item.deleted && missing === 0) {
            const byId = new Map(built.frames.map((f) => [f.id, f]));
            const ordered = built.project.frames.map((id) => byId.get(id)).filter(Boolean);
            const list = built.blobs.map((b) => ({ id: b.id, type: b.type, name: names.get(b.id) }));
            const order = new Map(manifest.blobs.map((b, n) => [b.id, n]));
            list.sort((a, b) => order.get(a.id) - order.get(b.id));
            await backup.markRestored(built.project.id, await projectFingerprint(built.project, ordered, list), item.savedAt);
          }
          await storage.saveImportedProject(built);
          out.restored++;
          out.ids.push(built.project.id);
        } catch (err) {
          if (err?.code === 'offline' || err?.code === 'unauthorized' || err?.code === 'revoked') throw err;
          log('restore-failed', { step: 'project', project: item.projectId.slice(-4), error: err?.code ?? String(err?.message ?? err) });
          out.failed.push({ name: item.name, code: err?.code ?? 'error' });
        }
      }
      onProgress({ done: todo.length, total: todo.length, name: '' });
      log('restore', {
        projects: out.restored, skipped: out.skipped, failed: out.failed.length, missing: out.missingBlobs, ms: now() - started,
      });
      return out;
    },
  };
}
