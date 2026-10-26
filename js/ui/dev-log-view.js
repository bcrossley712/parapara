// js/ui/dev-log-view.js
//
// DEV ONLY: shows the activity log (storage/dev-log.js) from the gear
// menu's Developer section, newest at the bottom, with Copy (the newest
// lines, to paste into a message), Copy all and Clear. Looks like the app's own dialogs; the
// text can also be selected by hand if Copy isn't allowed. Remove with
// the rest of the Developer section.

import { DEV_LOG_COPY_LINES } from '../storage/dev-log.js';

// `read(last?)` gives the log text, only the newest `last` lines if given.
export function showDevLog({ read, clear }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'pp-dialog-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'pp-dialog pp-dev-report pp-dev-log';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Activity log');

  const heading = document.createElement('div');
  heading.className = 'pp-dialog__title';
  heading.textContent = 'Activity log';

  const status = document.createElement('div');
  status.className = 'pp-dialog__message';
  status.setAttribute('role', 'status');

  const text = document.createElement('pre');
  text.className = 'pp-dev-log__text';

  function fill() {
    const log = read();
    text.textContent = log || 'Nothing logged yet.';
    status.textContent = log ? `${log.split('\n').length} lines, newest at the bottom.` : '';
  }
  fill();

  const buttons = document.createElement('div');
  buttons.className = 'pp-dialog__buttons';
  const clearBtn = button('Clear');
  const copyAllBtn = button('Copy all');
  const copyBtn = button(`Copy last ${DEV_LOG_COPY_LINES}`);
  const closeBtn = button('Close', true);
  buttons.append(clearBtn, copyAllBtn, copyBtn, closeBtn);

  clearBtn.addEventListener('click', () => {
    clear();
    fill();
  });
  // Copies the newest `last` lines (all if Infinity). If the clipboard
  // isn't allowed, selects them so the system's Copy works.
  async function copy(last, done) {
    const chosen = read(last);
    try {
      await navigator.clipboard.writeText(chosen);
      status.textContent = done;
    } catch {
      const node = text.firstChild;
      const range = document.createRange();
      if (node && node.nodeType === Node.TEXT_NODE && chosen) {
        range.setStart(node, Math.max(0, node.length - chosen.length));
        range.setEnd(node, node.length);
      } else {
        range.selectNodeContents(text);
      }
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = "Couldn't copy automatically. The text is selected — use Copy from the menu.";
    }
  }
  copyBtn.addEventListener('click', () => copy(DEV_LOG_COPY_LINES, `Copied the last ${DEV_LOG_COPY_LINES} lines. Paste them into a message.`));
  copyAllBtn.addEventListener('click', () => copy(Infinity, 'Copied the whole log. Paste it into a message.'));
  closeBtn.addEventListener('click', () => backdrop.remove());

  dialog.append(heading, status, text, buttons);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  text.scrollTop = text.scrollHeight;
}

function button(label, primary = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = primary ? 'pp-dialog__btn pp-dialog__btn--primary' : 'pp-dialog__btn';
  btn.textContent = label;
  return btn;
}
