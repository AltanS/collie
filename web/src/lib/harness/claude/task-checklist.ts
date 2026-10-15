// The TASK CHECKLIST Claude Code 2.1.299 draws under a dialog.
//
// While a session has tasks, 2.1.299 draws their checklist at the very bottom of the screen, UNDER
// the key-hint footer of an AskUserQuestion dialog (a single question, a wizard step):
//
//   Enter to select · ↑/↓ to navigate · Esc to cancel
//
//     8 tasks (2 done, 1 in progress, 5 open)
//     ◼ Juliet step
//     ◻ Kilo step
//      … +1 pending, 2 completed
//
// Every grammar here anchors on the LAST non-blank row being its footer, so the list made the whole
// dialog fall to the unread-dialog card, and a list long enough pushed the footer out of the rows
// `modalOnScreen` reads, so the screen showed nothing at all.
//
// The repair is made ONCE, in front of every grammar, by the Claude adapter's entry points
// (`claudeBuildBlocks`, `composerReady`, `modalOnScreen`), before the closing rule a named session
// draws (closing-rule.ts), because the list sits below that rule. The phone's render, the race
// guard's re-derivation and the unread-dialog probes therefore all read the same rows. No grammar
// learns about the list.
//
// FAIL CLOSED. The rows from the list's header down are dropped only when all of these hold:
//   1. the screen ENDS with a checklist whose counts agree with its header, and something sits above
//      it (`trailingTaskChecklistStart`, lib/task-checklist.ts, which spells out every condition);
//   2. no input box is on the screen, so the idle composer, under which the list is not drawn, is
//      never touched.
// Anything else comes back as the SAME array, untouched.
//
// The bridge applies the same recogniser before its binding check's tail window
// (bridge/prompt-binding.ts), so a tap on a dialog with the list under it still binds.

import { lineText, type StyledLine } from "../../blocks";
import { trailingTaskChecklistStart } from "../../task-checklist";
import { hasInputBox } from "./chrome";

/**
 * `lines` without the task checklist 2.1.299 draws under a dialog, or the very same array when the
 * screen does not end that way. Pure; the caller owns pane access.
 */
export function dropTaskChecklist(lines: StyledLine[]): StyledLine[] {
  const header = trailingTaskChecklistStart(lines.map(lineText));
  if (header === null || hasInputBox(lines)) return lines;
  return lines.slice(0, header);
}
