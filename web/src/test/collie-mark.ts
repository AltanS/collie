// Reading a brand mark's state out of the DOM, in one place.
//
// Every mark implements the mark contract (components/mark-contract.ts), so what a test may ask is
// what the contract makes public: the root's `data-mark` and `data-state`, and the `--mark-*`
// variables. The mark's own classes and keyframes are private and are never asked for here. Every
// suite that asks (CollieHome, the header, the boot screen) would otherwise spell the same query.

import { MARK_STATE_LOOK, isMarkState, type MarkState } from "@/components/mark-contract";

/** The one brand mark inside `root`, or `null`. Identified by the contract's `data-mark` on its root. */
export function collieMark(root: ParentNode): SVGSVGElement | null {
  return root.querySelector<SVGSVGElement>("svg[data-mark]");
}

/** The state the mark says it is in (`data-state`), or `null` if no mark is mounted. */
export function markState(root: ParentNode): MarkState | null {
  const state = collieMark(root)?.getAttribute("data-state");
  return state !== undefined && state !== null && isMarkState(state) ? state : null;
}

/** Whether the mark wears its live look: loading, applying or reconnected. (Applying turns at the calm
 *  pace; the other two at the live pace.) */
export function markIsLive(root: ParentNode): boolean {
  const state = markState(root);
  return state !== null && MARK_STATE_LOOK[state].look === "live";
}

/**
 * The knockout colour the mark was told to paint with, or `""` if no mark is mounted. The paper is
 * the one value the contract hands to a mark's private property (`--<prefix>-paper`) rather than to a
 * `--mark-*` one, so this finds it by that naming and skips the public `--mark-paper`.
 */
export function markPaper(root: ParentNode): string {
  const style = collieMark(root)?.style;
  if (style === undefined) return "";
  for (const name of Array.from({ length: style.length }, (_, i) => style.item(i))) {
    if (/^--c[a-z]-paper$/.test(name)) return style.getPropertyValue(name);
  }
  return "";
}
