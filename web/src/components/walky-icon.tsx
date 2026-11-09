import { createLucideIcon, type LucideProps } from "lucide-react";

/**
 * Walky talky's own mark: a small handheld radio with two signal arcs off its upper-right corner.
 * It is drawn on lucide's grid (24 box, 2px round stroke, `currentColor`) and built with lucide's own
 * `createLucideIcon`, so it behaves as a lucide icon: the 24px default size that a `size-*` class
 * overrides, `aria-hidden` unless a label is passed, and the `className` merge. It also wears the
 * class `icon`, so the theme's icon weight (`svg.icon` in index.css) reaches it as it reaches the rest.
 * It is not a key in `icons/keys.ts`: the radio is the walky talky's own mark and stays the same under
 * every glyph set. The one hand-made icon beside it, `agent-icon.tsx`, is a brand tile and deliberately
 * carries no `icon` class; this one is a glyph and must.
 */
const WalkyGlyph = createLucideIcon("walky-talky", [
  ["rect", { x: "3", y: "10", width: "8", height: "12", rx: "2", key: "body" }],
  ["path", { d: "M5 10V6", key: "antenna" }],
  ["path", { d: "M6 16h2", key: "slot" }],
  ["path", { d: "M13 7a4 4 0 0 1 4 4", key: "arc-near" }],
  ["path", { d: "M13 3a8 8 0 0 1 8 8", key: "arc-far" }],
]);

/**
 * The same radio, struck through: a session that turned its walky talky off (M89). The pane menu's
 * Messages row and the switch in the Messages sheet wear it while the session is off.
 */
const WalkyOffGlyph = createLucideIcon("walky-talky-off", [
  ["rect", { x: "3", y: "10", width: "8", height: "12", rx: "2", key: "body" }],
  ["path", { d: "M5 10V6", key: "antenna" }],
  ["path", { d: "M6 16h2", key: "slot" }],
  ["path", { d: "M13 7a4 4 0 0 1 4 4", key: "arc-near" }],
  ["path", { d: "M13 3a8 8 0 0 1 8 8", key: "arc-far" }],
  ["path", { d: "M2 2l20 20", key: "strike" }],
]);

/** The radio, with the `icon` class the stroke rule hangs on. */
export function WalkyIcon({ className, ...props }: LucideProps) {
  return <WalkyGlyph {...props} className={className === undefined ? "icon" : `icon ${className}`} />;
}

/** The struck-through radio, with the `icon` class. */
export function WalkyOffIcon({ className, ...props }: LucideProps) {
  return <WalkyOffGlyph {...props} className={className === undefined ? "icon" : `icon ${className}`} />;
}
