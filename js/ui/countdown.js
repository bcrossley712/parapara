// js/ui/countdown.js
//
// The countdown before a recording starts (5c): a big number over the
// middle of the canvas area — 3, 2, 1 — silent. main.js says which
// number to show and when to hide it; the timing is main.js's.
// It never takes touches (pointer-events: none), so it can't steal the
// held mic's pointer.

export function createCountdown(container) {
  const element = document.createElement('div');
  element.className = 'pp-countdown';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'assertive');
  element.hidden = true;
  const number = document.createElement('span');
  number.className = 'pp-countdown__number';
  const hint = document.createElement('span');
  hint.className = 'pp-countdown__hint';
  hint.textContent = 'Keep holding';
  element.append(number, hint);
  container.appendChild(element);

  return {
    element,
    // Shows `n` (restarting its little pop animation).
    show(n) {
      element.hidden = false;
      number.textContent = String(n);
      number.classList.remove('is-pop');
      void number.offsetWidth; // restart the animation
      number.classList.add('is-pop');
    },
    hide() {
      element.hidden = true;
    },
    get shown() {
      return !element.hidden;
    },
  };
}
