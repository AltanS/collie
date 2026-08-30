/**
 * The short identity that tells two panes in ONE tab apart.
 *
 * A pane id is `<session>:<pane>` — `w1:p3`. Everything before the last `:` is the tab's own
 * context, and every pane the reader is choosing between shares it: the surfaces that render this
 * have already put the space and the tab on screen above. So the trailing segment is the entire
 * discriminator, and printing more of the id would spend width re-stating what the screen just
 * said (`lib/pane-name.ts` makes the same argument about the project prefix in a herd row).
 *
 * It lives in its own module rather than at a call site because there are exactly two call sites,
 * they sit one above the other on the SAME screen, and they must agree:
 *
 * - `pane-strip.tsx` prints it on each pill, after the pane's name.
 * - `agent-chat.tsx` appends it to the header's line 1 when that line fell back to naming the TAB
 *   (`space › tab`) and the tab holds more than one pane — i.e. exactly when the pill row below is
 *   on screen, so the two are read together.
 *
 * Written out twice, the header could disagree with the pill it is pointing at, and the reader's
 * only way to notice would be to distrust both. This is a one-line rule; the whole reason it is a
 * module is that the copy is the bug.
 *
 * Total by construction — `slice(lastIndexOf + 1)` returns the whole string when there is no `:`,
 * so a malformed id degrades to showing itself rather than to `undefined` in the DOM. It is not
 * validated beyond that: the id comes from the bridge's snapshot, not from a user, and a shape
 * this app never produces is not worth a second branch on a label.
 */
export function paneTag(paneId: string): string {
  return paneId.slice(paneId.lastIndexOf(":") + 1);
}
