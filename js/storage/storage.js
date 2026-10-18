// js/storage/storage.js
//
// Owns: the IndexedDB wrapper and the project/frame schema (source of
// truth — see PROJECT_NOTES.md "Schema"). Later:
// storage-used estimation for the quota warning.
//
// Undo/redo is NOT here and is never persisted — it's one project-wide
// in-memory history (see PROJECT_NOTES.md "Architecture"), in
// history.js.
//
// Extend the schema additively (new optional fields) rather than
// restructuring, per the working agreement. A change to the stores or
// indexes themselves — or a one-off data migration, like version 2's
// move to shared layers — needs a DB_VERSION bump plus a new upgrade
// branch in openDatabase(). Never edit an existing branch in place, or
// existing installs will skip it.

const DB_NAME = 'parapara';
const DB_VERSION = 2;

const STORE_PROJECTS = 'projects';
const STORE_FRAMES = 'frames';
const STORE_BLOBS = 'blobs';   // layer bitmaps (and, later, images/audio)
const STORE_META = 'meta';     // small app-level records, e.g. last project

const META_LAST_PROJECT = 'lastProjectId';
const META_TOOL_SETTINGS = 'toolSettings';

const DEFAULT_CANVAS = { width: 1920, height: 1080 };
const DEFAULT_FPS = 12;
const DEFAULT_PROJECT_NAME = 'Untitled';
const DEFAULT_LAYER_NAME = 'Layer 1';

let dbPromise = null;

// --- ids ---

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback for older iPadOS (randomUUID is iPadOS 15.4+). Uniqueness
  // only needs to hold within one device's database.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// --- schema factories (pure — nothing here touches the database) ---

// Layers are shared across the whole animation, Flipaclip-style (see
// PROJECT_NOTES.md "Schema"): the project holds the layer list and its
// properties; each frame only maps layer id -> bitmapRef for its own
// pixels on that layer.
export function createLayer(name = DEFAULT_LAYER_NAME) {
  return {
    id: newId(),
    name,
    visible: true,
    opacity: 1,
    locked: false,
  };
}

// A new frame gets a fresh, blank bitmap slot for every project layer.
// A bitmapRef is assigned up front and never changed; no blob stored
// under it simply means "blank" — so saving a stroke only ever writes
// the blob store, never the frame record.
export function createFrame(projectId, layers = []) {
  const bitmapRefs = {};
  for (const layer of layers) bitmapRefs[layer.id] = newId();
  return {
    id: newId(),
    projectId,
    bitmapRefs,
    image: null,
  };
}

// Gives `frame` a bitmapRef for any layer it's missing one for (a frame
// should always have one per layer; this keeps a gap from becoming a
// crash). Returns true if the frame changed and needs saving.
export function ensureBitmapRefs(frame, layers) {
  let changed = false;
  if (!frame.bitmapRefs) {
    frame.bitmapRefs = {};
    changed = true;
  }
  for (const layer of layers) {
    if (!frame.bitmapRefs[layer.id]) {
      frame.bitmapRefs[layer.id] = newId();
      changed = true;
    }
  }
  return changed;
}

export function createProjectRecord(name = DEFAULT_PROJECT_NAME) {
  const now = Date.now();
  const layer = createLayer();
  return {
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    canvas: { ...DEFAULT_CANVAS },
    fps: DEFAULT_FPS,
    layers: [layer],               // index 0 = bottom
    activeLayerId: layer.id,
    frames: [],
    audioClips: [],
  };
}

// --- migrations (pure — the upgrade branch feeds records through) ---

// Version 1 kept a separate layer list on every frame
// (frame.layers[] with a bitmapRef each, plus frame.activeLayerId).
// Version 2 shares one layer list across the project. Layer ids,
// properties and bitmapRefs are all kept, so no pixels move: the first
// frame's layers become the project's, and every frame's bitmaps are
// matched to them by position. A frame with more layers than that adds
// the extras to the end rather than dropping them; a frame with fewer
// gets blank slots. Already-migrated projects come back unchanged.
export function migrateToSharedLayers(project, frames) {
  if (Array.isArray(project.layers)) return { project, frames };

  const shared = [];
  for (const frame of frames) {
    (frame.layers ?? []).forEach((layer, i) => {
      if (i >= shared.length) {
        const { id, name, visible, opacity, locked } = layer;
        shared.push({
          id,
          name: name ?? DEFAULT_LAYER_NAME,
          visible: visible ?? true,
          opacity: opacity ?? 1,
          locked: locked ?? false,
        });
      }
    });
  }
  if (shared.length === 0) shared.push(createLayer());

  const first = frames[0];
  const firstActiveIndex = first?.layers?.findIndex((l) => l.id === first.activeLayerId) ?? -1;
  const activeLayerId = shared[firstActiveIndex >= 0 ? firstActiveIndex : 0].id;

  const migratedFrames = frames.map((frame) => {
    const { layers = [], activeLayerId: _unused, ...rest } = frame;
    const bitmapRefs = {};
    shared.forEach((layer, i) => {
      bitmapRefs[layer.id] = layers[i]?.bitmapRef ?? newId();
    });
    return { ...rest, bitmapRefs };
  });

  return {
    project: { ...project, layers: shared, activeLayerId },
    frames: migratedFrames,
  };
}

// Runs migrateToSharedLayers over every project inside the upgrade
// transaction. Request callbacks only (no awaits), per the
// withTransaction rule. Any error aborts the upgrade, so the database
// stays at version 1 untouched and saving stays off.
function upgradeToSharedLayers(tx) {
  const projectStore = tx.objectStore(STORE_PROJECTS);
  const frameStore = tx.objectStore(STORE_FRAMES);
  const projectsReq = projectStore.getAll();
  projectsReq.onsuccess = () => {
    const framesReq = frameStore.getAll();
    framesReq.onsuccess = () => {
      try {
        const byProject = new Map();
        for (const frame of framesReq.result) {
          if (!byProject.has(frame.projectId)) byProject.set(frame.projectId, []);
          byProject.get(frame.projectId).push(frame);
        }
        for (const project of projectsReq.result) {
          // Timeline order first (the first frame's layers become the
          // shared list), then any frames not in the timeline.
          const all = byProject.get(project.id) ?? [];
          const order = new Map(project.frames.map((id, i) => [id, i]));
          all.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
          const out = migrateToSharedLayers(project, all);
          projectStore.put(out.project);
          for (const frame of out.frames) frameStore.put(frame);
        }
      } catch (err) {
        console.error('Parapara! layer migration failed:', err);
        tx.abort();
      }
    };
  };
}

// --- IndexedDB plumbing ---

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });

        // projectId indexes exist now, before anything needs them, so
        // deleting a project in 2d (and its frames/bitmaps) doesn't
        // require a schema upgrade.
        const frames = db.createObjectStore(STORE_FRAMES, { keyPath: 'id' });
        frames.createIndex('projectId', 'projectId');

        const blobs = db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
        blobs.createIndex('projectId', 'projectId');

        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (event.oldVersion < 2) {
        // No store or index changes — a data migration to layers shared
        // across frames (see migrateToSharedLayers). A brand-new
        // database has nothing to migrate.
        if (event.oldVersion >= 1) upgradeToSharedLayers(request.transaction);
      }
      // Future versions: add `if (event.oldVersion < 3) { ... }` here.
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab/version asking to upgrade — close so it isn't
      // blocked forever. Rare for a single-user PWA, but cheap.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB open was blocked'));
  });

  // Don't cache a failure — a later call can try again.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

// Runs `work(stores)` inside one transaction and resolves with its
// return value once the transaction has fully committed (not merely
// when the last request succeeded) — so "saved" really means saved.
//
// `work` must only issue IndexedDB requests synchronously (or from
// those requests' own callbacks). Awaiting anything else inside it — a
// Blob read, a timer — lets the transaction auto-commit early; do that
// work before calling this.
async function withTransaction(storeNames, mode, work) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = {};
    for (const name of storeNames) stores[name] = tx.objectStore(name);

    let result;
    try {
      result = work(stores);
    } catch (err) {
      tx.abort();
      reject(err);
      return;
    }

    tx.oncomplete = () => {
      // `result` may be a promise wrapping a get() request — it has
      // already settled by the time the transaction completes.
      Promise.resolve(result).then(resolve, reject);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

// --- public API ---

// Opens the database and asks the browser to keep this app's storage
// (see PROJECT_NOTES.md — iOS can evict PWA data under pressure). The
// persistence request may be silently denied; the app works the same
// either way.
export async function initStorage() {
  await openDatabase();

  if (globalThis.navigator?.storage?.persist) {
    try {
      const already = await navigator.storage.persisted();
      const granted = already || await navigator.storage.persist();
      console.info(`Parapara! storage persistence: ${granted ? 'granted' : 'not granted'}`);
    } catch (err) {
      console.warn('Storage persistence request failed:', err);
    }
  }
}

// Creates and saves a new project with one blank layer and one frame,
// and marks it as the last-opened project.
export async function createProject(name) {
  const project = createProjectRecord(name);
  const frame = createFrame(project.id, project.layers);
  project.frames.push(frame.id);

  await withTransaction(
    [STORE_PROJECTS, STORE_FRAMES, STORE_META],
    'readwrite',
    (s) => {
      s[STORE_PROJECTS].put(project);
      s[STORE_FRAMES].put(frame);
      s[STORE_META].put({ key: META_LAST_PROJECT, value: project.id });
    }
  );

  return { project, frames: [frame] };
}

// Loads a project and its frames (in timeline order). Returns null if
// it doesn't exist. Frame records are small (bitmaps live in the blob
// store), so loading all of them up front is fine.
export async function loadProject(projectId) {
  const project = await withTransaction([STORE_PROJECTS], 'readonly', (s) =>
    promisifyRequest(s[STORE_PROJECTS].get(projectId))
  );
  if (!project) return null;

  const frames = await withTransaction([STORE_FRAMES], 'readonly', (s) =>
    Promise.all(project.frames.map((id) => promisifyRequest(s[STORE_FRAMES].get(id))))
  );

  // A frame id with no record would be a bug elsewhere; drop it rather
  // than handing undefined to the rest of the app.
  return { project, frames: frames.filter(Boolean) };
}

// Opens whichever project was open last, or creates the first one.
// Temporary startup behavior until the gallery exists (step 2d).
export async function openLastProject() {
  const meta = await withTransaction([STORE_META], 'readonly', (s) =>
    promisifyRequest(s[STORE_META].get(META_LAST_PROJECT))
  );

  if (meta?.value) {
    const loaded = await loadProject(meta.value);
    if (loaded && loaded.frames.length > 0) return loaded;
  }
  return createProject();
}

export async function saveProject(project) {
  const record = { ...project, updatedAt: Date.now() };
  await withTransaction([STORE_PROJECTS], 'readwrite', (s) => {
    s[STORE_PROJECTS].put(record);
  });
  return record;
}

// --- tool settings (app-wide, not per project) ---
//
// Active tool, color and per-tool brush sizes, remembered across
// launches and shared by every project — like Sketchbook/Procreate,
// where your brush and color come with you into a different drawing.
// Stored as-is; validating it is canvas.js's job
// (sanitizeToolSettings), since that's where the tools are defined.

// Returns the saved settings object, or null if none saved yet.
export async function loadToolSettings() {
  const record = await withTransaction([STORE_META], 'readonly', (s) =>
    promisifyRequest(s[STORE_META].get(META_TOOL_SETTINGS))
  );
  return record?.value ?? null;
}

export async function saveToolSettings(settings) {
  await withTransaction([STORE_META], 'readwrite', (s) => {
    s[STORE_META].put({ key: META_TOOL_SETTINGS, value: settings });
  });
}

export async function saveFrame(frame) {
  await withTransaction([STORE_FRAMES], 'readwrite', (s) => {
    s[STORE_FRAMES].put(frame);
  });
}

// Saves one layer's bitmap and bumps the project's updatedAt, in a
// single transaction so the two can't disagree.
//
// Stored as an ArrayBuffer + MIME type rather than a Blob: older
// WebKit versions had bugs storing Blobs in IndexedDB, and an
// ArrayBuffer round-trips reliably everywhere. The read happens before
// the transaction opens (see withTransaction).
export async function saveLayerBitmap(projectId, bitmapRef, blob) {
  const buffer = await blob.arrayBuffer();
  const type = blob.type || 'image/png';

  await withTransaction([STORE_BLOBS, STORE_PROJECTS], 'readwrite', (s) => {
    s[STORE_BLOBS].put({ id: bitmapRef, projectId, type, buffer });

    const getReq = s[STORE_PROJECTS].get(projectId);
    getReq.onsuccess = () => {
      const project = getReq.result;
      if (project) {
        project.updatedAt = Date.now();
        s[STORE_PROJECTS].put(project);
      }
    };
  });
}

// Returns the layer's bitmap as a Blob, or null if it's blank (never
// saved).
export async function loadLayerBitmap(bitmapRef) {
  const record = await withTransaction([STORE_BLOBS], 'readonly', (s) =>
    promisifyRequest(s[STORE_BLOBS].get(bitmapRef))
  );
  if (!record) return null;
  return new Blob([record.buffer], { type: record.type });
}

// Test-only: drop the cached connection so a test can start from a
// fresh database. Not used by the app.
export function _resetForTests() {
  const pending = dbPromise;
  dbPromise = null;
  if (pending) pending.then((db) => db.close()).catch(() => {});
}
