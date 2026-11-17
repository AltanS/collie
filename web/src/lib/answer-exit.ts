// THE EXIT OF AN ANSWER THAT CANNOT GO (M102 spec 10, ADR 0142 rules 2 and 3).
//
// A tap on an ask card (the hook hold card, a screen's question or permission card, a picker) that is
// refused, cannot be planned, or gets no word in time used to end in a status line, with the same card
// left on screen and no way on. It now opens ONE exit: a line that says what happened, the live screen,
// and the person's own Keys pad. The look is spec 03's card (`UnreadDialogBlock`); this module holds
// only the pure parts: which ending is a dead end, the line it says, and the key the exit is bound to.
//
// Nothing here answers. The exit opens; the person presses keys. A key from the pad is the person's own
// key press on the rows they see, and it carries no rows guard: the bridge sends it as it is, also on a
// screen that moved since (`api.sendKeys`, no expected rows). The live screen beside the pad, and the
// second tap Enter asks, are what keep it to the screen the person sees.
//
// THE KEY. The exit belongs to ONE dialog. It is keyed on the dialog's identity, never on a screen
// revision or an ask hash: a frameless dialog whose region holds a ticking row changes both on every
// tick, and that is exactly the dialog whose only way out is this exit. The identity is the dialog's
// own words (question, caption, subject rows, option labels), by block kind and never by harness. The
// hold card's exit keys on the hold's ask id, which the bridge keeps for the request's life.
//
// Pure: no DOM, no network, no harness name.

import type { Block } from "./blocks";
import type { AskTapResult } from "./dialog-ask";
import { dialogModelOf, type DialogKind, type DialogModels } from "./harness/dialog-contract";
import type { MessageKey } from "./i18n";
import type { Ask } from "./surface/surface";

/** Why the exit opened: the dead ends of an answer, and a dialog the phone has no card for. */
export type AnswerExitWhy = "no_plan" | "refused" | "unknown" | "error" | "changed" | "unseen";

/** The one line each exit says. */
export const EXIT_SENTENCE = {
  no_plan: "answerExit.noPlan",
  refused: "answerExit.refused",
  unknown: "answerExit.unknown",
  error: "answerExit.error",
  changed: "answerExit.changed",
  unseen: "answerExit.unseen",
} as const satisfies Record<AnswerExitWhy, MessageKey>;

/**
 * The exit an ask answer's ending opens, or null when the ending is settled or shows its own next card.
 * `sent`, `gone` and `desk` are settled; `changed`, `mismatch` and `moved` hand back the dialog now, and the card
 * re-renders on it (the lead's decision 4).
 */
export function exitOfAsk(result: AskTapResult): AnswerExitWhy | null {
  switch (result.status) {
    case "sent":
    case "changed":
    case "mismatch":
    case "moved":
    case "gone":
    case "desk":
      return null;
    case "refused":
      return result.reason === "no_plan" ? "no_plan" : "refused";
    case "unknown":
      return "unknown";
    case "error":
      return "error";
  }
}

/** The exit a guarded key tap's ending opens (lib/dialog-guard.ts), or null when it was sent. */
export function exitOfGuard(status: "sent" | "changed" | "error"): AnswerExitWhy | null {
  switch (status) {
    case "sent":
      return null;
    case "changed":
      return "changed";
    case "error":
      return "error";
  }
}

const SEP = "\u0000";

/**
 * The identity of one dialog card, for the exit's key: the kind and the dialog's own words. Null for
 * the unread card, which is an exit itself. Two derivations of the same dialog give the same key while
 * a row outside its words ticks; another dialog (another question, subject or set of options) does not.
 */
export function dialogExitKey<K extends DialogKind>(kind: K, model: DialogModels[K]): string | null {
  const parts = wordsOf(kind, model);
  return parts === null ? null : [kind, ...parts].join(SEP);
}

function wordsOf(kind: DialogKind, model: DialogModels[DialogKind]): string[] | null {
  // `in` narrows the union by a field each kind alone carries, so no assertion is needed.
  switch (kind) {
    case "prompt-select":
      if (!("family" in model)) return null;
      return [
        model.question,
        model.caption ?? "",
        ...(model.subject ?? []).map((row) => row.segments.map((s) => s.text).join("")),
        ...model.options.map((o) => o.label),
      ];
    case "menu":
      if (!("actions" in model)) return null;
      return [model.title, ...model.actions.map((a) => a.label)];
    case "preview-select":
      if (!("preview" in model)) return null;
      return [model.question, ...model.options.map((o) => o.label)];
    case "wizard":
    case "multi-select":
      if (!("phase" in model)) return null;
      if ("question" in model && "options" in model) return [model.phase, model.question, ...model.options.map((o) => o.label)];
      return [model.phase];
    case "unread-dialog":
      return null;
  }
}

/** The key of the dialog card the dock draws for these blocks, in the dock's own order, or null. */
export function cardExitKey(blocks: readonly Block[]): string | null {
  const order: readonly DialogKind[] = ["prompt-select", "wizard", "preview-select", "multi-select", "menu"];
  for (const kind of order) {
    for (const block of blocks) {
      const model = dialogModelOf(block, kind);
      if (model !== null) return dialogExitKey(kind, model);
    }
  }
  return null;
}

/** The key of the hold card's exit: the hold's ask id. */
export function holdExitKey(askId: string): string {
  return `hold${SEP}${askId}`;
}

/**
 * The key of the exit for a dialog the Surface carries and the phone draws no card for: the ask's kind
 * and option labels. Its id and hash move with the screen; its words do not.
 */
export function askExitKey(ask: Ask): string {
  return ["ask", ask.kind, ...ask.options.map((o) => o.label)].join(SEP);
}
