// js/storage/autosave.js
//
// Owns: *when* to save — debouncing after edits, never running two
// saves at once, and flushing immediately when asked (e.g. the app is
// going to the background). *What* to save is the caller's `save`
// function, so this file knows nothing about canvases or the schema.
//
// Behavior:
// - schedule(): call after every committed edit (stroke end, fill,
//   clear). Saves `delayMs` after the last call — a burst of quick
//   strokes produces one save, not one per stroke.
// - flush(): save now if anything is unsaved. Returns a promise that
//   settles once everything scheduled so far has been written (or has
//   failed).
// - If an edit lands while a save is running, exactly one more save
//   follows it. Saves never overlap, so an older, slower save can't
//   finish after a newer one and overwrite it.
// - A failed save calls onError and leaves the work marked unsaved, so
//   the next edit (or flush) retries. It does not retry in a loop on
//   its own — a persistent failure (e.g. out of space) would spin.

export function createAutosaver({ save, delayMs = 500, onError = () => {} }) {
  let dirty = false;
  let timer = null;
  let running = null; // promise of the save in progress, if any

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule() {
    dirty = true;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delayMs);
  }

  function runOnce() {
    dirty = false;
    let failed = false;
    running = (async () => {
      try {
        await save();
      } catch (err) {
        failed = true;
        dirty = true;
        onError(err);
      } finally {
        running = null;
      }
    })();
    return running.then(() => ({ failed }));
  }

  async function flush() {
    clearTimer();

    // A save is already in flight: wait for it, then save again only
    // if more edits arrived meanwhile.
    if (running) {
      await running;
      if (dirty && !running) return flush();
      return;
    }

    if (!dirty) return;

    const { failed } = await runOnce();

    // Edits that landed during that save and haven't got a timer of
    // their own (schedule() always sets one, so this is mainly the
    // flush-during-save case) are saved right away. Not after a
    // failure, though — see the header.
    if (!failed && dirty && timer === null && !running) {
      return flush();
    }
  }

  return {
    schedule,
    flush,
    // For tests and debugging: is anything unsaved or in flight?
    get hasPendingWork() {
      return dirty || running !== null;
    },
  };
}
