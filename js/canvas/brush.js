// js/canvas/brush.js
//
// Brush "tip" implementations. A brush is just a shape stamped
// repeatedly along a path (see canvas.js's stampAlongLine/
// stampAlongQuadratic) — ctx.fillStyle and globalCompositeOperation
// are set by the caller before stamping, so a brush only needs to
// know its own shape, not color or draw/erase mode.
//
// This is the seam for tip variety (chisel, textured, etc.) later:
// adding a new tip means adding a new object here with a stamp()
// function, not touching pointer-handling/smoothing/palm-rejection in
// canvas.js. Only the round tip exists today, matching the currently
// decided toolset — this file exists to hold the seam, not to add
// tools that haven't been agreed yet.

export const roundBrush = {
  // Fraction of brush diameter between stamps along a path — smaller
  // means smoother coverage but more stamps (and more cost) per
  // stroke. 0.2 is a common starting point for a solid-looking round
  // brush; revisit once tested on the real device if strokes look
  // dotted (too sparse) or feel slow (too dense).
  spacingRatio: 0.2,

  stamp(ctx, point, size) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  },
};
