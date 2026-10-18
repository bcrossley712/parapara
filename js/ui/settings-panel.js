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
// - Developer section (temporary, remove before "done"): Fresh reload
//   and Clear drawing. Clear moved here from the rail because there's
//   no undo yet (2b), so a stray tap on the rail would wipe her work.
//
// Talks to the rest of the app only through the `actions` callbacks —
// it doesn't know about the updater, canvas or storage.

export function createSettingsPanel(actions) {
  const {
    getVersionLabel,   // () => Promise<string>
    checkForUpdate,    // () => Promise<'ready'|'none'|'error'|'unsupported'>
    applyUpdate,       // () => Promise<void>, reloads the page
    freshReload,       // () => Promise<void>, reloads the page
    clearDrawing,      // () => void
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

  panel.append(title, versionRow, checkBtn, status, devLabel, freshBtn, freshHint, clearBtn);

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

  // Opens beside `anchor`, bottom-aligned with it (the gear sits at
  // the bottom of the rail, so the panel grows upward).
  function setOpen(next, anchor) {
    open = next;
    panel.classList.toggle('pp-settings--hidden', !next);
    if (next) {
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        panel.style.left = `${rect.right + 8}px`;
        panel.style.bottom = `${window.innerHeight - rect.bottom}px`;
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

function makeButton(label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp-settings__btn';
  btn.textContent = label;
  return btn;
}
