// js/ui/sound-menu.js
//
// The top bar's Sound button (step 5), beside Image and Layers, with a
// dot when the project has sound. In 5a it opens a small menu — Import
// sound, and Delete sound once there is one; in 5b the button opens the
// sound panel (waveform, trim, record) instead, and this menu goes.
//
// Pure UI: main.js passes state in through render() and gets intents
// back through the callbacks. The menu hangs below the button, inside
// the shell (`container`), right-aligned to it — like the Image menu,
// whose look it shares (its own class names, so neither button's
// lookups ever match the other).

// callbacks: onButton() — the button was tapped; return false to keep
//   the menu shut (main.js: a tap while playing only stops playback),
//   onImport() (must open the file picker synchronously, iOS only
//   allows it inside the tap), onDelete()
// options.container: the element the menu is positioned in.
// options.signal: aborts the tap-outside listener when the editor is
//   torn down.
export function createSoundMenu(callbacks, { container, signal } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pp-icon-btn pp-sound-btn';
  button.setAttribute('aria-haspopup', 'menu');
  const icon = document.createElement('span');
  icon.className = 'pp-sound-btn__icon';
  icon.innerHTML = SOUND_ICON;
  const dot = document.createElement('span');
  dot.className = 'pp-sound-btn__dot';
  button.append(icon, dot);

  let state = { has: false, busy: false };
  let menu = null;

  function closeMenu() {
    menu?.remove();
    menu = null;
    button.classList.remove('is-active');
  }

  function openMenu() {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'pp-sound-menu';
    menu.setAttribute('role', 'menu');
    menu.append(item(state.has ? 'Replace sound' : 'Import sound', () => callbacks.onImport()));
    if (state.has) menu.append(item('Delete sound', () => callbacks.onDelete()));
    container.appendChild(menu);
    const box = container.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    menu.style.top = `${b.bottom - box.top + 6}px`;
    menu.style.right = `${Math.max(8, box.right - b.right)}px`;
    button.classList.add('is-active');
  }

  function item(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-frame-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = label;
    btn.disabled = state.busy;
    btn.addEventListener('click', () => {
      closeMenu();
      onClick();
    });
    return btn;
  }

  button.addEventListener('click', () => {
    if (menu) {
      closeMenu();
      return;
    }
    if (callbacks.onButton?.() === false) return;
    openMenu();
  });

  // A tap anywhere but the menu or the button (whose own click
  // toggles it) closes it.
  document.addEventListener('pointerdown', (event) => {
    if (!menu || menu.contains(event.target) || button.contains(event.target)) return;
    closeMenu();
  }, { signal, capture: true });

  // state: { has (the project has sound), busy }
  function render(next) {
    state = { ...state, ...next };
    if (menu) closeMenu();
    dot.hidden = !state.has;
    button.disabled = state.busy;
    button.setAttribute('aria-label', state.has ? 'Sound (this animation has sound)' : 'Sound');
    button.classList.toggle('has-sound', state.has);
  }

  render({});
  return { button, render, closeMenu };
}

// A pair of beamed eighth notes.
const SOUND_ICON = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <path d="M9 17.5V6l11-2.5v11.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  <ellipse cx="6.5" cy="17.5" rx="2.8" ry="2.2" fill="currentColor"/>
  <ellipse cx="17.5" cy="15" rx="2.8" ry="2.2" fill="currentColor"/>
</svg>`;
