// js/backup/client.js
//
// Owns: talking to the backup Worker (step 7b) — one function per
// endpoint (worker/src/index.js documents them), errors turned into
// BackupError codes the rest of the app can act on. No storage, no
// encryption (crypto.js does that before anything gets here).
//
// The Worker's address is BACKUP_URL; e2e tests point the app at the
// copy serve.js hosts by setting window.__PARAPARA_BACKUP_URL__ before
// the app loads.

export const BACKUP_URL = 'https://parapara-backup.kmsmallengines.com';

export function backupUrl() {
  return globalThis.__PARAPARA_BACKUP_URL__ ?? BACKUP_URL;
}

// code: 'offline' (no answer), 'unauthorized' (this device's token is
// no good), 'revoked' (the family's invite was removed), 'bad-invite',
// 'over-limit', 'too-large', 'paused', 'missing-blobs' (with
// `missing`), 'old-challenge', 'not-found', 'server', or another code
// the Worker sent.
export class BackupError extends Error {
  constructor(code, { status = 0, missing, cause } = {}) {
    super(`backup: ${code}`, cause ? { cause } : undefined);
    this.name = 'BackupError';
    this.code = code;
    this.status = status;
    if (missing) this.missing = missing;
  }
}

export function createBackupClient({ baseUrl = backupUrl(), fetchFn = (...args) => globalThis.fetch(...args) } = {}) {
  async function request(method, path, { auth, json, bytes, raw = false } = {}) {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${auth}`;
    let body;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (bytes) {
      headers['content-type'] = 'application/octet-stream';
      body = bytes;
    }
    let res;
    try {
      res = await fetchFn(`${baseUrl}${path}`, { method, headers, body, cache: 'no-store' });
    } catch (err) {
      throw new BackupError('offline', { cause: err });
    }
    if (!res.ok) {
      let info = {};
      try {
        info = await res.json();
      } catch {
        // not JSON (a proxy's error page)
      }
      const code = info.error
        ?? (res.status === 401 ? 'unauthorized' : res.status === 503 ? 'paused' : res.status >= 500 ? 'server' : 'failed');
      throw new BackupError(code, { status: res.status, missing: info.missing });
    }
    if (raw) return new Uint8Array(await res.arrayBuffer());
    return res.status === 204 ? null : res.json();
  }

  return {
    challenge: (invite) => request('POST', '/v1/challenge', { json: invite ? { invite } : {} }).then((r) => r.challenge),
    join: (body) => request('POST', '/v1/vaults', { json: body }),
    signIn: (body) => request('POST', '/v1/sessions', { json: body }),
    status: (auth) => request('GET', '/v1/status', { auth }),
    missing: (auth, names) => request('POST', '/v1/blobs/missing', { auth, json: { names } }).then((r) => r.missing),
    putBlob: (auth, name, bytes) => request('PUT', `/v1/blobs/${name}`, { auth, bytes }),
    getBlob: (auth, name) => request('GET', `/v1/blobs/${name}`, { auth, raw: true }),
    putManifest: (auth, projectId, body) => request('PUT', `/v1/projects/${encodeURIComponent(projectId)}`, { auth, json: body }),
    listProjects: (auth) => request('GET', '/v1/projects', { auth }).then((r) => r.projects),
    getManifest: (auth, projectId, savedAt) => request('GET', `/v1/projects/${encodeURIComponent(projectId)}/${savedAt}`, { auth }),
    putSettings: (auth, body) => request('PUT', '/v1/settings', { auth, json: body }),
    getSettings: (auth) => request('GET', '/v1/settings', { auth }),
  };
}
