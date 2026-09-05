// The mirror's colour space, shared by every surface that renders terminal segments verbatim.
//
// Terminal colour is DARK-space colour: an agent picks bright yellow because it will sit on a near
// black background. So these surfaces are authored in dark space under every theme and the light
// theme inverts them wholesale, rather than re-theming the palette. See
// .adr/0002-invert-the-light-terminal-mirror.md — in short, three of the four harnesses emit
// overwhelmingly truecolor (opencode 100%, pi 89%, claude 79%), and truecolor names an absolute
// colour no palette can re-theme. Rendering it unchanged on white leaves most of an agent's output
// under 2:1.
//
// TWO surfaces need this now — the pane mirror's <pre> and the statusline strip above the composer —
// which is why it lives here instead of being spelled twice and drifting, the silent-failure class
// the ADR is about. The interactive blocks (prompt/wizard/preview/multi-select) are siblings of the
// mirror, not children, so they keep normal app theming and never invert.
//
// The colours are LITERAL dark-space values rather than theme tokens. That is a CONVENTION, not a
// constraint: `color-scheme: dark` on the element DOES flip an inherited light-dark() token
// (resolution is element-scoped, per spec), and these literals are byte-exact matches for
// --background / --foreground / --muted-foreground's dark halves, so either spelling renders the
// same pixels. Literals win because they sit beside the truecolor an agent emits — which nothing can
// re-theme — and say at the point of use that the value is deliberately theme-independent. What
// matters is that a mirror surface never mixes the two (ADR 0002, rule 2).
//
// `color-scheme: dark` still earns its place for native UI inside these surfaces (the x-overflow
// scrollbar, selection), which the filter then maps to light along with everything else.
//
// NEVER add a `dark:` variant inside one: it tracks the ROOT theme, which is backwards in an element
// that is dark under every theme and inverts in light.
import type { CSSProperties } from "react";

import type { AnsiSegment } from "@/lib/ansi";

export const MIRROR_SPACE = "[color-scheme:dark] bg-[#0a0a0a] text-[#fafafa]";
export const MIRROR_INVERT = "[filter:invert(1)_hue-rotate(180deg)] dark:[filter:none]";

/** A segment's inline style. `muted` marks decorative TUI chrome rather than an ANSI colour: drop
 *  the ANSI dim opacity so box-drawing and rule glyphs stay visible (var(--border) + dim was nearly
 *  invisible on mobile) and resolve it to #a1a1a1 — --muted-foreground's dark half, written literally
 *  to match MIRROR_SPACE, since everything on these surfaces is dark-space. */
export function styleFor(s: AnsiSegment): CSSProperties {
  return s.muted ? { ...s.style, color: "#a1a1a1", fontWeight: 400, opacity: 1 } : s.style;
}
