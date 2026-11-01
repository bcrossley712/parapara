// js/ui/backup-sheet.js
//
// Owns: the Backup sheet (step 7b push 1), opened from the gear menu
// on either screen — turning backup on, and how it's doing. Styled
// like the app's dialogs (confirm-dialog.js, export-sheet.js).
//
// Turning on is an adult's job and takes three taps: the invite code
// (Next checks it and fetches the Worker's challenge), then Turn on,
// which must call the passkey sheet synchronously inside the tap
// (Safari), and — only if this iPad gives no PRF secret at creation —
// Finish, a second passkey tap. iPadOS 27's iCloud Keychain gives it
// at creation, so she won't normally see Finish.
//
// Knows nothing about the backup itself: main.js moves it between
// phases with show(state).
//   'off'      — what it is, the invite field, `note` (why the last
//                try didn't work)
//   'checking' — checking the invite
//   'confirm'  — explains the passkey, Turn on (`note` if it failed)
//   'finish'   — one more passkey tap
//   'working'  — turning on
//   'on'       — `status` (backupStatusText) and `usage` lines, Back
//                up now (disabled while `running`)
// callbacks: { onNext(invite), onTurnOn, onFinish, onBackupNow,
// onRestore, onTurnOff, onClose } — onTurnOn and onFinish run
// synchronously in their taps.
//
// Push 2 (restore): 'off' also offers Restore from backup (signing in
// connects this device to an existing backup — also how a device that
// was turned off gets back to the same one); 'on' offers Restore… and
// Turn off on this iPad, as smaller links under the main buttons.

import { formatSize } from './export-sheet.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms) {
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(ms / DAY);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const PROBLEMS = {
  offline: 'there’s no internet',
  revoked: 'this invite was turned off',
  unauthorized: 'this iPad needs to be set up again',
  'over-limit': 'the backup space is full',
  paused: 'backups are paused',
};

// One line for the sheet from backup.status() (+ navigator.onLine).
export function backupStatusText(status, { online = true, now = Date.now() } = {}) {
  if (status.running) return 'Backing up…';
  if (!online) return status.pending ? 'Waiting for the internet to back up the latest changes.' : 'Waiting for the internet.';
  if (status.lastError) {
    const why = PROBLEMS[status.lastError] ?? 'the backup server had a problem';
    return `Backup isn’t working right now: ${why}. It will keep trying.`;
  }
  if (status.lastOkAt && status.pending) return `Backed up ${ago(now - status.lastOkAt)}. Waiting to back up the latest changes.`;
  if (status.lastOkAt) return `Backed up ${ago(now - status.lastOkAt)}.`;
  return 'Not backed up yet.';
}

export function backupUsageText(usage) {
  if (!usage) return '';
  const limit = usage.limit >= 1024 ** 3 ? `${Math.round(usage.limit / 1024 ** 3)} GB` : formatSize(usage.limit);
  return `Using ${usage.used > 0 ? formatSize(usage.used) : 'nothing yet'} of ${limit}.`;
}

export function createBackupSheet(callbacks = {}, { signal } = {}) {
  const {
    onNext = () => {}, onTurnOn = () => {}, onFinish = () => {}, onBackupNow = () => {},
    onRestore = () => {}, onTurnOff = () => {}, onClose = () => {},
  } = callbacks;

  const backdrop = document.createElement('div');
  backdrop.className = 'pp-dialog-backdrop pp-backup';

  const dialog = document.createElement('div');
  dialog.className = 'pp-dialog pp-backup__dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Backup');

  const title = document.createElement('div');
  title.className = 'pp-dialog__title';
  title.textContent = 'Backup';

  const message = document.createElement('div');
  message.className = 'pp-dialog__message pp-backup__message';

  const detail = document.createElement('div');
  detail.className = 'pp-dialog__message pp-backup__detail';

  const field = document.createElement('input');
  field.type = 'text';
  field.className = 'pp-dialog__input pp-backup__invite';
  field.placeholder = 'Invite code';
  field.setAttribute('aria-label', 'Invite code');
  field.autocomplete = 'off';
  field.autocapitalize = 'off';
  field.spellcheck = false;
  field.maxLength = 100;

  const note = document.createElement('div');
  note.className = 'pp-dialog__message pp-backup__note';
  note.setAttribute('role', 'status');

  const buttons = document.createElement('div');
  buttons.className = 'pp-dialog__buttons';

  const extra = document.createElement('div');
  extra.className = 'pp-backup__extra';

  dialog.append(title, message, detail, field, note, buttons, extra);
  backdrop.appendChild(dialog);

  let state = { phase: 'closed' };

  function button(label, primary, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `pp-dialog__btn${primary ? ' pp-dialog__btn--primary' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  const closeBtn = (label = 'Close') => button(label, false, () => close());

  function link(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-backup__link';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  const next = () => {
    const invite = field.value.trim();
    if (invite) onNext(invite);
  };

  function render() {
    const s = state;
    backdrop.dataset.phase = s.phase;
    buttons.replaceChildren();
    extra.replaceChildren();
    field.hidden = s.phase !== 'off';
    detail.textContent = '';
    note.textContent = s.note ?? '';
    switch (s.phase) {
      case 'off': {
        message.textContent = 'Keeps a private, encrypted copy of every animation online, automatically. A parent turns it on with an invite code.';
        const nextBtn = button('Next', true, next);
        const sync = () => { nextBtn.disabled = field.value.trim() === ''; };
        field.oninput = sync;
        sync();
        buttons.append(closeBtn(), nextBtn);
        extra.append(link('Restore from backup', () => onRestore()));
        break;
      }
      case 'checking':
        message.textContent = 'Checking the invite…';
        buttons.append(closeBtn('Cancel'));
        break;
      case 'confirm':
        message.textContent = 'Next, the iPad asks to save a passkey for Parapara!. It’s kept with the Apple account’s passwords, and it’s how a new iPad gets the drawings back.';
        buttons.append(closeBtn('Cancel'), button('Turn on', true, () => onTurnOn()));
        break;
      case 'finish':
        message.textContent = 'One more step to finish turning on backup.';
        buttons.append(closeBtn('Cancel'), button('Finish', true, () => onFinish()));
        break;
      case 'working':
        message.textContent = 'Turning on backup…';
        break;
      case 'on': {
        message.textContent = s.status ?? '';
        detail.textContent = s.usage ?? '';
        const now = button('Back up now', true, () => onBackupNow());
        now.disabled = s.running === true;
        buttons.append(closeBtn(), now);
        extra.append(link('Restore…', () => onRestore()), link('Turn off on this iPad', () => onTurnOff()));
        break;
      }
      default:
        break;
    }
  }

  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target !== backdrop) return;
    event.preventDefault();
    if (state.phase !== 'working') close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.phase !== 'working') close();
    if (event.key === 'Enter' && event.target === field) {
      event.preventDefault();
      next();
    }
  });

  function show(nextState) {
    const wasOff = state.phase === 'off';
    state = { ...nextState };
    if (!backdrop.isConnected) document.body.appendChild(backdrop);
    render();
    if (state.phase === 'off' && !wasOff) field.focus();
  }

  function close() {
    if (state.phase === 'closed') return;
    state = { phase: 'closed' };
    backdrop.remove();
    onClose();
  }

  signal?.addEventListener('abort', () => {
    state = { phase: 'closed' };
    backdrop.remove();
  });

  return {
    show,
    close,
    get isOpen() { return state.phase !== 'closed'; },
    get phase() { return state.phase; },
  };
}
