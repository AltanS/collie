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

/** Agents whose panes render natively — no light-theme inversion (.adr/0046). Muse's mid-tone
 *  palette reads raw on either ground, while inversion drops its body text to ~2:1 on white.
 *  This is the "one bit" ADR 0002 reserves for per-harness knowledge: authored-for-dark/light is
 *  not carried, only whether this pane inverts. Gated on the exact agent string, like the
 *  registry — and deliberately NOT the registry, which would also flip the reply path. */
export function rendersNativeMirror(agent?: string): boolean {
  return agent === "muse";
}

/** The native mirror's ground: the page colour in light (no slab — ADR 0002 rejected a dark one
 *  for the same reason), MIRROR_SPACE's halves in dark. Literals matching --background /
 *  --foreground's halves, one spelling per the convention above (#f5f5f5 is oklch(0.97), #0a0a0a
 *  is oklch(0.145); use-theme.ts re-measures if those move).
 *
 *  The `dark:` variants here are CORRECT, which deserves a sentence because the NEVER rule above
 *  forbids them inside inverted mirrors: this surface is not inverted, so it follows the root
 *  theme like any other element instead of backwards. `color-scheme` is inherited (light dark),
 *  so native UI inside (scrollbar, selection) follows too. */
export const MUSE_MIRROR =
  "terminal-muse bg-[#f5f5f5] text-[#0a0a0a] dark:bg-[#0a0a0a] dark:text-[#fafafa]";

/** A segment's inline style. `muted` marks decorative TUI chrome rather than an ANSI colour: drop
 *  the ANSI dim opacity so box-drawing and rule glyphs stay visible (var(--border) + dim was nearly
 *  invisible on mobile) and resolve it to #a1a1a1 — --muted-foreground's dark half, written literally
 *  to match MIRROR_SPACE, since everything on these surfaces is dark-space. */
export function styleFor(s: AnsiSegment): CSSProperties {
  return s.muted ? { ...s.style, color: "#a1a1a1", fontWeight: 400, opacity: 1 } : s.style;
}

/** Honor the adapter-owned hints: `mobileTransparentBg` keeps its fill in a custom property
 *  so phone CSS can drop it, and `lightDarkFg` keeps its colour behind a var() the light theme
 *  overrides (.adr/0046). */
export function segmentStyle(s: AnsiSegment): CSSProperties {
  let style = styleFor(s);
  if (s.mobileTransparentBg) {
    const { backgroundColor, ...rest } = style;
    // SAFETY: a CSS custom property is a valid style key at runtime; React passes any `--*` key
    // straight to the CSSOM. CSSProperties has no index signature for it, so the cast is the only
    // spelling. The value is the backgroundColor just removed from the same object.
    style = { ...rest, "--terminal-seg-bg": backgroundColor } as CSSProperties;
  }
  // The decorator marks explicit-fg spans only, so s.fg IS the emitted colour here — branch
  // on that domain value rather than re-inspecting the style object. It stays the var()
  // FALLBACK, so dark rendering is untouched: only the light theme defines
  // --terminal-light-dark-fg (index.css, scoped to pre.terminal-muse). A stylesheet rule cannot
  // override an inline `color`, which is why the indirection exists at all — the same reason the
  // fill above lives in a custom property.
  if (s.lightDarkFg && s.fg !== undefined) {
    return { ...style, color: `var(--terminal-light-dark-fg, ${s.fg})` };
  }
  return style;
}
