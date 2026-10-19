// js/ui/confirm-dialog.js
//
// Owns: the app's modal dialogs — custom-styled, never the browser's
// confirm()/prompt() (working agreement). A dimmed backdrop covers the
// whole screen and swallows touches until she answers; tapping the
// backdrop counts as Cancel. One dialog at a time: opening another
// cancels the first.
//
// showConfirm: a yes/no question (deleting a project).
// showPrompt: one line of text (renaming a project).
// Both return a Promise of the answer; nothing here knows what the
// answer is for.

let closeCurrent = null;

// Resolves true (confirmed) or false (cancelled). `danger` paints the
// confirm button red, for actions that can't be undone.
export function showConfirm({ title, message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return openDialog({ title, message, confirmLabel, cancelLabel, danger, input: null })
    .then((answer) => answer !== null);
}

// Resolves the trimmed text, or null if cancelled. Confirm is disabled
// while the text is blank.
export function showPrompt({ title, value = '', confirmLabel = 'OK', cancelLabel = 'Cancel', maxLength = 60 }) {
  return openDialog({ title, message: '', confirmLabel, cancelLabel, danger: false, input: { value, maxLength } });
}

function openDialog({ title, message, confirmLabel, cancelLabel, danger, input }) {
  closeCurrent?.(null);

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'pp-dialog-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'pp-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', title);

    const heading = document.createElement('div');
    heading.className = 'pp-dialog__title';
    heading.textContent = title;
    dialog.appendChild(heading);

    if (message) {
      const text = document.createElement('div');
      text.className = 'pp-dialog__message';
      text.textContent = message;
      dialog.appendChild(text);
    }

    let field = null;
    if (input) {
      field = document.createElement('input');
      field.type = 'text';
      field.className = 'pp-dialog__input';
      field.value = input.value;
      field.maxLength = input.maxLength;
      field.setAttribute('aria-label', title);
      field.autocomplete = 'off';
      field.spellcheck = false;
      dialog.appendChild(field);
    }

    const buttons = document.createElement('div');
    buttons.className = 'pp-dialog__buttons';
    const cancelBtn = makeButton(cancelLabel, 'pp-dialog__btn');
    const confirmBtn = makeButton(
      confirmLabel,
      `pp-dialog__btn pp-dialog__btn--primary${danger ? ' pp-dialog__btn--danger' : ''}`
    );
    buttons.append(cancelBtn, confirmBtn);
    dialog.appendChild(buttons);
    backdrop.appendChild(dialog);

    function close(answer) {
      if (closeCurrent !== close) return;
      closeCurrent = null;
      backdrop.remove();
      resolve(answer);
    }
    closeCurrent = close;

    function confirm() {
      if (!field) {
        close(true);
        return;
      }
      const text = field.value.trim();
      if (text) close(text);
    }

    if (field) {
      const sync = () => { confirmBtn.disabled = field.value.trim() === ''; };
      field.addEventListener('input', sync);
      sync();
    }

    cancelBtn.addEventListener('click', () => close(null));
    confirmBtn.addEventListener('click', confirm);
    // A tap on the dim area (not the dialog) cancels.
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === backdrop) {
        event.preventDefault();
        close(null);
      }
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close(null);
      // Enter submits the text field; on buttons it presses whichever
      // is focused, as usual.
      if (event.key === 'Enter' && event.target === field) {
        event.preventDefault();
        confirm();
      }
    });

    document.body.appendChild(backdrop);
    if (field) {
      field.focus();
      field.select();
    } else {
      // A keyboard Enter shouldn't be able to delete something by default.
      (danger ? cancelBtn : confirmBtn).focus();
    }
  });
}

function makeButton(label, className) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  return btn;
}
