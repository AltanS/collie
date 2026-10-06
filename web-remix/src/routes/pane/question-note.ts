// "Answer it below": the note a running question tool carries while its dialog is docked as a card.
// Port of web/src/lib/question-waiting.ts `waitingQuestionNote`. Ported, not imported: that module
// takes its slot type from a React component file, which would pull React JSX into this typecheck.
// The join is exact or nothing: ONE running question tool in the stream and ONE question dialog on
// the screen, else no note at all.
import type { Block } from "@web/lib/blocks";
import { itemsOf } from "@web/lib/chat-items";
import { t } from "@web/lib/i18n";
import type { ChatEntry } from "@web/lib/types";

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

/** Item id to its "answer it below" note; empty when the join is not exact. */
export interface QuestionNotes {
  readonly [itemId: string]: string;
}

export function questionNotes(entries: readonly ChatEntry[], blocks: readonly Block[]): QuestionNotes {
  const running: string[] = [];
  for (const entry of entries) {
    if (entry.abandoned === true) continue;
    for (const item of itemsOf(entry)) {
      if (item.kind === "tool" && item.tool.kind === "question" && item.status === "running") running.push(item.id);
    }
  }
  const [only] = running;
  if (only === undefined || running.length !== 1) return {};
  if (blocks.filter(isQuestionDialog).length !== 1) return {};
  return { [only]: t("chat.question.answerBelow") };
}
