// js/ui/settings-panel.js
//
// The gear menu: a floating panel (same style and open/close behavior
// as the color picker) for app-level actions, matching how Sketchbook
// and Procreate keep these behind one gear/wrench instead of in the
// tool rail.
//
// Contents:
// - Version: which build is running.
// - Check for updates (permanent). If an update is found it's applied
//   right away (with a reload).
// - Developer section (temporary, remove before "done"): Fresh reload,
//   Clear drawing (moved here from the rail before undo existed, so a
//   stray tap couldn't wipe her work), and Fill all layers — adds layers
//   up to the cap and paints each one, to stress-test canvas memory on
//   the iPad. Both edits are undoable. Clear and Fill only exist in the
//   editor; the gallery's gear menu leaves them out.
//
// Talks to the rest of the app only through the `actions` callbacks —
// it doesn't know about the updater, canvas or storage.

export function createSettingsPanel(actions) {
  const {
    getVersionLabel,   // () => Promise<string>
    checkForUpdate,    // () => Promise<'ready'|'none'|'error'|'unsupported'>
    applyUpdate,       // () => Promise<void>, reloads the page
    freshReload,       // () => Promise<void>, reloads the page
    clearDrawing,      // () => void, optional (editor only)
    fillAllLayers,     // () => void, optional (editor only)
  } = actions;

  const panel = document.createElement('div');
  panel.className = 'pp-settings pp-settings--hidden';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Settings');

  const title = document.createElement('div');
  title.className = 'pp-settings__title';
  title.textContent = 'Settings';

  const versionRow = document.createElement('div');
  versionRow.className = 'pp-settings__row';
  const versionLabel = document.createElement('span');
  versionLabel.textContent = 'Version';
  const versionValue = document.createElement('span');
  versionValue.className = 'pp-settings__version';
  versionValue.textContent = '…';
  versionRow.append(versionLabel, versionValue);

  const checkBtn = makeButton('Check for updates');
  const status = document.createElement('div');
  status.className = 'pp-settings__status';
  status.setAttribute('role', 'status');

  const devLabel = document.createElement('div');
  devLabel.className = 'pp-settings__section';
  devLabel.textContent = 'Developer';

  const freshBtn = makeButton('Fresh reload');
  const freshHint = document.createElement('div');
  freshHint.className = 'pp-settings__hint';
  freshHint.textContent = 'Re-downloads the app. Drawings are kept.';

  const clearBtn = makeButton('Clear drawing');

  const fillBtn = makeButton('Fill all layers');
  const fillHint = document.createElement('div');
  fillHint.className = 'pp-settings__hint';
  fillHint.textContent = 'Memory test: adds layers up to the limit and paints each. Undoable.';

  panel.append(title, versionRow, checkBtn, status, devLabel, freshBtn, freshHint);
  if (clearDrawing) panel.append(clearBtn);
  if (fillAllLayers) panel.append(fillBtn, fillHint);

  let open = false;
  let busy = false;

  function setBusy(next) {
    busy = next;
    checkBtn.disabled = next;
    freshBtn.disabled = next;
  }

  async function refreshVersion() {
    try {
      versionValue.textContent = await getVersionLabel();
    } catch {
      versionValue.textContent = 'Unknown';
    }
  }

  checkBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    status.textContent = 'Checking…';
    let result;
    try {
      result = await checkForUpdate();
    } catch {
      result = 'error';
    }
    if (result === 'ready') {
      status.textContent = 'Updating…';
      await applyUpdate(); // reloads; stays busy until then
      return;
    }
    status.textContent = {
      none: "You're up to date.",
      error: "Couldn't check. Are you online?",
      unsupported: "Updates aren't available here.",
    }[result] ?? "Couldn't check.";
    setBusy(false);
  });

  freshBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    status.textContent = 'Reloading…';
    await freshReload(); // reloads
  });

  clearBtn.addEventListener('click', () => {
    clearDrawing();
    setOpen(false);
  });

  fillBtn.addEventListener('click', () => {
    fillAllLayers();
    setOpen(false);
  });

  // Opens next to `anchor`. 'beside' (the editor's gear, at the bottom
  // of the rail): to its right, bottom-aligned, growing upward.
  // 'below' (the gallery's gear, top right): under it, right-aligned.
  function setOpen(next, anchor, placement = 'beside') {
    open = next;
    panel.classList.toggle('pp-settings--hidden', !next);
    if (next) {
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        if (placement === 'below') {
          panel.style.left = '';
          panel.style.bottom = '';
          panel.style.top = `${rect.bottom + 8}px`;
          panel.style.right = `${window.innerWidth - rect.right}px`;
        } else {
          panel.style.top = '';
          panel.style.right = '';
          panel.style.left = `${rect.right + 8}px`;
          panel.style.bottom = `${window.innerHeight - rect.bottom}px`;
        }
      }
      if (!busy) status.textContent = '';
      refreshVersion();
    }
  }

  return {
    element: panel,
    get isOpen() { return open; },
    setOpen,
  };
}

// Wires a gear `button` to a settings panel appended to `container`:
// the button toggles it, a tap anywhere outside closes it (like the
// color picker). `onOpen` runs before it opens (e.g. to close another
// floating panel). Document listeners are removed when `signal`
// aborts, so a screen that closes leaves nothing behind.
export function attachSettingsMenu({ button, container, actions, placement, onOpen, signal }) {
  const panel = createSettingsPanel(actions);
  container.appendChild(panel.element);

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!panel.isOpen) onOpen?.();
    panel.setOpen(!panel.isOpen, button, placement);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!panel.isOpen) return;
    if (panel.element.contains(event.target) || button.contains(event.target)) return;
    panel.setOpen(false);
  }, { signal });

  return panel;
}

function makeButton(label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp-settings__btn';
  btn.textContent = label;
  return btn;
}
