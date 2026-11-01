// js/backup/backup.js
//
// Owns: what the automatic backup does (step 7b push 1) — keeping
// track of what changed, and a backup run: for each changed project,
// work out its blobs' names, ask the Worker which it lacks, encrypt
// and upload those, then the encrypted manifest last (the 7a manifest
// plus each blob's name). Deleted projects get a deleted marker; the
// app settings (tool settings, recent colors) go up when they change.
// *When* to run is scheduler.js's job; the Backup sheet and main.js
// are the glue.
//
// Everything is encrypted first (crypto.js). The keys live in meta
// `backupKeys` (non-extractable), the state in meta `backup`
// ({ vaultId, token, passkeyId, enabledAt, lastOkAt, lastError,
// lastErrorAt, noticeAt }) and the to-do list in meta `backupQueue`
// ({ dirty: { projectId: { since, at } }, deleted: { projectId: since },
// settings: { since, at } | null, sent: { projectId: { hash, at } },
// settingsHash }). `since` is when something first waited (for her
// notice), `at` the latest change (a change during a run stays queued).
//
// Storage is injected (the functions storage.js exports), so this is
// unit-tested in Node with fake-indexeddb and a fake Worker.

import { projectFileBlobIds } from '../storage/project-file.js';
import {
  SETTINGS_AAD, blobAad, blobName, fingerprint, manifestAad, seal, toB64u, vaultKeys,
} from './crypto.js';

export const BACKUP_FORMAT = 'parapara-backup';
export const BACKUP_VERSION = 1;
export const NOTICE_AFTER_MS = 3 * 24 * 3600 * 1000;
export const NOTICE_EVERY_MS = 24 * 3600 * 1000;
const META_STATE = 'backup';
const META_KEYS = 'backupKeys';
const META_QUEUE = 'backupQueue';
const MISSING_BATCH = 500;
const UPLOADS_AT_ONCE = 3;

const enc = new TextEncoder();
const emptyQueue = () => ({ dirty: {}, deleted: {}, settings: null, sent: {}, settingsHash: null });
const asBytes = (buffer) => (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));

// Her notice: something has waited more than 3 days without getting
// backed up, and she hasn't been told in the last day.
export function backupNoticeDue(state, queue, now) {
  if (!state?.vaultId || !queue) return false;
  const waiting = [
    ...Object.values(queue.dirty ?? {}).map((d) => d.since),
    ...Object.values(queue.deleted ?? {}),
    queue.settings?.since,
  ].filter(Number.isFinite);
  if (waiting.length === 0) return false;
  return now - Math.min(...waiting) > NOTICE_AFTER_MS && now - (state.noticeAt ?? 0) > NOTICE_EVERY_MS;
}

async function pool(items, size, work) {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(runners);
}

// storage: { loadProject, listProjects, loadBlobs, loadMeta, saveMeta,
// loadToolSettings, loadRecentColors }; client: createBackupClient().
export function createBackup({ storage, client, now = Date.now, log = () => {}, appVersion = async () => '' }) {
  let state = null;
  let keys = null;
  let queue = emptyQueue();
  let running = null;
  let persistTimer = null;

  const auth = () => `${state.vaultId}.${state.token}`;

  async function saveState() {
    await storage.saveMeta(META_STATE, state);
  }

  async function saveQueue() {
    clearTimeout(persistTimer);
    persistTimer = null;
    await storage.saveMeta(META_QUEUE, queue);
  }

  // A burst of saves (several blobs, then the project) is one write.
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      saveQueue().catch((err) => log('backup-failed', { step: 'queue', error: String(err?.message ?? err) }));
    }, 1000);
  }

  function markProject(projectId) {
    const t = now();
    queue.dirty[projectId] = { since: queue.dirty[projectId]?.since ?? t, at: t };
  }

  // Only a project the backup has seen needs a deleted marker.
  function markDeleted(projectId) {
    delete queue.dirty[projectId];
    if (queue.sent[projectId]) queue.deleted[projectId] = queue.deleted[projectId] ?? now();
  }

  function markSettings() {
    const t = now();
    queue.settings = { since: queue.settings?.since ?? t, at: t };
  }

  async function backupProject(projectId) {
    const loaded = await storage.loadProject(projectId);
    if (!loaded) return { skipped: 'gone' };
    const { project, frames } = loaded;
    const ids = projectFileBlobIds(project, frames);
    const stored = await storage.loadBlobs(ids);
    const list = [];
    const bytesByName = new Map();
    for (const id of ids) {
      const blob = stored.get(id);
      if (!blob) continue; // a blank layer
      const bytes = asBytes(blob.buffer);
      const name = await blobName(keys, bytes);
      list.push({ id, type: blob.type, name });
      bytesByName.set(name, bytes);
    }
    const byId = new Map(frames.map((f) => [f.id, f]));
    const ordered = project.frames.map((id) => byId.get(id)).filter(Boolean);
    const content = { project, frames: ordered, blobs: list };
    const hash = await fingerprint(enc.encode(JSON.stringify(content)));
    if (queue.sent[projectId]?.hash === hash) return { skipped: 'unchanged' };

    const names = [...bytesByName.keys()];
    const missing = [];
    for (let i = 0; i < names.length; i += MISSING_BATCH) {
      missing.push(...await client.missing(auth(), names.slice(i, i + MISSING_BATCH)));
    }
    let bytesUp = 0;
    const upload = async (name) => {
      const sealed = await seal(keys, bytesByName.get(name), blobAad(name));
      await client.putBlob(auth(), name, sealed);
      bytesUp += sealed.length;
    };
    await pool(missing, UPLOADS_AT_ONCE, upload);

    const manifest = { format: BACKUP_FORMAT, version: BACKUP_VERSION, app: await appVersion(), ...content };
    const body = {
      savedAt: now(),
      refs: names,
      data: toB64u(await seal(keys, enc.encode(JSON.stringify(manifest)), manifestAad(projectId))),
    };
    try {
      await client.putManifest(auth(), projectId, body);
    } catch (err) {
      // The Worker lost one we thought it had: send those, then again.
      if (err?.code !== 'missing-blobs' || !err.missing) throw err;
      await pool(err.missing.filter((n) => bytesByName.has(n)), UPLOADS_AT_ONCE, upload);
      await client.putManifest(auth(), projectId, body);
    }
    queue.sent[projectId] = { hash, at: body.savedAt };
    return { blobs: missing.length, bytes: bytesUp + body.data.length };
  }

  async function backupSettings() {
    const settings = {
      toolSettings: await storage.loadToolSettings(),
      recentColors: await storage.loadRecentColors(),
    };
    const plain = enc.encode(JSON.stringify(settings));
    const hash = await fingerprint(plain);
    if (hash === queue.settingsHash) return;
    await client.putSettings(auth(), { savedAt: now(), data: toB64u(await seal(keys, plain, SETTINGS_AAD)) });
    queue.settingsHash = hash;
  }

  async function runOnce() {
    const started = now();
    const done = { projects: 0, blobs: 0, bytes: 0, deleted: 0 };
    try {
      for (const projectId of Object.keys(queue.deleted)) {
        await client.putManifest(auth(), projectId, { savedAt: now(), deleted: true });
        delete queue.deleted[projectId];
        delete queue.sent[projectId];
        done.deleted++;
        persistSoon();
      }
      for (const projectId of Object.keys(queue.dirty)) {
        const markedAt = queue.dirty[projectId]?.at;
        const result = await backupProject(projectId);
        if (!result.skipped) {
          done.projects++;
          done.blobs += result.blobs;
          done.bytes += result.bytes;
        }
        if (queue.dirty[projectId]?.at === markedAt) delete queue.dirty[projectId];
        persistSoon();
      }
      if (queue.settings) {
        const markedAt = queue.settings.at;
        await backupSettings();
        if (queue.settings?.at === markedAt) queue.settings = null;
      }
      state.lastOkAt = now();
      state.lastError = null;
      await saveState();
      if (done.projects || done.deleted) log('backup', { ...done, ms: now() - started });
      return { ok: true, ...done };
    } catch (err) {
      state.lastError = err?.code ?? 'failed';
      state.lastErrorAt = now();
      await saveState().catch(() => {});
      log('backup-failed', { error: state.lastError, message: String(err?.message ?? err), ...done });
      return { ok: false, error: state.lastError, ...done };
    } finally {
      await saveQueue().catch(() => {});
    }
  }

  return {
    // Reads the saved state; call once at launch.
    async load() {
      state = await storage.loadMeta(META_STATE);
      keys = state?.vaultId ? await storage.loadMeta(META_KEYS) : null;
      queue = { ...emptyQueue(), ...((await storage.loadMeta(META_QUEUE)) ?? {}) };
      if (!keys) state = null;
    },

    get enabled() { return Boolean(state?.vaultId && keys); },

    // For the Backup sheet and the log.
    status() {
      const pending = Object.keys(queue.dirty).length + Object.keys(queue.deleted).length + (queue.settings ? 1 : 0);
      return {
        enabled: this.enabled,
        lastOkAt: state?.lastOkAt ?? null,
        lastError: state?.lastError ?? null,
        lastErrorAt: state?.lastErrorAt ?? null,
        pending,
        running: running !== null,
      };
    },

    // From storage.onStorageChange.
    changed(projectId, kind) {
      if (!this.enabled) return;
      if (kind === 'settings') markSettings();
      else if (kind === 'deleted') markDeleted(projectId);
      else if (projectId) markProject(projectId);
      persistSoon();
    },

    // At launch: anything changed or deleted while the queue wasn't
    // looking (the app closed before it was saved).
    async catchUp() {
      if (!this.enabled) return;
      const projects = await storage.listProjects();
      const here = new Set(projects.map((p) => p.id));
      for (const p of projects) {
        const sent = queue.sent[p.id];
        if (!sent || (p.updatedAt ?? 0) > sent.at) markProject(p.id);
      }
      for (const id of Object.keys(queue.sent)) if (!here.has(id)) markDeleted(id);
      await saveQueue();
    },

    // One run (never two at once). Resolves { ok, error?, ... }.
    run() {
      if (!this.enabled) return Promise.resolve({ ok: true, idle: true });
      if (!running) running = runOnce().finally(() => { running = null; });
      return running;
    },

    // After joining: remember the vault and queue everything.
    async enable({ vaultId, token, passkeyId, secret }) {
      keys = await vaultKeys(secret);
      state = { vaultId, token, passkeyId, enabledAt: now(), lastOkAt: null, lastError: null, lastErrorAt: null, noticeAt: null };
      queue = emptyQueue();
      await storage.saveMeta(META_KEYS, keys);
      await saveState();
      markSettings();
      await this.catchUp();
    },

    noticeDue() {
      return backupNoticeDue(state, queue, now());
    },

    async noticeShown() {
      state.noticeAt = now();
      await saveState();
    },

    async usage() {
      return client.status(auth());
    },

    flush: () => saveQueue(),
  };
}
