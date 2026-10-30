// js/ui/export-sheet.js
//
// Owns: the Share sheet (step 6a) — the dialog the top bar's Share
// button opens: what will be made, the progress while it's made, and
// the Share button once the file is ready. Styled like the app's
// dialogs (confirm-dialog.js) and above everything, so nothing in the
// project can change while a video is being made.
//
// Two taps by necessity: iOS opens its share sheet only from inside a
// tap, and making the video takes seconds, so Make video → (progress)
// → Share. A departure from Flipaclip, which goes straight to the
// share sheet (agreed at 6a scoping).
//
// Knows nothing about video: main.js runs the export and moves the
// sheet between phases with show(state).
//   phase 'start'    — summary, Make video (or why it can't), and the
//                      Include images switch when a frame has a photo
//                      (`hasImages`, `includeImages`; 6d)
//   phase 'getting-ready' — frames still being flattened
//   phase 'making'   — progress, Cancel
//   phase 'ready'    — size and length (and `note`, e.g. sharing
//                      didn't open), Share, Done
//   phase 'error'    — what went wrong, Try again, Close
// A tap on the dim area closes it, except while getting ready or
// making (only Cancel stops that).
//
// callbacks: { onMake, onCancel, onShare, onClose, onIncludeImages }
// — onShare runs synchronously in the Share tap (iOS);
// onIncludeImages(on) when the switch is flipped (main.js saves it on
// the project and shows the sheet again).

export function createExportSheet(callbacks = {}, { signal } = {}) {
  const {
    onMake = () => {}, onCancel = () => {}, onShare = () => {}, onClose = () => {},
    onIncludeImages = () => {},
  } = callbacks;

  const backdrop = document.createElement('div');
  backdrop.className = 'pp-dialog-backdrop pp-export';

  const dialog = document.createElement('div');
  dialog.className = 'pp-dialog pp-export__dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Share');

  const title = document.createElement('div');
  title.className = 'pp-dialog__title';

  const message = document.createElement('div');
  message.className = 'pp-dialog__message pp-export__message';

  const progress = document.createElement('div');
  progress.className = 'pp-export__progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', 'Making video');
  const progressFill = document.createElement('div');
  progressFill.className = 'pp-export__progress-fill';
  progress.appendChild(progressFill);

  // Include images (6d): whether the photos go in the video — separate
  // from Hide images, which is only what she sees while drawing.
  const imagesRow = document.createElement('div');
  imagesRow.className = 'pp-export__option';
  const imagesLabel = document.createElement('span');
  imagesLabel.className = 'pp-export__option-label';
  imagesLabel.id = 'pp-export-images-label';
  imagesLabel.textContent = 'Include images';
  const imagesSwitch = document.createElement('button');
  imagesSwitch.type = 'button';
  imagesSwitch.className = 'pp-switch pp-export__images';
  imagesSwitch.setAttribute('role', 'switch');
  imagesSwitch.setAttribute('aria-labelledby', imagesLabel.id);
  imagesSwitch.appendChild(document.createElement('span')).className = 'pp-switch__knob';
  imagesSwitch.addEventListener('click', () => {
    if (state.phase === 'start') onIncludeImages(!state.includeImages);
  });
  imagesRow.append(imagesLabel, imagesSwitch);

  const buttons = document.createElement('div');
  buttons.className = 'pp-dialog__buttons';

  dialog.append(title, message, imagesRow, progress, buttons);
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

  const closeBtn = (label) => button(label, false, () => close());

  function render() {
    const s = state;
    progress.hidden = !(s.phase === 'making' || s.phase === 'getting-ready');
    progress.classList.toggle('is-waiting', s.phase === 'getting-ready');
    buttons.replaceChildren();
    backdrop.dataset.phase = s.phase;
    imagesRow.hidden = !(s.phase === 'start' && s.supported && s.hasImages);
    imagesSwitch.setAttribute('aria-checked', String(s.includeImages === true));
    switch (s.phase) {
      case 'start': {
        title.textContent = 'Share';
        if (!s.supported) {
          message.textContent = 'This iPad can’t make videos. It needs a newer version of iPadOS.';
          buttons.append(closeBtn('Close'));
          break;
        }
        const what = s.hasSound ? 'A video of the whole animation, with its sound' : 'A video of the whole animation';
        message.textContent = `${what}: ${plural(s.frames, 'frame')}, ${formatSeconds(s.seconds)}.`;
        const make = button('Make video', true, () => onMake());
        buttons.append(closeBtn('Cancel'), make);
        // Not when the switch was just tapped — focus stays there.
        if (document.activeElement !== imagesSwitch) make.focus();
        break;
      }
      case 'getting-ready':
        title.textContent = 'Making video';
        message.textContent = 'Getting ready…';
        progressFill.style.width = '';
        progress.removeAttribute('aria-valuenow');
        buttons.append(button('Cancel', false, () => onCancel()));
        break;
      case 'making': {
        title.textContent = 'Making video';
        message.textContent = `Frame ${s.done} of ${s.total}`;
        const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
        progressFill.style.width = `${pct}%`;
        progress.setAttribute('aria-valuenow', String(pct));
        buttons.append(button('Cancel', false, () => onCancel()));
        break;
      }
      case 'ready': {
        title.textContent = 'Your video is ready';
        message.textContent = `${formatSeconds(s.seconds)} · ${formatSize(s.size)}`
          + (s.note ? ` — ${s.note}` : '');
        const share = button('Share', true, () => onShare());
        share.classList.add('pp-export__share');
        buttons.append(closeBtn('Done'), share);
        share.focus();
        break;
      }
      case 'error': {
        title.textContent = 'The video wasn’t made';
        message.textContent = s.message || 'Something went wrong.';
        buttons.append(closeBtn('Close'), button('Try again', true, () => onMake()));
        break;
      }
      default:
        break;
    }
  }

  const busyPhase = () => state.phase === 'making' || state.phase === 'getting-ready';

  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target !== backdrop) return;
    event.preventDefault();
    if (!busyPhase()) close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !busyPhase()) close();
  });

  function show(next) {
    state = { ...next };
    if (!backdrop.isConnected) document.body.appendChild(backdrop);
    render();
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

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatSeconds(seconds) {
  const s = Math.max(0, seconds);
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} seconds`.replace(/^1\.0 seconds$/, '1 second');
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}:${String(rest).padStart(2, '0')}`;
}

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
