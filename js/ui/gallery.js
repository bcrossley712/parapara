// js/ui/gallery.js
//
// Owns: the project gallery screen — a grid of cards (thumbnail of
// frame 1, name, frame count), a "new animation" tile first, and the
// gear menu. UI only: it asks before deleting and collects a new name,
// then reports intents through callbacks; main.js does the storage.
//
// Conventions (Procreate / Flipaclip): tap a card to open it, tap its
// name to rename it, and the ⋯ button for Rename / Duplicate / Delete.
// Delete asks first because it can't be undone.

import { attachSettingsMenu } from './settings-panel.js';
import { showConfirm, showPrompt } from './confirm-dialog.js';
import { GEAR_ICON } from './icons.js';
import { MAX_PROJECT_NAME } from '../storage/storage.js';

// callbacks: { onOpen(id), onCreate(), onRename(id, name),
//   onDuplicate(id), onDelete(id) }
// appActions: for the gear menu (see settings-panel.js) — no editor
//   actions here.
//
// Returns { render(projects), setThumbnail(id, blob), setBusy(busy),
// destroy() }. A project for render() is { id, name, frameCount,
// thumbnail: Blob | null }.
export function createGallery(container, { callbacks, appActions = {} }) {
  const { onOpen, onCreate, onRename, onDuplicate, onDelete } = callbacks;
  container.innerHTML = '';
  const listeners = new AbortController();
  const { signal } = listeners;

  const shell = document.createElement('div');
  shell.className = 'pp-app-shell pp-gallery-screen';

  // Dark like the editor's top bar: it sits under the iPad status bar.
  const topBar = document.createElement('div');
  topBar.className = 'pp-top-bar';
  const title = document.createElement('h1');
  title.className = 'pp-gallery__title';
  title.textContent = 'Parapara!';
  const spacer = document.createElement('div');
  spacer.className = 'pp-top-bar__spacer';
  const gearBtn = document.createElement('button');
  gearBtn.type = 'button';
  gearBtn.className = 'pp-icon-btn';
  gearBtn.setAttribute('aria-label', 'Settings');
  gearBtn.innerHTML = GEAR_ICON;
  topBar.append(title, spacer, gearBtn);

  const scroller = document.createElement('div');
  scroller.className = 'pp-gallery';
  const grid = document.createElement('div');
  grid.className = 'pp-gallery__grid';
  const hint = document.createElement('p');
  hint.className = 'pp-gallery__hint';
  scroller.append(grid, hint);

  shell.append(topBar, scroller);
  container.appendChild(shell);

  const unavailable = async () => 'unsupported';
  const settingsPanel = attachSettingsMenu({
    button: gearBtn,
    container: shell,
    actions: {
      getVersionLabel: appActions.getVersionLabel ?? (async () => 'Unknown'),
      checkForUpdate: appActions.checkForUpdate ?? unavailable,
      applyUpdate: appActions.applyUpdate ?? (async () => window.location.reload()),
      freshReload: appActions.freshReload ?? (async () => window.location.reload()),
    },
    placement: 'below',
    onOpen: () => closeMenu(),
    signal,
  });

  let busy = false;
  let projects = [];
  // Object URLs for the thumbnails on screen, revoked when replaced.
  const thumbUrls = new Map(); // project id -> url
  const thumbImgs = new Map(); // project id -> the card's thumb element

  // --- the ⋯ menu (one at a time) ---
  let openMenu = null;
  let menuAnchor = null;
  function closeMenu() {
    openMenu?.remove();
    openMenu = null;
    menuAnchor = null;
  }
  // A tap anywhere else closes it. Its own ⋯ button is left to its
  // click handler, which toggles.
  document.addEventListener('pointerdown', (event) => {
    if (!openMenu || openMenu.contains(event.target) || menuAnchor?.contains(event.target)) return;
    closeMenu();
  }, { signal, capture: true });

  function showMenu(project, anchor) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'pp-gallery-menu';
    menu.setAttribute('role', 'menu');
    const renameBtn = menuButton('Rename', () => askRename(project));
    const duplicateBtn = menuButton('Duplicate', () => { if (!busy) onDuplicate(project.id); });
    const deleteBtn = menuButton('Delete', () => askDelete(project));
    deleteBtn.classList.add('pp-gallery-menu__item--danger');
    menu.append(renameBtn, duplicateBtn, deleteBtn);
    anchor.closest('.pp-gallery-card').appendChild(menu);
    openMenu = menu;
    menuAnchor = anchor;
  }

  function menuButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-gallery-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      closeMenu();
      onClick();
    });
    return btn;
  }

  async function askRename(project) {
    if (busy) return;
    const name = await showPrompt({
      title: 'Rename animation', value: project.name, confirmLabel: 'Rename', maxLength: MAX_PROJECT_NAME,
    });
    if (name && name !== project.name) onRename(project.id, name);
  }

  async function askDelete(project) {
    if (busy) return;
    const yes = await showConfirm({
      title: `Delete “${project.name}”?`,
      message: "Every frame and layer in it will be deleted. This can't be undone.",
      confirmLabel: 'Delete',
      danger: true,
    });
    if (yes) onDelete(project.id);
  }

  // --- cards ---

  function newTile() {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'pp-gallery-new';
    tile.setAttribute('aria-label', 'New animation');
    tile.innerHTML = `
      <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" focusable="false">
        <path d="M12 4v16M4 12h16" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
      </svg>
      <span>New animation</span>`;
    tile.addEventListener('click', () => {
      if (!busy) onCreate();
    });
    return tile;
  }

  function card(project) {
    const el = document.createElement('div');
    el.className = 'pp-gallery-card';
    el.dataset.projectId = project.id;

    const thumbBtn = document.createElement('button');
    thumbBtn.type = 'button';
    thumbBtn.className = 'pp-gallery-card__thumb';
    thumbBtn.setAttribute('aria-label', `Open ${project.name}`);
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    thumbBtn.appendChild(img);
    thumbBtn.addEventListener('click', () => {
      if (!busy) onOpen(project.id);
    });
    thumbImgs.set(project.id, img);
    showThumb(project.id, project.thumbnail);

    const info = document.createElement('div');
    info.className = 'pp-gallery-card__info';
    const text = document.createElement('div');
    text.className = 'pp-gallery-card__text';
    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'pp-gallery-card__name';
    // Clamped to two lines by CSS (on the span — line-clamp is
    // unreliable on a <button> itself); the rename field shows it all.
    const nameText = document.createElement('span');
    nameText.className = 'pp-gallery-card__name-text';
    nameText.textContent = project.name;
    nameBtn.append(nameText);
    nameBtn.setAttribute('aria-label', `Rename ${project.name}`);
    nameBtn.addEventListener('click', () => askRename(project));
    const meta = document.createElement('div');
    meta.className = 'pp-gallery-card__meta';
    meta.textContent = project.frameCount === 1 ? '1 frame' : `${project.frameCount} frames`;
    text.append(nameBtn, meta);

    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'pp-gallery-card__more';
    moreBtn.setAttribute('aria-label', `More for ${project.name}`);
    moreBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <g fill="currentColor"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></g>
      </svg>`;
    moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (busy) return;
      if (menuAnchor === moreBtn) closeMenu();
      else showMenu(project, moreBtn);
    });

    info.append(text, moreBtn);
    el.append(thumbBtn, info);
    return el;
  }

  function showThumb(id, blob) {
    const img = thumbImgs.get(id);
    if (!img) return;
    const old = thumbUrls.get(id);
    if (old) URL.revokeObjectURL(old);
    thumbUrls.delete(id);
    if (blob) {
      const url = URL.createObjectURL(blob);
      thumbUrls.set(id, url);
      img.src = url;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true; // the card's white paper shows instead
    }
  }

  function render(next) {
    projects = next;
    closeMenu();
    for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
    thumbUrls.clear();
    thumbImgs.clear();
    grid.replaceChildren(newTile(), ...projects.map(card));
    hint.textContent = projects.length === 0 ? 'Tap New animation to start your first one.' : '';
  }

  function setBusy(next) {
    busy = next;
    shell.classList.toggle('is-busy', next);
  }

  function destroy() {
    listeners.abort();
    closeMenu();
    for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
    thumbUrls.clear();
    settingsPanel.setOpen(false);
    container.innerHTML = '';
  }

  return {
    render,
    setThumbnail: showThumb,
    setBusy,
    destroy,
    get projects() { return projects; },
  };
}
