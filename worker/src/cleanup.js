// worker/src/cleanup.js
//
// The backup Worker's scheduled cleanup (step 7b; hourly cron, a few
// vaults per run):
// - versions: keep each project's latest manifest and its latest live
//   one (before a deleted marker), the newest per hour for 48 hours,
//   the newest per day for 30 days; delete the rest;
// - deleted projects: everything goes 90 days after the marker;
// - blobs: a blob is kept while some project's index says a manifest
//   referenced it in the last 30 days, or it's in a project's latest
//   live manifest. Every kept manifest is newer than 30 days or is the
//   latest live one, so this keeps everything a kept version needs
//   (and a little more: blobs of dropped versions inside 30 days).
//   Blobs uploaded in the last day are never deleted — their manifest
//   may still be on its way;
// - vaults with nothing uploaded for 12 months are deleted whole;
// - usage: each vault's bytes and the total go to meta/usage.json,
//   which uploads check against the limits.
//
// Free-plan Workers get 1,000 calls to R2 per run, so a run stops
// before its budget and the next one carries on (meta/cleanup.json
// remembers where). Pure helpers are exported for the unit tests.

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
export const KEEP = {
  hourlyMs: 48 * HOUR,
  dailyMs: 30 * DAY,
  deletedMs: 90 * DAY,
  idleVaultMs: 365 * DAY,
  freshBlobMs: DAY,
};
const RUN_BUDGET = 800;      // R2 calls per run, under the 1,000 limit
const VAULT_RESERVE = 150;   // don't start a vault with less left

export const USAGE_KEY = 'meta/usage.json';
const STATE_KEY = 'meta/cleanup.json';

export const vaultPrefix = (vaultId) => `vaults/${vaultId}/`;
export const manifestKey = (vaultId, projectId, savedAt) =>
  `vaults/${vaultId}/p/${projectId}/m/${String(savedAt).padStart(15, '0')}.json`;
export const indexKey = (vaultId, projectId) => `vaults/${vaultId}/p/${projectId}/index.json`;
export const blobKey = (vaultId, name) => `vaults/${vaultId}/b/${name}`;

// manifests: [{ key, savedAt }]. Returns the Set of keys to keep.
export function manifestsToKeep(manifests, { latestLive = null, now }) {
  const newestFirst = [...manifests].sort((a, b) => b.savedAt - a.savedAt);
  const keep = new Set();
  const hours = new Set();
  const days = new Set();
  newestFirst.forEach((m, i) => {
    if (i === 0 || m.savedAt === latestLive) keep.add(m.key);
    const age = now - m.savedAt;
    if (age <= KEEP.hourlyMs) {
      const hour = Math.floor(m.savedAt / HOUR);
      if (!hours.has(hour)) {
        hours.add(hour);
        keep.add(m.key);
      }
    }
    if (age <= KEEP.dailyMs) {
      const day = Math.floor(m.savedAt / DAY);
      if (!days.has(day)) {
        days.add(day);
        keep.add(m.key);
      }
    }
  });
  return keep;
}

// index: { latestLive, deletedAt, refs: { name: lastRef } }. The blob
// names this project still needs.
export function protectedBlobs(index, now) {
  const out = new Set();
  for (const [name, lastRef] of Object.entries(index?.refs ?? {})) {
    if (lastRef >= now - KEEP.dailyMs || lastRef === index.latestLive) out.add(name);
  }
  return out;
}

export const projectExpired = (index, now) =>
  Number.isFinite(index?.deletedAt) && now - index.deletedAt > KEEP.deletedMs;

// Counts R2 calls so a run can stop before the limit.
function counted(bucket) {
  let used = 0;
  const wrap = (name) => (...args) => {
    used++;
    return bucket[name](...args);
  };
  return {
    get: wrap('get'), put: wrap('put'), head: wrap('head'), list: wrap('list'), delete: wrap('delete'),
    get used() { return used; },
  };
}

async function readJson(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  try {
    return await obj.json();
  } catch {
    return null;
  }
}

async function listAll(bucket, options) {
  const objects = [];
  const prefixes = [];
  let cursor;
  do {
    const page = await bucket.list({ ...options, cursor });
    objects.push(...page.objects);
    prefixes.push(...(page.delimitedPrefixes ?? []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { objects, prefixes };
}

async function deleteKeys(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

const uploadedMs = (obj) => new Date(obj.uploaded).getTime();

// One vault. Returns its bytes after cleanup, or null if it was deleted.
export async function cleanVault(bucket, vaultId, now) {
  const prefix = vaultPrefix(vaultId);
  const { objects } = await listAll(bucket, { prefix });
  if (objects.length === 0) return null;

  const latest = Math.max(...objects.map(uploadedMs));
  if (now - latest > KEEP.idleVaultMs) {
    await deleteKeys(bucket, objects.map((o) => o.key));
    return null;
  }

  const blobs = [];
  const projects = new Map(); // projectId -> { manifests, hasIndex }
  for (const obj of objects) {
    const rest = obj.key.slice(prefix.length);
    if (rest.startsWith('b/')) {
      blobs.push(obj);
      continue;
    }
    const match = rest.match(/^p\/([^/]+)\/(?:m\/(\d+)\.json|(index\.json))$/);
    if (!match) continue;
    const entry = projects.get(match[1]) ?? { manifests: [], hasIndex: false };
    if (match[2]) entry.manifests.push({ key: obj.key, savedAt: Number(match[2]) });
    else entry.hasIndex = true;
    projects.set(match[1], entry);
  }

  const doomed = [];
  const needed = new Set();
  for (const [projectId, entry] of projects) {
    const index = entry.hasIndex ? await readJson(bucket, indexKey(vaultId, projectId)) : null;
    if (projectExpired(index, now)) {
      doomed.push(...entry.manifests.map((m) => m.key), indexKey(vaultId, projectId));
      continue;
    }
    const keep = manifestsToKeep(entry.manifests, { latestLive: index?.latestLive ?? null, now });
    for (const m of entry.manifests) if (!keep.has(m.key)) doomed.push(m.key);
    for (const name of protectedBlobs(index, now)) needed.add(name);
  }
  for (const obj of blobs) {
    const name = obj.key.slice(prefix.length + 2);
    if (!needed.has(name) && now - uploadedMs(obj) > KEEP.freshBlobMs) doomed.push(obj.key);
  }
  await deleteKeys(bucket, doomed);
  const gone = new Set(doomed);
  return objects.reduce((sum, o) => sum + (gone.has(o.key) ? 0 : o.size), 0);
}

export async function runCleanup(env, now = Date.now()) {
  const bucket = counted(env.BUCKET);
  const state = (await readJson(bucket, STATE_KEY)) ?? { after: '' };
  const usage = (await readJson(bucket, USAGE_KEY)) ?? { vaults: {} };
  const { prefixes } = await listAll(bucket, { prefix: 'vaults/', delimiter: '/' });
  const ids = prefixes.map((p) => p.slice('vaults/'.length, -1)).sort();

  let after = state.after ?? '';
  let finished = true;
  for (const id of ids) {
    if (id <= after) continue;
    if (RUN_BUDGET - bucket.used < VAULT_RESERVE) {
      finished = false;
      break;
    }
    const bytes = await cleanVault(bucket, id, now);
    if (bytes === null) delete usage.vaults[id];
    else usage.vaults[id] = { bytes, at: now };
    after = id;
  }
  const present = new Set(ids);
  for (const id of Object.keys(usage.vaults)) if (!present.has(id)) delete usage.vaults[id];
  usage.total = Object.values(usage.vaults).reduce((sum, v) => sum + v.bytes, 0);
  usage.at = now;
  await bucket.put(USAGE_KEY, JSON.stringify(usage));
  await bucket.put(STATE_KEY, JSON.stringify({ after: finished ? '' : after, at: now }));
  return { vaults: ids.length, finished, calls: bucket.used };
}
