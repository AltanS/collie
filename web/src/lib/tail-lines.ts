// A TAIL WINDOW of a bound region: how many of the read's last non-blank rows the region may end in.
//
// WHY IT EXISTS. The bridge binds a write to the rows the phone saw (`expected_prompt`) and accepts a
// match only when it ENDS inside the read's last few non-blank rows (`DEFAULT_PROMPT_TAIL_LINES` in
// bridge/prompt-binding.ts), so a stale copy of a dialog higher up the screen cannot take a tap meant
// for the live one. Six rows covers every harness whose dialog sits at the bottom of the screen. It
// does not cover a harness that paints its OWN live chrome under the dialog: Hermes's classic CLI
// keeps a spinner, a countdown hint, a status bar, the input row and its rules below every panel, six
// or seven non-blank rows that tick every second. Binding those rows would refuse every tap (the
// "Menu changed" loop of issue #354), and the panel alone ends one row too high for the default.
//
// A grammar that has recognised every row below its region as that harness's own chrome names the
// window it needs on the model (`PromptModel.bindTail`), the phone sends it as
// `expected_tail_lines`, and the bridge widens its window to that many rows, never past
// {@link MAX_TAIL_LINES}. The bridge holds no grammar: it counts rows to a number the phone sent.
// Without the field nothing changes, and an older bridge that ignores it keeps six rows and refuses
// the tap, which fails closed.
//
// Pure, no imports. The bridge imports it by relative path, as it does `column-range.ts`.

/** The window the bridge uses when the phone names none. The same number as
 *  `DEFAULT_PROMPT_TAIL_LINES` in bridge/prompt-binding.ts, which a bridge test pins. */
export const DEFAULT_TAIL_LINES = 6;

/** The widest window the bridge accepts (`expected_tail_lines`). A bigger number is a malformed body:
 *  past it, a replacement dialog no longer pushes a stale match out of the window. */
export const MAX_TAIL_LINES = 12;

/**
 * The window a grammar declares for a region with `rowsBelow` non-blank rows of its harness's own
 * chrome under it. Undefined when the default already covers it, so nothing is declared that is not
 * needed. Past the default, one row of headroom beyond the rows it saw, so a status row that wraps
 * between the phone's read and the bridge's does not refuse the tap. Null when even the widest window
 * does not cover it: the grammar must not lift.
 */
export function tailLinesFor(rowsBelow: number): number | undefined | null {
  // A window of W rows accepts a region with at most W - 1 rows below it.
  if (rowsBelow + 1 <= DEFAULT_TAIL_LINES) return undefined;
  const tailWindow = rowsBelow + 2;
  return tailWindow <= MAX_TAIL_LINES ? tailWindow : null;
}
