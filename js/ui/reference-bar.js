// js/ui/reference-bar.js
//
// The adjust-mode bar (step 3a): stands in for the tool rail while she
// places a frame's reference image. Opacity slider, Flip ↔ / Flip ↕
// (3b — both, as Procreate's and Sketchbook's transforms have),
// Replace, Delete and Done. While it's up, touches on the canvas move the image (see
// canvas.js adjust mode); tapping any other control commits, the same
// as Done (ui.js handles that).
//
// Pure UI: main.js passes the opacity in and gets intents back through
// the callbacks.

// callbacks: onOpacityInput(value 0-1) (live, while dragging),
//   onReplace() (must open the picker synchronously — iOS only allows
//   it inside the tap), onFlip('horizontal' | 'vertical'), onDelete(),
//   onDone()
export function createReferenceBar(callbacks) {
  const bar = document.createElement('div');
  bar.className = 'pp-reference-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Adjust image');

  const title = document.createElement('div');
  title.className = 'pp-reference-bar__title';
  title.textContent = 'Image';

  const opacityLabel = document.createElement('label');
  opacityLabel.className = 'pp-brush-size pp-reference-bar__opacity';
  const opacityText = document.createElement('span');
  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = '0';
  opacityInput.max = '100';
  opacityInput.setAttribute('aria-label', 'Image opacity');
  opacityLabel.append(opacityText, opacityInput);
  opacityInput.addEventListener('input', () => {
    const value = Number(opacityInput.value) / 100;
    showOpacity(value);
    callbacks.onOpacityInput(value);
  });

  // The arrows are SVG, not ↔/↕ text: iOS draws ↕ as a blue emoji.
  const flipH = button('Flip', () => callbacks.onFlip('horizontal'));
  flipH.setAttribute('aria-label', 'Flip horizontally');
  flipH.insertAdjacentHTML('beforeend', flipArrow(0));
  const flipV = button('Flip', () => callbacks.onFlip('vertical'));
  flipV.setAttribute('aria-label', 'Flip vertically');
  flipV.insertAdjacentHTML('beforeend', flipArrow(90));

  const replaceBtn = button('Replace', () => callbacks.onReplace());
  const deleteBtn = button('Delete', () => callbacks.onDelete());
  deleteBtn.classList.add('pp-reference-bar__delete');
  const doneBtn = button('Done', () => callbacks.onDone());
  doneBtn.classList.add('is-active', 'pp-reference-bar__done');

  // Done first, where Draw sits on the rail; Delete at the bottom,
  // away from it.
  bar.append(title, doneBtn, opacityLabel, flipH, flipV, replaceBtn, deleteBtn);

  function button(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-tool-btn pp-reference-bar__btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function showOpacity(value) {
    opacityText.textContent = `Opacity ${Math.round(value * 100)}%`;
  }

  return {
    element: bar,
    setOpacity(value) {
      opacityInput.value = String(Math.round(value * 100));
      showOpacity(value);
    },
  };
}

// A double-headed arrow (left↔right), turned `degrees` for the
// vertical one, so both are the same drawing.
function flipArrow(degrees) {
  return `
<svg class="pp-reference-bar__arrow" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
  <g transform="rotate(${degrees} 8 8)" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3"/>
  </g>
</svg>`;
}
