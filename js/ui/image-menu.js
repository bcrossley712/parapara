// js/ui/image-menu.js
//
// The top bar's Image button and its menu (3a): the one home for the
// reference image. Add image (Adjust image once this frame has one),
// and Hide/Show images for the whole project; 3b adds Use on all frames
// and Flip photo here. The button shows state at a glance: a dot when
// this frame has an image, a slashed picture when images are hidden.
//
// Pure UI: main.js passes state in through render() and gets intents
// back through the callbacks. The menu hangs below the button, inside
// the shell (`container`), right-aligned to it.

// callbacks: onImage() (add or adjust — must open the picker
//   synchronously, iOS only allows it inside the tap),
//   onToggleImages()
// options.container: the element the menu is positioned in.
// options.signal: aborts the tap-outside listener when the editor is
//   torn down.
export function createImageMenu(callbacks, { container, signal } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pp-icon-btn pp-image-btn';
  button.setAttribute('aria-haspopup', 'menu');
  const icon = document.createElement('span');
  icon.className = 'pp-image-btn__icon';
  const dot = document.createElement('span');
  dot.className = 'pp-image-btn__dot';
  button.append(icon, dot);

  let state = { current: false, any: false, hidden: false, busy: false };
  let menu = null;

  function closeMenu() {
    menu?.remove();
    menu = null;
    button.classList.remove('is-active');
  }

  function openMenu() {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'pp-image-menu';
    menu.setAttribute('role', 'menu');
    menu.append(item(state.current ? 'Adjust image' : 'Add image', () => callbacks.onImage()));
    if (state.any) {
      menu.append(item(state.hidden ? 'Show images' : 'Hide images', () => callbacks.onToggleImages()));
    }
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
    if (menu) closeMenu();
    else openMenu();
  });

  // A tap anywhere but the menu or the button (whose own click
  // toggles it) closes it.
  document.addEventListener('pointerdown', (event) => {
    if (!menu || menu.contains(event.target) || button.contains(event.target)) return;
    closeMenu();
  }, { signal, capture: true });

  // state: { current (this frame has an image), any (some frame has
  //   one), hidden (Hide images is on), busy }
  function render(next) {
    state = { ...state, ...next };
    if (menu) closeMenu();
    icon.innerHTML = state.hidden ? IMAGE_HIDDEN_ICON : IMAGE_ICON;
    dot.hidden = !state.current;
    button.disabled = state.busy;
    let label = 'Image';
    if (state.current) label += ' (this frame has one)';
    if (state.hidden) label += ', hidden';
    button.setAttribute('aria-label', label);
    button.classList.toggle('has-image', state.current);
    button.classList.toggle('is-hidden-images', state.hidden);
  }

  render({});
  return { button, render, closeMenu };
}

// A framed picture: sun and hills.
const IMAGE_ICON = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/>
  <circle cx="8.5" cy="9.5" r="1.8" fill="currentColor"/>
  <path d="M4 18 9.5 12.5l3.5 3.5 2.5-2.5L20 18Z" fill="currentColor"/>
</svg>`;

// The same, struck through: images are hidden.
const IMAGE_HIDDEN_ICON = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="2" opacity="0.6"/>
  <circle cx="8.5" cy="9.5" r="1.8" fill="currentColor" opacity="0.6"/>
  <path d="M4 18 9.5 12.5l3.5 3.5 2.5-2.5L20 18Z" fill="currentColor" opacity="0.6"/>
  <path d="M3.5 3.5 20.5 20.5" stroke="var(--pp-ink-light)" stroke-width="4.5" stroke-linecap="round"/>
  <path d="M3.5 3.5 20.5 20.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;
