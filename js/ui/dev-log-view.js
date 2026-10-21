// js/ui/dev-log-view.js
//
// DEV ONLY: shows the activity log (storage/dev-log.js) from the gear
// menu's Developer section, newest at the bottom, with Copy (to paste
// it into a message) and Clear. Looks like the app's own dialogs; the
// text can also be selected by hand if Copy isn't allowed. Remove with
// the rest of the Developer section.

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
  const copyBtn = button('Copy');
  const closeBtn = button('Close', true);
  buttons.append(clearBtn, copyBtn, closeBtn);

  clearBtn.addEventListener('click', () => {
    clear();
    fill();
  });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(read());
      status.textContent = 'Copied. Paste it into a message.';
    } catch {
      // Not allowed here: select it so the system's Copy works.
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = "Couldn't copy automatically. The text is selected — use Copy from the menu.";
    }
  });
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
