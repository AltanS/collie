// tmux's mark, as bytes this adapter owns.
//
// THE LOGO IS ADAPTER-SUPPLIED DATA, never a frontend asset keyed by a name. The phone renders
// whatever the active adapter published at `/api/mux/logo.svg` (bridge/server.ts) and recognises
// nothing — the same rule that keeps a multiplexer's NAME off the frontend
// (scripts/check-mux-names.sh) applies to its picture.
//
// It is a string in TypeScript rather than a file on disk on purpose: the journal is the only part
// of the bridge that touches the filesystem (CLAUDE.md), and a logo is not a reason to widen that.
//
// ── Provenance ──────────────────────────────────────────────────────────────────────────────────
//
// The GEOMETRY is the official tmux logomark, redrawn to the same 160×160 grid from
// https://github.com/tmux/tmux/blob/master/logo/tmux-logomark.svg — the Sketch cruft (generator
// comment, ids, layer groups, `sketch:` namespace) is gone and the two overlapping bar subpaths are
// resolved into the one strip they actually paint:
//
//   Copyright (c) 2015, Jason Long <jason@jasonlong.me>
//   Permission to use, copy, modify, and/or distribute this software for any purpose with or
//   without fee is hereby granted, provided that the above copyright notice and this permission
//   notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" …
//
// ── The ONE deviation from the original, and why it is not optional ─────────────────────────────
//
// The original screen body is `#3C3C3C`. The header this renders in is `bg-muted`, which in the dark
// theme is `oklch(0.269 0 0)` — the same grey to within a hair, so a faithful mark is an invisible
// mark on half of Collie's users. The body is therefore a mid grey that clears BOTH muted values
// (light `oklch(0.94)`, dark `oklch(0.269)`). The status bar keeps tmux's own green untouched: it is
// the colour anyone recognises the mark by, and it reads on either background already.
export const TMUX_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><path fill="#767676" fill-rule="evenodd" d="M15 0h130c8.3 0 15 6.7 15 15v131H0V15C0 6.7 6.7 0 15 0zM77 0h6v70h77v6H83v70h-6z"/><path fill="#1BB91F" d="M0 146h160c0 7.7-6.7 14-15 14H15c-8.3 0-15-6.3-15-14z"/></svg>`;
