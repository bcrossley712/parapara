// js/storage/storage.js
//
// Owns: the IndexedDB wrapper and the project/frame schema (source of
// truth — see PROJECT_NOTES.md "Draft frame/project schema"). Later:
// storage-used estimation for the quota warning.
//
// Undo/redo is NOT here and is never persisted — it's one project-wide
// in-memory history (see PROJECT_NOTES.md, undo/redo decision). It
// will live in its own file in this folder when step 2b builds it.
//
// Extend the schema additively (new optional fields) rather than
// restructuring, per the working agreement. A change to the stores or
// indexes themselves needs a DB_VERSION bump plus a new upgrade branch
// in openDatabase() — never edit the version-1 branch in place, or
// existing installs will skip it.

const DB_NAME = 'parapara';
const DB_VERSION = 1;

const STORE_PROJECTS = 'projects';
const STORE_FRAMES = 'frames';
const STORE_BLOBS = 'blobs';   // layer bitmaps (and, later, images/audio)
const STORE_META = 'meta';     // small app-level records, e.g. last project

const META_LAST_PROJECT = 'lastProjectId';

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

export function createLayer(name = DEFAULT_LAYER_NAME) {
  return {
    id: newId(),
    name,
    // Assigned up front and never changed. No blob stored under it
    // yet simply means "blank layer" — so saving a stroke only ever
    // writes the blob store, never the frame record.
    bitmapRef: newId(),
    visible: true,
    opacity: 1,
    locked: false,
  };
}

// New frames copy the previous frame's layer structure (names, order,
// visibility, opacity, lock) with fresh ids and blank bitmaps — see
// PROJECT_NOTES.md, layers decision. With no previous frame, one blank
// default layer.
export function createFrame(projectId, previousFrame = null) {
  const layers = previousFrame
    ? previousFrame.layers.map((layer) => ({
        ...layer,
        id: newId(),
        bitmapRef: newId(),
      }))
    : [createLayer()];

  // Keep the same layer active as on the previous frame (by position),
  // so she keeps drawing on e.g. "line" when she adds a frame.
  let activeIndex = 0;
  if (previousFrame) {
    const prevIndex = previousFrame.layers.findIndex(
      (l) => l.id === previousFrame.activeLayerId
    );
    if (prevIndex >= 0) activeIndex = prevIndex;
  }

  return {
    id: newId(),
    projectId,
    layers,
    activeLayerId: layers[activeIndex].id,
    image: null,
  };
}

export function createProjectRecord(name = DEFAULT_PROJECT_NAME) {
  const now = Date.now();
  return {
    id: newId(),
    name,
    createdAt: now,
    updatedAt: now,
    canvas: { ...DEFAULT_CANVAS },
    fps: DEFAULT_FPS,
    frames: [],
    audioClips: [],
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
      // Future versions: add `if (event.oldVersion < 2) { ... }` here.
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

// Creates and saves a new project with one frame (one blank layer),
// and marks it as the last-opened project.
export async function createProject(name) {
  const project = createProjectRecord(name);
  const frame = createFrame(project.id);
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
