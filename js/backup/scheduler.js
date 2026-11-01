// js/backup/scheduler.js
//
// Owns: *when* the backup runs (step 7b) — the "what" is the `run`
// it's given (backup.js). Pure timing, injected clock and timers, so
// it's unit-tested in Node like autosave.js.
//
// - changed(): after a save. Runs `debounceMs` after the last change,
//   but never sooner than `minIntervalMs` after the previous run —
//   while she draws, at most one backup every ~2 minutes.
// - soon(): run now-ish (leaving a project, the app hidden, launch,
//   back online, just turned on).
// - A failed run retries after 1, 5, 15, then every 60 minutes; a
//   change or soon() doesn't wait out the retry if it's sooner. While
//   offline (isOnline() false) nothing runs; main.js calls soon() on
//   the 'online' event.
// - Runs never overlap; a change during a run schedules one after it.

const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export function createBackupScheduler({
  run,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  isOnline = () => true,
  debounceMs = 10_000,
  minIntervalMs = 120_000,
  soonMs = 1_000,
}) {
  let timer = null;
  let dueAt = Infinity;
  let running = false;
  let changedDuringRun = false;
  let lastRunAt = -Infinity;
  let failures = 0;
  let stopped = false;

  function scheduleAt(at) {
    if (stopped || at >= dueAt) return;
    if (timer !== null) clearTimer(timer);
    dueAt = at;
    timer = setTimer(fire, Math.max(0, at - now()));
  }

  async function fire() {
    timer = null;
    dueAt = Infinity;
    if (stopped) return;
    if (running) {
      changedDuringRun = true;
      return;
    }
    if (!isOnline()) return; // 'online' brings it back
    running = true;
    lastRunAt = now();
    let result;
    try {
      result = await run();
    } catch (err) {
      result = { ok: false, error: String(err?.message ?? err) };
    }
    running = false;
    if (result?.ok === false) {
      failures++;
      scheduleAt(now() + RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]);
    } else {
      failures = 0;
    }
    if (changedDuringRun) {
      changedDuringRun = false;
      api.changed();
    }
  }

  const api = {
    changed() {
      if (running) {
        changedDuringRun = true;
        return;
      }
      scheduleAt(Math.max(now() + debounceMs, lastRunAt + minIntervalMs));
    },
    soon() {
      if (running) {
        changedDuringRun = true;
        return;
      }
      scheduleAt(now() + soonMs);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    get failures() { return failures; },
    get scheduled() { return Number.isFinite(dueAt) ? dueAt : null; },
  };
  return api;
}
