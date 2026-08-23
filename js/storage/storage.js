// js/storage/storage.js
//
// Owns: IndexedDB wrapper, project/frame schema (source of truth —
// see PROJECT_NOTES.md), undo/redo command stack (raster snapshots
// per frame), storage-used estimation for the quota-warning UI.
//
// This is the module every other module reads its data shape from.
// Extend the schema additively (new optional fields) rather than
// restructuring, per the working agreement.
//
// Not built yet — step 2 of the build order.

export function initStorage() {
  // TODO: IndexedDB open/upgrade, project CRUD, undo/redo stack
}
