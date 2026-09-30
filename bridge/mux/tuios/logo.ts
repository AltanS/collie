// tuios's mark, as bytes this adapter owns. The rules and the reasoning are stated once, in
// bridge/mux/tmux/logo.ts — read that header first; this file only records what is different.
//
// ── Provenance: REPRODUCED from tuios's own repository ─────────────────────────────────────────
//
// tuios publishes its mark in `assets/brand/mark-32.svg` (github.com/Gaurav-Gosain/tuios, MIT). The
// shapes and colours below are that file's, byte for byte. Three edits, none to what it draws: the
// fixed 32 px size is dropped so the header sizes it, and the unused `xlink` namespace and an
// identity transform are dropped.
//
// ── The one deviation from the original, and why it is not optional ─────────────────────────────
//
// The original fills the body with a gradient, `#e5cffc` to `#a987ea`, through `fill="url(#…)"`.
// Every logo here must reach nothing outside itself, and `logo.test.ts` refuses `url(` outright, so
// the body is one flat fill at the gradient's midpoint, `#c7abf3`. The near-black outline carries the
// silhouette on the light `bg-muted` and the violet carries it on the dark one, so neither theme
// loses the shape.
export const TUIOS_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g><g stroke="#11111b" stroke-width="3.4" stroke-linecap="round"><line x1="12.5" y1="9" x2="9" y2="3.6"/><line x1="19.5" y1="9" x2="23" y2="3.6"/></g><g stroke="#7f849c" stroke-width="1.4" stroke-linecap="round"><line x1="12.5" y1="9" x2="9" y2="3.6"/><line x1="19.5" y1="9" x2="23" y2="3.6"/></g><g stroke="#11111b" stroke-width="1.2"><circle cx="8.6" cy="3.2" r="2.3" fill="#f9e2af"/><circle cx="23.4" cy="3.2" r="2.3" fill="#89dceb"/></g><rect x="1.75" y="8.75" width="28.5" height="22.5" rx="6.5" fill="#c7abf3" stroke="#11111b" stroke-width="1.5"/><rect x="4.5" y="11.5" width="23" height="16.5" rx="3" fill="#11111b"/><rect x="5.75" y="12.75" width="9.75" height="8" rx="1.4" fill="#262637" stroke="#74c7ec" stroke-width="1"/><rect x="16.5" y="12.25" width="10.25" height="9" rx="1.6" fill="#262637"/><rect x="5.25" y="22.25" width="21.5" height="4.75" rx="1.4" fill="#262637"/><g fill="#89dceb"><rect x="9.6" y="14.5" width="2.2" height="4.5" rx="0.7"/><rect x="20.5" y="14.5" width="2.2" height="4.5" rx="0.7"/></g><g stroke="#a6e3a1" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" fill="none"><polyline points="13.6,23.3 15,24.6 13.6,25.9"/><line x1="16.4" y1="25.9" x2="18.6" y2="25.9"/></g></g></svg>`;
