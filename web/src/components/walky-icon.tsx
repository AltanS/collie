import { createLucideIcon } from "lucide-react";

/**
 * Walky talky's own mark: a small handheld radio with two signal arcs off its upper-right corner.
 * It is drawn on lucide's grid (24 box, 2px round stroke, `currentColor`) and built with lucide's own
 * `createLucideIcon`, so it IS a lucide icon to everything else: it carries the `lucide` class (the
 * Settings icon-weight option, `svg.lucide` in index.css, reaches it exactly as it reaches the rest),
 * the 24px default size that a `size-*` class overrides, `aria-hidden` unless a label is passed, and
 * the `className` merge. The one hand-made icon beside it, `agent-icon.tsx`, is a brand tile and
 * deliberately carries no `lucide` class; this one is a glyph and must.
 */
export const WalkyIcon = createLucideIcon("walky-talky", [
  ["rect", { x: "3", y: "10", width: "8", height: "12", rx: "2", key: "body" }],
  ["path", { d: "M5 10V6", key: "antenna" }],
  ["path", { d: "M6 16h2", key: "slot" }],
  ["path", { d: "M13 7a4 4 0 0 1 4 4", key: "arc-near" }],
  ["path", { d: "M13 3a8 8 0 0 1 8 8", key: "arc-far" }],
]);
