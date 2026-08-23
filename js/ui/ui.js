// js/ui/ui.js
//
// Owns: tool rail (draw/erase/fill/smudge/brush-size/image-import/
// mic/pan), transport controls, project gallery screen, DOM glue
// between the other modules. Custom-styled dialogs only — no native
// confirm()/alert()/date-input chrome, per the working agreement.
//
// Not built yet — layout confirmed in wireframing, not implemented.

export function initUI(/* project */) {
  // TODO: tool rail, transport, gallery screen, custom dialogs
}

// PWA update prompt — shown when a new service worker has installed
// and is waiting to take over. Custom-styled, per the working
// agreement against native confirm()/alert(). Deliberately simple
// for now (styling matches app background, not yet the full toolkit
// look); refine alongside the rest of ui/ once that exists.
export function showUpdatePrompt(onRefresh) {
  // Avoid stacking a second toast if this somehow fires twice.
  if (document.getElementById('pp-update-toast')) return;

  const toast = document.createElement('div');
  toast.id = 'pp-update-toast';
  toast.className = 'pp-update-toast';
  toast.innerHTML = `
    <span class="pp-update-toast__text">New version available</span>
    <button type="button" class="pp-update-toast__btn">Refresh</button>
  `;

  toast.querySelector('.pp-update-toast__btn').addEventListener('click', () => {
    toast.remove();
    onRefresh();
  });

  document.body.appendChild(toast);
}
