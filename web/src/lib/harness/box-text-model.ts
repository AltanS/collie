// The BOX TEXT MODEL — the harness-NEUTRAL payload of a `box-text` Block.
//
// A "box-text" is a titled box an agent draws over its live input box to print text the operator has
// to read, and sometimes follow: Claude Code's Authentication box while `awsAuthRefresh` runs. It is
// not a dialog. The input box is live under it, nothing on that screen owns the keyboard, and the box
// disappears on its own when the command ends. That is why this model carries no keys, no signature
// and no comparators, and why `box-text` has no row in harness/dialog-contract.ts.
//
// Types only. This module imports nothing, so `lib/blocks.ts` can re-export it without a cycle.

/** One run of a box's row: plain text, or an http(s) address the row holds, with the href to open. */
export type BoxTextRun = { kind: "plain"; text: string } | { kind: "link"; text: string; href: string };

/** A recognised titled box: its printed title, whether it holds text yet, and its content rows. */
export interface BoxTextModel {
  /** The box's title row as printed. */
  title: string;
  /** `waiting` while the box holds its title alone (blank rows under it count as alone), `filled` once the command printed text under it. */
  phase: "waiting" | "filled";
  /** The rows under the title, blank rows included, in the box's order, border and padding removed; empty while `waiting`. */
  text: BoxTextRun[][];
}
