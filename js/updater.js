// js/updater.js
//
// Owns: service-worker registration and app updates — noticing a new
// version, applying it, the manual "Check for updates", the dev-only
// "Fresh reload", and reporting which build is running. No DOM/UI:
// main.js connects it to the toast and the settings panel.
//
// How updates flow (see also sw.js): a new worker installs in the
// background and then *waits*; onUpdateReady fires so the UI can ask
// first. applyUpdate() tells the waiting worker to take over, and the
// page reloads once it does.
//
// Two gaps in the original version, addressed after an update
// silently didn't land on the iPad:
// 1. A worker already mid-install when the app opened wasn't
//    explicitly watched. (Chromium notifies the page anyway, so this
//    is defensive — WebKit's behavior here is untested.)
// 2. Updates were only checked on a fresh launch. iPadOS keeps home-
//    screen apps suspended for days, so the app now also checks each
//    time it comes back to the foreground. (Verified by test.)
// Whatever iOS does, the gear menu's Check for updates / Fresh reload
// are the reliable manual path.
//
// Origin note: GitHub Pages serves every project of this account from
// one origin (bcrossley712.github.io), so caches and service-worker
// registrations are shared with any other app there. Fresh reload only
// touches this app's own (`parapara-` caches, this scope's worker).

const CACHE_PREFIX = 'parapara-';
const FOREGROUND_CHECK_INTERVAL_MS = 60 * 1000;
const INSTALL_WAIT_TIMEOUT_MS = 30 * 1000;
const RELOAD_FALLBACK_MS = 3000;
const BEFORE_RELOAD_TIMEOUT_MS = 3000;
const VERSION_REQUEST_TIMEOUT_MS = 1000;

// --- version label (pure; unit-tested) ---

// sw.js's VERSION is stamped at deploy as "<git sha>-<YYYYMMDDHHMMSS UTC>".
// Turns that into e.g. "a1b2c3d · Oct 18, 7:15 AM" (local time).
// Unstamped (local dev) → "Development build"; unknown → "Unknown".
export function formatVersion(raw, locale = undefined) {
  if (raw === '__VERSION__') return 'Development build';
  if (typeof raw !== 'string') return 'Unknown';
  const match = raw.match(/^([0-9a-f]{7,40})-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!match) return raw || 'Unknown';
  const [, sha, y, mo, d, h, mi, s] = match;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  const when = date.toLocaleString(locale, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return `${sha.slice(0, 7)} · ${when}`;
}

// --- updater ---

// options.onUpdateReady(): a new version is downloaded and waiting.
//   May fire more than once for the same update; the toast de-dupes.
// options.beforeReload(): awaited (with a timeout) before any reload
//   this module causes, so unsaved work is flushed first.
export function initUpdater({ onUpdateReady = () => {}, beforeReload = async () => {} } = {}) {
  const sw = globalThis.navigator?.serviceWorker;
  let registration = null;
  let reloading = false;
  let updateRequested = false;
  let lastCheck = 0;

  // A worker already controlling the page at load means any later
  // controller change is an update taking over. On the very first
  // install there's no controller yet, and sw.js's clients.claim()
  // fires controllerchange too — reloading then would interrupt her
  // first session for nothing.
  const hadController = Boolean(sw?.controller);

  // Flushes unsaved work, but never lets a stuck save block a reload.
  async function runBeforeReload() {
    try {
      await Promise.race([
        Promise.resolve().then(beforeReload),
        new Promise((resolve) => setTimeout(resolve, BEFORE_RELOAD_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.warn('Parapara! flush before reload failed:', err);
    }
  }

  async function reloadSafely() {
    if (reloading) return;
    reloading = true;
    await runBeforeReload();
    globalThis.location.reload();
  }

  // Calls onUpdateReady once `worker` is installed and waiting — only
  // when some worker already controls the page (otherwise it's the
  // first install, not an update).
  function watch(worker) {
    if (!worker) return;
    const check = () => {
      if (worker.state === 'installed' && sw.controller) onUpdateReady();
    };
    if (worker.state === 'installed') check();
    else worker.addEventListener('statechange', check);
  }

  function register() {
    sw.register('./sw.js').then((reg) => {
      registration = reg;
      watch(reg.waiting);
      watch(reg.installing); // gap 1: mid-install when the app opened
      reg.addEventListener('updatefound', () => watch(reg.installing));
    }).catch((err) => {
      console.error('Service worker registration failed:', err);
    });

    sw.addEventListener('controllerchange', () => {
      if (hadController || updateRequested) reloadSafely();
    });

    // Gap 2: check again whenever the app returns to the foreground,
    // at most once a minute.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !registration) return;
      const now = Date.now();
      if (now - lastCheck < FOREGROUND_CHECK_INTERVAL_MS) return;
      lastCheck = now;
      registration.update().catch(() => {}); // offline is fine
    });
  }

  if (sw) {
    if (document.readyState === 'complete') register();
    else globalThis.addEventListener('load', register);
  }

  // Resolves with the worker's final state once it's installed,
  // redundant (failed) or activated, or 'timeout'.
  function waitForInstalled(worker) {
    return new Promise((resolve) => {
      const done = (state) => { clearTimeout(timer); resolve(state); };
      const timer = setTimeout(() => done('timeout'), INSTALL_WAIT_TIMEOUT_MS);
      const check = () => {
        if (['installed', 'activated', 'redundant'].includes(worker.state)) done(worker.state);
      };
      worker.addEventListener('statechange', check);
      check();
    });
  }

  return {
    // Manual check. Resolves 'ready' (an update is downloaded and can
    // be applied), 'none' (up to date), 'error' (couldn't check, e.g.
    // offline), or 'unsupported' (no service worker here).
    async checkForUpdate() {
      if (!sw) return 'unsupported';
      if (!registration) {
        registration = (await sw.getRegistration().catch(() => null)) ?? null;
        if (!registration) return 'unsupported';
      }
      lastCheck = Date.now();
      try {
        await registration.update();
      } catch {
        return 'error';
      }
      if (registration.waiting) return 'ready';
      if (registration.installing) {
        const state = await waitForInstalled(registration.installing);
        if (state === 'installed') return 'ready';
        return state === 'activated' ? 'none' : 'error';
      }
      return 'none';
    },

    // Activates the waiting version and reloads into it. Flushes
    // unsaved work first (beforeReload).
    async applyUpdate() {
      updateRequested = true;
      const waiting = registration?.waiting;
      if (!waiting) {
        await reloadSafely();
        return;
      }
      await runBeforeReload();
      waiting.postMessage({ type: 'SKIP_WAITING' });
      // controllerchange normally triggers the reload; this is a
      // fallback in case it never fires.
      setTimeout(reloadSafely, RELOAD_FALLBACK_MS);
    },

    // Dev tool: forget this app's cached files and service worker and
    // reload straight from the network. Drawings and settings live in
    // IndexedDB, which this never touches.
    async freshReload() {
      updateRequested = true; // a later claim shouldn't be ignored
      await runBeforeReload();
      reloading = true; // from here on, don't let another path reload first

      const scope = new URL('./', globalThis.location.href).href;

      if (sw) {
        const regs = await sw.getRegistrations().catch(() => []);
        await Promise.all(regs.filter((r) => r.scope === scope).map((r) => r.unregister()));
      }
      if (globalThis.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k)));
      }

      // A plain reload can still pull app files from the browser's own
      // HTTP cache (GitHub Pages allows 10 minutes). Re-fetch everything
      // this page loaded, bypassing that cache, so the reload is
      // genuinely fresh.
      const urls = new Set([globalThis.location.href]);
      for (const entry of performance.getEntriesByType('resource')) {
        if (entry.name.startsWith(scope)) urls.add(entry.name);
      }
      await Promise.allSettled([...urls].map((url) => fetch(url, { cache: 'reload' })));

      globalThis.location.reload();
    },

    // The raw VERSION of the worker serving this page, or null if
    // there isn't one yet (first launch) or it doesn't answer (builds
    // from before this existed).
    async getVersion() {
      const worker = sw?.controller;
      if (!worker) return null;
      return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(null), VERSION_REQUEST_TIMEOUT_MS);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
      });
    },
  };
}
