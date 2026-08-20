// Herdr's mark, as bytes this adapter owns. The rules and the reasoning are stated once, in
// bridge/mux/tmux/logo.ts — read that header first; this file only records what is different.
//
// ── Provenance: DRAWN. Herdr publishes no logo ──────────────────────────────────────────────────
//
// So this is a minimal glyph rather than a reproduction: a flock — three shapes of different sizes,
// gathered — on a teal tile. A FLOCK and deliberately not a dog: the Collie mark itself sits two
// centimetres to the left in the very same header (components/collie-home.tsx), and two dogs in one
// row would read as one thing said twice.
//
// Two-tone, because an `<img>` cannot inherit `currentColor` — the file is fetched, not inlined, so
// nothing in it can track the theme. Both tones are therefore picked to clear `bg-muted` in BOTH
// themes at once: the teal sits between the light value (`oklch(0.94)`) and the dark one
// (`oklch(0.269)`), and the cream is brighter than either.
export const HERDR_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><path fill="#1F6F6B" d="M24 8h112c8.8 0 16 7.2 16 16v112c0 8.8-7.2 16-16 16H24c-8.8 0-16-7.2-16-16V24c0-8.8 7.2-16 16-16z"/><g fill="#F2E9D8"><circle cx="60" cy="102" r="26"/><circle cx="104" cy="72" r="19"/><circle cx="118" cy="114" r="13"/></g></svg>`;
