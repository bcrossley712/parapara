// js/ui/symmetry-menu.js
//
// The rail's Symmetry button and its menu (8b-i): Off, Vertical,
// Horizontal, Both. The axis is fixed at the canvas center (her
// decision), so this is the whole control. The button's icon shows the
// mode, and it lights up while symmetry is on — she can tell why her
// line is doubling. The menu opens to the right of the button, like
// the color picker.
//
// Pure UI: main.js keeps the mode (per project) and passes it in with
// render(); a pick comes back through onPick(mode).

export const SYMMETRY_LABELS = {
  off: 'Off',
  vertical: 'Vertical',
  horizontal: 'Horizontal',
  both: 'Both',
};

// options.container: the element the menu is positioned in.
// options.signal: aborts the tap-outside listener on teardown.
export function createSymmetryMenu(onPick, { container, signal } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pp-tool-btn pp-symmetry-btn';
  button.setAttribute('aria-haspopup', 'menu');
  const icon = document.createElement('span');
  icon.className = 'pp-symmetry-btn__icon';
  const text = document.createElement('span');
  text.className = 'pp-symmetry-btn__text';
  text.textContent = 'Symmetry';
  button.append(icon, text);

  let mode = 'off';
  let menu = null;

  function closeMenu() {
    menu?.remove();
    menu = null;
    button.classList.remove('is-open');
  }

  function openMenu() {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'pp-symmetry-menu';
    menu.setAttribute('role', 'menu');
    for (const key of Object.keys(SYMMETRY_LABELS)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pp-frame-menu__item pp-symmetry-menu__item';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(key === mode));
      item.classList.toggle('is-current', key === mode);
      item.dataset.mode = key;
      const itemIcon = document.createElement('span');
      itemIcon.className = 'pp-symmetry-menu__icon';
      itemIcon.innerHTML = ICONS[key];
      const label = document.createElement('span');
      label.textContent = SYMMETRY_LABELS[key];
      item.append(itemIcon, label);
      item.addEventListener('click', () => {
        closeMenu();
        onPick(key);
      });
      menu.appendChild(item);
    }
    container.appendChild(menu);
    const box = container.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    menu.style.left = `${b.right - box.left + 8}px`;
    const bottomLimit = box.height - menu.offsetHeight - 8;
    menu.style.top = `${Math.max(8, Math.min(b.top - box.top, bottomLimit))}px`;
    button.classList.add('is-open');
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

  function render(next) {
    mode = SYMMETRY_LABELS[next] ? next : 'off';
    if (menu) closeMenu();
    icon.innerHTML = ICONS[mode];
    button.classList.toggle('is-active', mode !== 'off');
    button.setAttribute('aria-label', `Symmetry: ${SYMMETRY_LABELS[mode]}`);
  }

  render('off');
  return {
    button,
    render,
    closeMenu,
    // Open menus make a canvas tap only close them (ui.js).
    get isMenuOpen() { return menu !== null; },
  };
}

// A leaf-ish shape and its mirror across the axis (dashed). currentColor
// throughout, so the icons follow the button's on/off colors.
const SHAPE = 'M11 4.5C6 5 3.5 8.5 3.5 12S6 19 11 19.5Z';
const AXIS_V = '<path d="M12 3v18" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2"/>';
const AXIS_H = '<path d="M3 12h18" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 2"/>';

const ICONS = {
  off: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
    <path d="${SHAPE}" fill="currentColor" transform="translate(4.5 0)"/>
  </svg>`,
  vertical: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
    <path d="${SHAPE}" fill="currentColor"/>
    <path d="${SHAPE}" fill="currentColor" transform="matrix(-1 0 0 1 24 0)"/>
    ${AXIS_V}
  </svg>`,
  horizontal: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
    <path d="${SHAPE}" fill="currentColor" transform="matrix(0 1 1 0 0 0)"/>
    <path d="${SHAPE}" fill="currentColor" transform="matrix(0 -1 1 0 0 24)"/>
    ${AXIS_H}
  </svg>`,
  both: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
    <path d="${SHAPE}" fill="currentColor" transform="matrix(0.5 0 0 0.5 4.5 -0.5)"/>
    <path d="${SHAPE}" fill="currentColor" transform="matrix(-0.5 0 0 0.5 19.5 -0.5)"/>
    <path d="${SHAPE}" fill="currentColor" transform="matrix(0.5 0 0 -0.5 4.5 24.5)"/>
    <path d="${SHAPE}" fill="currentColor" transform="matrix(-0.5 0 0 -0.5 19.5 24.5)"/>
    ${AXIS_V}${AXIS_H}
  </svg>`,
};
