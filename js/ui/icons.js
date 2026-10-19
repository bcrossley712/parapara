// js/ui/icons.js
//
// Icons shared by more than one screen (editor and gallery), drawn
// here as inline SVG rather than pulled from an icon set.

// Gear icon, drawn here rather than pulled from an icon set: four bars
// crossed at 45° make the eight teeth, a disc makes the body, and the
// hole is filled with the button's own background color.
export const GEAR_ICON = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <g fill="currentColor">
    <rect x="10" y="1.5" width="4" height="21" rx="1"/>
    <rect x="10" y="1.5" width="4" height="21" rx="1" transform="rotate(45 12 12)"/>
    <rect x="10" y="1.5" width="4" height="21" rx="1" transform="rotate(90 12 12)"/>
    <rect x="10" y="1.5" width="4" height="21" rx="1" transform="rotate(135 12 12)"/>
    <circle cx="12" cy="12" r="7.5"/>
  </g>
  <circle cx="12" cy="12" r="3" fill="var(--pp-ink-light)"/>
</svg>`;

// Gallery: a 2×2 grid of rounded tiles, like the gallery buttons in
// Procreate and Flipaclip.
export const GALLERY_ICON = `
<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
  <g fill="currentColor">
    <rect x="3" y="3" width="8" height="8" rx="2"/>
    <rect x="13" y="3" width="8" height="8" rx="2"/>
    <rect x="3" y="13" width="8" height="8" rx="2"/>
    <rect x="13" y="13" width="8" height="8" rx="2"/>
  </g>
</svg>`;
