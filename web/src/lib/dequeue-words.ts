// What the phone says after Edit on the chat's waiting card (ADR 0122, the 2026-11-22 addendum). The take-back's
// receipt (lib/surface/dequeue.ts) becomes one move: the texts go into the composer (`taken`), nothing is said
// because the "Back in the box" card is the answer (`in_box`), or one status line. Every line is a sentence the
// app already says somewhere for the same fact; this round adds no sentence of its own.
//
// Pure: no DOM, no harness name.

import type { MessageKey } from "./i18n";
import type { DequeueReason, DequeueReceipt } from "./surface/dequeue";

/** The status line of each refusal: the sentence the matching existing refusal says. */
const REFUSED = {
  dialog_open: "belt.stop.receipt.refused.dialogOpen",
  draft_present: "composer.surface.draft",
  turn_idle: "belt.stop.receipt.refused.turnIdle",
  // The journal lists nothing waiting any more: it went out.
  queue_empty: "composer.held.wentOut",
  // A picture, a paste or a long text cannot come back whole: the card's old way back is the answer.
  not_whole: "chat.stream.queuedTakeBack",
  busy: "composer.protocol.busy",
  no_profile: "belt.stop.receipt.refused.noProfile",
  unreadable: "belt.stop.receipt.refused.unreadable",
  no_journal: "belt.stop.receipt.refused.unreadable",
  pane_gone: "belt.stop.receipt.refused.paneGone",
  press_failed: "composer.surface.unreachable",
  no_key: "composer.surface.unreachable",
  unsupported_build: "composer.surface.unreachable",
} as const satisfies Record<DequeueReason, MessageKey>;

/** What a take-back's receipt asks of the pane view. */
export type DequeueMove =
  /** Put `text` into the composer; `note` is a line to say beside it (a rest may stand in the agent's box). */
  | { readonly kind: "take"; readonly text: string; readonly note?: MessageKey }
  /** Nothing to say: the agent's box holds the text, and its "Back in the box" card carries on. */
  | { readonly kind: "quiet" }
  /** One status line, a caution. */
  | { readonly kind: "say"; readonly key: MessageKey };

/** The move for one receipt. `taken` joins the texts in queue order with one newline. */
export function dequeueMove(receipt: DequeueReceipt): DequeueMove {
  switch (receipt.outcome) {
    case "taken": {
      const text = (receipt.texts ?? []).join("\n");
      // The clear started and was not proved: the words are here, and the agent's box may still hold a rest.
      return receipt.leftover === true ? { kind: "take", text, note: "composer.surface.draft" } : { kind: "take", text };
    }
    case "in_box":
      return { kind: "quiet" };
    case "too_late":
      return { kind: "say", key: "composer.held.wentOut" };
    case "unknown":
      return { kind: "say", key: "composer.held.unknown" };
    case "refused":
      return { kind: "say", key: REFUSED[receipt.reason ?? "unreadable"] };
  }
}

/** The composer text after a take-back: the taken text first, then one newline, then the draft. Nothing is dropped. */
export function mergedDraft(taken: string, draft: string): string {
  return draft.trim() === "" ? taken : `${taken}\n${draft}`;
}
