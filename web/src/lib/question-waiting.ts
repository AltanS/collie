// Which running question card the dialog dock below the stream is asking about.
//
// A question tool call (opencode `question`, Claude Code AskUserQuestion) shows in Chat as a card
// with no result until somebody answers it. The answer itself is given in the dock, which draws the
// dialog the pane's screen shows as tappable options, in Chat mode as much as in the terminal. The
// card should say so, and that needs a join between two things that never name each other.
//
// THE SCREEN NEVER PRINTS THE CALL ID. A session log says "question q1 is open"; the pane says "a
// question dialog is open". Nothing on either side carries the other's key, so a join by identity
// does not exist. The only honest join is by count: exactly one waiting question in the session and
// exactly one question dialog on the screen. Then they are the same thing, because there is nothing
// else either could be.
//
// IT FAILS CLOSED. Two waiting questions, or two question dialogs, or none of one side, bind
// nothing: the card then says only what it always said, and no card ever claims a dialog that might
// be another's. Of the single-choice `prompt-select` families only `select` is a question. The
// others, `permission` (allow this tool call), `trust` (trust this folder) and `plan` (approve a
// plan), ask about something else, and a "question" note on them would be a lie. A menu, an unread
// dialog, a preview-select and an autocomplete are not question-shaped and do not bind.
//
// Pure: no React, no DOM. `t()` is a synchronous lookup, so the note is in whatever language the
// dictionary holds when this runs, and a view that memoises the result keys it on the locale
// revision.

import type { Block } from "./blocks";
import type { CardWaiting } from "@/components/chat-cards";
import { itemsOf } from "./chat-items";
import { t } from "./i18n";
import type { ChatEntry } from "./types";

/** Whether a block is a lifted dialog of a kind a question tool call is answered in. */
function isQuestionDialog(block: Block): boolean {
  switch (block.kind) {
    case "prompt-select":
      return block.prompt.family === "select";
    case "wizard":
    case "multi-select":
      return true;
    default:
      return false;
  }
}

/**
 * The note to draw on the one running question card, keyed by that card's item id, or `{}` when the
 * join is not exact. An abandoned turn is not part of the conversation and is not read, exactly as
 * the stream does not draw it.
 */
export function waitingQuestionNote(entries: readonly ChatEntry[], blocks: readonly Block[]) {
  const running: string[] = [];
  for (const entry of entries) {
    if (entry.abandoned === true) continue;
    // The ids and the status come from the same function the stream draws its cards with, so the
    // key here is the key the card looks itself up by.
    for (const item of itemsOf(entry)) {
      if (item.kind === "tool" && item.tool.kind === "question" && item.status === "running") running.push(item.id);
    }
  }
  const [only] = running;
  if (only === undefined || running.length !== 1) return {};
  if (blocks.filter(isQuestionDialog).length !== 1) return {};
  const note = { id: only, note: t("chat.question.answerBelow") } satisfies CardWaiting;
  return { [only]: note };
}
