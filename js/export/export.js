// js/export/export.js
//
// Owns: stitching frames into GIF/WebM for output, native Web Share
// API handoff. No backend required for this tier — see
// docs/DESIGN_NOTES.md "Planned features" (Cloudflare Worker + R2 for
// shareable links is a later, separate tier). Container/codec is
// decided at step 6.
//
// Not built yet — step 6 of the build order.

export function exportAnimation(/* project */) {
  // TODO: GIF/WebM stitching + Web Share API
}
