// Zellij's mark, as bytes this adapter owns. The rules and the reasoning are stated once, in
// bridge/mux/tmux/logo.ts — read that header first; this file only records what is different.
//
// ── Provenance: DRAWN, not fetched, and the official file is why ────────────────────────────────
//
// Zellij's own `assets/logo.svg` (https://github.com/zellij-org/zellij, MIT) is a 24 KB traced
// bitmap — 84 paths, 70 distinct fills, a full illustration. It is far past the size a config
// payload should carry, and at the 16–20 px this renders at it resolves to mud. So the mark below is
// drawn: Zellij's signature pointy-top HEXAGON, tiled by the pane splits the tool is named for.
//
// The COLOURS are the official artwork's own two, sampled from that file: the sage `#A2BC8C` it
// paints its subject in, and the near-black `#1C1E34` of its field. Sage on the field, rather than
// the field with sage on it, because the dark navy is invisible against a dark theme's `bg-muted`
// while sage clears both themes — the same legibility constraint tmux's logo header spells out.
export const ZELLIJ_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><path fill="#A2BC8C" d="M80 0l69.3 40v80L80 160 10.7 120V40z"/><path fill="#1C1E34" d="M76 12h8v136h-8zM22 76h54v8H22z"/></svg>`;
