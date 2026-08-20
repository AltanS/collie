// Zellij's mark, as bytes this adapter owns. The rules and the reasoning are stated once, in
// bridge/mux/tmux/logo.ts — read that header first; this file only records what is different.
//
// ── Provenance: a REDRAWN SIMPLIFICATION of the official mark ────────────────────────────────────
//
// Source: https://zellij.dev/img/logo.png (2269×2620). Zellij's own vector file
// (`assets/logo.svg`, https://github.com/zellij-org/zellij, MIT) is not usable here: it is a 24 KB
// traced bitmap — 84 paths, 70 distinct fills — which is far past what a header glyph may cost and
// which resolves to mud at the 16–20 px this renders at.
//
// So the mark below is hand-written to the SAME composition, simplified until it survives that size:
// a zellige mosaic in a pointy-top hexagon. Near-black field and leading; a large light-blue inner
// hexagonal pane carrying a terminal prompt (`>` chevron and `_` bar); mosaic tile segments set into
// the ring around it — rose down the left, green across the top and bottom, sand down the right. The
// original's dozens of irregular tesserae become one clean segment per hexagon edge (two on the
// right, as the original has there). What is dropped is the irregularity, never an element.
//
// The five colours are the official artwork's own, sampled from that file:
//
//   #080317  field and leading      #7e9fbe  the inner pane
//   #be616b  rose      #a3bd8d  green      #eacb8b  sand
//
// ── No colour deviation here, unlike tmux's ─────────────────────────────────────────────────────
//
// The field is very close to the dark theme's `bg-muted` (`oklch(0.269)`), which is exactly the trap
// tmux's mark fell into — but this composition does not depend on its field being visible. The
// coloured ring and the blue pane carry the silhouette, and the near-black then reads as the leading
// BETWEEN tiles rather than as a shape that has gone missing. Verified by rasterising at 20 px over
// both muted values before the palette was left alone.
export const ZELLIJ_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><path fill="#080317" d="M80 0l69.3 40v80L80 160l-69.3-40V40z"/><path fill="#be616b" d="M17.6 112.4V47.6l12.2 6.3v52.2z"/><path fill="#a3bd8d" d="M25.1 39.7L72.5 12.3l1.5 13.2-38.2 22zM87.5 12.3l47.4 27.4-10.7 7.8-38.2-22zM134.9 120.3L87.5 147.7L86 134.5l38.2-22zM72.5 147.7L25.1 120.3l10.7-7.8 38.2 22z"/><path fill="#eacb8b" d="M142.4 49.8v28l-12.2.5V55.6zM142.4 82.2v28l-12.2-5.8V81.7z"/><path fill="#7e9fbe" d="M80 28l45 26v52l-45 26-45-26V54z"/><path fill="#080317" d="M54 48l34 26v5l-34 26-9.5-9.5L73.5 76.5 44.5 57.5zM89 95h29v10H89z"/></svg>`;
