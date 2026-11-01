// js/ui/restore-sheet.js
//
// Owns: the Restore sheet (step 7b push 2) — opened from the empty
// gallery's "Restore from backup" and from the Backup sheet. Signing
// in (when this device isn't connected yet), picking what comes back,
// and progress. Styled like the app's dialogs; reuses the Share
// sheet's progress bar.
//
// Knows nothing about the backup itself: main.js moves it between
// phases with show(state).
//   'preparing'  — fetching the Worker's challenge
//   'signin'     — explains the passkey, Continue (`note` if it failed)
//   'connecting' — signing in
//   'loading'    — reading the backup's list
//   'pick'       — `items` (restore.list()), Restore N; ticked: every
//                  current project not on this device; Deleted
//                  recently unticked; on this device: shown, not
//                  pickable
//   'empty'      — nothing in the backup
//   'working'    — `done`, `total`, `name`
//   'done'       — `message`
//   'failed'     — `note`, Try again (onRetry)
// callbacks: { onSignIn, onRestore(items), onRetry, onClose } —
// onSignIn runs synchronously in its tap (the passkey sheet).

const CHECK_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Which items start ticked.
export function defaultPicks(items) {
  return new Set(items.filter((i) => !i.here && !i.deleted).map((i) => i.projectId));
}

export function restoreButtonLabel(count) {
  if (count === 0) return 'Restore';
  return `Restore ${count}`;
}

// The closing line after a restore (restore.restore()'s result).
export function restoreDoneText(result) {
  const n = result.restored;
  const parts = [n === 0 ? 'Nothing new to bring back.' : `Brought back ${n} animation${n === 1 ? '' : 's'}.`];
  if (result.failed.length) {
    const names = result.failed.map((f) => f.name).join(', ');
    parts.push(`${result.failed.length === 1 ? 'One' : result.failed.length} couldn't be restored: ${names}.`);
  }
  if (result.missingBlobs) parts.push('Some drawings were missing from the backup and came back blank.');
  return parts.join(' ');
}

export function createRestoreSheet(callbacks = {}, { signal } = {}) {
  const {
    onSignIn = () => {}, onRestore = () => {}, onRetry = () => {}, onClose = () => {},
  } = callbacks;

  const backdrop = document.createElement('div');
  backdrop.className = 'pp-dialog-backdrop pp-restore';

  const dialog = document.createElement('div');
  dialog.className = 'pp-dialog pp-restore__dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Restore from backup');

  const title = document.createElement('div');
  title.className = 'pp-dialog__title';
  title.textContent = 'Restore from backup';

  const message = document.createElement('div');
  message.className = 'pp-dialog__message pp-restore__message';

  const list = document.createElement('div');
  list.className = 'pp-restore__list';

  const progress = document.createElement('div');
  progress.className = 'pp-export__progress';
  const progressFill = document.createElement('div');
  progressFill.className = 'pp-export__progress-fill';
  progress.appendChild(progressFill);

  const note = document.createElement('div');
  note.className = 'pp-dialog__message pp-restore__note';
  note.setAttribute('role', 'status');

  const buttons = document.createElement('div');
  buttons.className = 'pp-dialog__buttons';

  dialog.append(title, message, list, progress, note, buttons);
  backdrop.appendChild(dialog);

  let state = { phase: 'closed' };
  let picks = new Set();
  let urls = [];

  function freeUrls() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
  }

  function button(label, primary, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `pp-dialog__btn${primary ? ' pp-dialog__btn--primary' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  const closeBtn = (label = 'Close') => button(label, false, () => close());

  const busy = () => ['connecting', 'working'].includes(state.phase);

  function row(item, restoreBtn) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pp-restore__item';
    el.dataset.projectId = item.projectId;
    const thumb = document.createElement('div');
    thumb.className = 'pp-restore__thumb';
    if (item.thumbnail) {
      const url = URL.createObjectURL(new Blob([item.thumbnail.bytes], { type: item.thumbnail.type }));
      urls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      thumb.appendChild(img);
    }
    const text = document.createElement('div');
    text.className = 'pp-restore__text';
    const name = document.createElement('div');
    name.className = 'pp-restore__name';
    name.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'pp-restore__sub';
    const frames = `${item.frameCount} frame${item.frameCount === 1 ? '' : 's'}`;
    sub.textContent = item.here ? `${frames} · On this iPad` : frames;
    text.append(name, sub);
    const tick = document.createElement('span');
    tick.className = 'pp-restore__tick';
    tick.innerHTML = CHECK_SVG;
    el.append(thumb, text, tick);

    const sync = () => {
      const on = picks.has(item.projectId);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      el.classList.toggle('is-on', on);
    };
    if (item.here) {
      el.disabled = true;
      el.classList.add('is-here');
    } else {
      el.addEventListener('click', () => {
        if (picks.has(item.projectId)) picks.delete(item.projectId);
        else picks.add(item.projectId);
        sync();
        restoreBtn.textContent = restoreButtonLabel(picks.size);
        restoreBtn.disabled = picks.size === 0;
      });
    }
    sync();
    return el;
  }

  function renderList(items, restoreBtn) {
    freeUrls();
    list.replaceChildren();
    const current = items.filter((i) => !i.deleted);
    const deleted = items.filter((i) => i.deleted);
    for (const item of current) list.appendChild(row(item, restoreBtn));
    if (deleted.length) {
      const head = document.createElement('div');
      head.className = 'pp-restore__section';
      head.textContent = 'Deleted recently';
      list.appendChild(head);
      for (const item of deleted) list.appendChild(row(item, restoreBtn));
    }
  }

  function render() {
    const s = state;
    backdrop.dataset.phase = s.phase;
    buttons.replaceChildren();
    note.textContent = s.note ?? '';
    list.hidden = s.phase !== 'pick';
    progress.hidden = !['preparing', 'connecting', 'loading', 'working'].includes(s.phase);
    progress.classList.toggle('is-waiting', s.phase !== 'working');
    if (s.phase !== 'pick') {
      freeUrls();
      list.replaceChildren();
    }
    switch (s.phase) {
      case 'preparing':
        message.textContent = 'Getting ready…';
        buttons.append(closeBtn('Cancel'));
        break;
      case 'signin':
        message.textContent = 'The iPad asks for the passkey that keeps the backup (Touch ID). On a new iPad signed in to the same Apple account, it’s already there. Backup then stays on for this iPad.';
        buttons.append(closeBtn('Cancel'), button('Continue', true, () => onSignIn()));
        break;
      case 'connecting':
        message.textContent = 'Opening the backup…';
        break;
      case 'loading':
        message.textContent = 'Looking for your animations…';
        buttons.append(closeBtn('Cancel'));
        break;
      case 'pick': {
        const items = s.items ?? [];
        picks = defaultPicks(items);
        message.textContent = 'Choose what to bring back. Animations already on this iPad stay as they are.';
        const restoreBtn = button(restoreButtonLabel(picks.size), true, () => {
          const chosen = items.filter((i) => picks.has(i.projectId));
          if (chosen.length) onRestore(chosen);
        });
        restoreBtn.disabled = picks.size === 0;
        renderList(items, restoreBtn);
        buttons.append(closeBtn('Cancel'), restoreBtn);
        break;
      }
      case 'empty':
        message.textContent = 'There’s nothing in the backup yet.';
        buttons.append(closeBtn());
        break;
      case 'working': {
        const total = Math.max(1, s.total ?? 1);
        const done = Math.min(s.done ?? 0, total);
        message.textContent = s.name
          ? `Bringing back ${done + 1} of ${total}: ${s.name}`
          : 'Finishing…';
        progressFill.style.width = `${Math.round((done / total) * 100)}%`;
        break;
      }
      case 'done':
        message.textContent = s.message ?? '';
        buttons.append(button('Done', true, () => close()));
        break;
      case 'failed':
        message.textContent = 'Restore didn’t finish.';
        buttons.append(closeBtn(), button('Try again', true, () => onRetry()));
        break;
      default:
        break;
    }
    if (s.phase !== 'working') progressFill.style.width = '';
  }

  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target !== backdrop) return;
    event.preventDefault();
    if (!busy()) close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busy()) close();
  });

  function show(nextState) {
    state = { ...nextState };
    if (!backdrop.isConnected) document.body.appendChild(backdrop);
    render();
  }

  function close() {
    if (state.phase === 'closed') return;
    state = { phase: 'closed' };
    freeUrls();
    backdrop.remove();
    onClose();
  }

  signal?.addEventListener('abort', () => {
    state = { phase: 'closed' };
    freeUrls();
    backdrop.remove();
  });

  return {
    show,
    close,
    get isOpen() { return state.phase !== 'closed'; },
    get phase() { return state.phase; },
  };
}
