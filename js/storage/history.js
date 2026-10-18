// js/storage/history.js
//
// Undo/redo history: one project-wide stack, in memory only — never
// saved (see PROJECT_NOTES.md, Undo/redo). Pure data structure: no DOM,
// no canvas. main.js pushes entries and supplies the `swap` function
// that actually moves pixels; this file only decides what's kept.
//
// Entry shape (tagged, so 2c's layer-structure entries can be added
// alongside without changing this file):
//   { type: 'pixels', frameId, layerId, rect: {x, y, w, h}, patch: ImageData, bytes }
//
// Each entry holds exactly ONE patch at a time. On undo, `swap` puts
// the stored "before" pixels back and returns the entry carrying the
// "after" pixels it replaced; redo does the reverse. Same rect, same
// size — so moving an entry between the stacks never changes the
// total, and the byte budget covers undo and redo together.

export const MAX_UNDO_STEPS = 30;
export const MAX_UNDO_BYTES = 150 * 1024 * 1024;

// options.onChange: called after any change to what can be undone or
// redone (push, undo, redo, clear) — ui.js uses it to enable/disable
// the buttons.
export function createHistory(options = {}) {
  const {
    maxSteps = MAX_UNDO_STEPS,
    maxBytes = MAX_UNDO_BYTES,
    onChange = () => {},
  } = options;

  const undoStack = []; // oldest first
  const redoStack = []; // next redo last
  let totalBytes = 0;

  function sizeOf(entry) {
    return entry.bytes ?? 0;
  }

  function dropRedo() {
    for (const entry of redoStack) totalBytes -= sizeOf(entry);
    redoStack.length = 0;
  }

  // Oldest undo entries go first. Redo is always empty when this runs
  // (push clears it), so trimming only ever touches the undo stack.
  // The newest entry is always kept, even if it alone is over budget —
  // a full-canvas edit should still be undoable once.
  function trim() {
    while (
      undoStack.length > 1
      && (undoStack.length > maxSteps || totalBytes > maxBytes)
    ) {
      totalBytes -= sizeOf(undoStack.shift());
    }
  }

  // Moves the top entry of `from` through `swap` onto `to`. If swap
  // throws or returns nothing, the entry is dropped rather than left
  // in a state that no longer matches the canvas.
  function move(from, to, swap) {
    const entry = from.pop();
    if (!entry) return false;
    totalBytes -= sizeOf(entry);
    let next = null;
    try {
      next = swap(entry);
    } catch (err) {
      console.error('Parapara! undo/redo failed:', err);
    }
    if (next) {
      to.push(next);
      totalBytes += sizeOf(next);
    }
    onChange();
    return Boolean(next);
  }

  return {
    // A new edit: becomes the newest undo step and clears redo.
    push(entry) {
      dropRedo();
      undoStack.push(entry);
      totalBytes += sizeOf(entry);
      trim();
      onChange();
    },

    // swap(entry) => entry with the swapped-out patch (see top of file).
    // Returns true if something was undone.
    undo(swap) {
      return move(undoStack, redoStack, swap);
    },

    redo(swap) {
      return move(redoStack, undoStack, swap);
    },

    // The next entry undo/redo would act on, without acting.
    peekUndo() {
      return undoStack[undoStack.length - 1] ?? null;
    },
    peekRedo() {
      return redoStack[redoStack.length - 1] ?? null;
    },

    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      totalBytes = 0;
      onChange();
    },

    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get undoCount() { return undoStack.length; },
    get redoCount() { return redoStack.length; },
    get bytes() { return totalBytes; },
  };
}
