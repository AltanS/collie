// A tap on a dialog card as one Ask answer (M56 spec 08). The card keeps its look; only the answer
// path changes. Where the bridge's Surface carries an ask for the pane, a tap on a prompt option or
// a menu's footer action posts one Answer (`POST /api/ask/<id>`) with the ask's hash and the option
// id, and the bridge does the rest: it reads the screen again, compares the hash before the first
// key, walks, reads the pointer back and commits through the key gate. The phone sends no key of its
// own on this path.
//
// What comes back is one of a closed set the handlers render: sent; changed (the dialog on the
// screen is another one, and the reply carries its ask under a new id, which the next tap uses);
// gone (the dialog left the screen); mismatch (the highlight did not reach the choice, nothing was
// confirmed); unknown; refused for another reason; or an error with no answer.
//
// THE CARD AND THE ASK ARE TWO READS. The card is drawn from the mirror text (the pane poll); the ask
// rides the Surface (the snapshot, filled by the bridge's own poll). After an arrow the mirror shows
// the moved highlight first, and the Surface can lag by seconds. A menu's footer key commits the
// highlighted row, so its tap carries `seen`, the hash of the dialog lifted from the very blocks the
// card was drawn from, and the answer goes out only under an ask with that hash: the held one, or
// the ask of one fresh read of the screen. Never under another (the /model picker, 2026-10-17).

import type { Block } from "./blocks";
import { postAskAnswer, postSend } from "./api";
import { describeThrownError } from "./api-error-message";
import { askOptionFor, type CardTap } from "./ask-reply";
import { dialogModelOf, type DialogKind, type DialogModels } from "./harness/dialog-contract";
import { t } from "./i18n";
import { isLive } from "./liveness";
import type { Scope } from "./scope";
import type { AskReason } from "./surface/ask";
import { liftDialog } from "./surface/lift";
import { askOf, type Ask } from "./surface/surface";
import { mintRequestId } from "./worktree-name";

export type AskTapResult =
  | { readonly status: "sent" }
  /** The dialog is not the one tapped. `ask` is the bridge's ask for the screen now, or null; `card` means the phone's card and the bridge's ask already disagreed, so nothing was posted. */
  | { readonly status: "changed"; readonly ask: Ask | null; readonly why: AskReason | "card" }
  | { readonly status: "gone" }
  /** A hook-held ask (M56 spec 12): the desk, another hook or another Collie answered first. */
  | { readonly status: "desk"; readonly detail: string | null }
  | { readonly status: "mismatch"; readonly ask: Ask | null }
  | { readonly status: "unknown"; readonly detail: string | null }
  | { readonly status: "refused"; readonly reason: AskReason | null; readonly detail: string | null }
  | { readonly status: "error"; readonly error: string };

export interface AskTapArgs {
  readonly paneId: string;
  readonly scope?: Scope | undefined;
  /** The ask the pane's Surface carries (or the one a refusal handed back). */
  readonly ask: Ask;
  readonly tap: CardTap;
  /** Set by the hold card of a hook-held permission (M56 spec 12), and by nothing else. */
  readonly via?: "hold-card";
  /**
   * The hash of the dialog the tapped card was drawn from (`cardHashOf`). Set, the answer goes out
   * only under an ask with this hash: `ask` when it has it, else the ask of one fresh read of the
   * screen when that one has it, else nothing is posted (`changed`). Null: the card's dialog did not
   * lift, so nothing is posted. Absent: the tap takes `ask` as it is.
   */
  readonly seen?: string | null;
  /** Test seam: the ask of one fresh read of the pane. Defaults to {@link freshAsk}. */
  readonly fresh?: (paneId: string, scope: Scope | undefined) => Promise<Ask | null>;
}

/**
 * The hash an ask for this card would carry: the dialog lifted from the blocks the card dock drew, as
 * the bridge lifts a read (lib/surface/lift.ts). Null when the lifted dialog is not the card's model.
 */
export function cardHashOf(blocks: readonly Block[], model: DialogModels[DialogKind]): string | null {
  const lifted = liftDialog(blocks);
  if (lifted === null) return null;
  return dialogModelOf(lifted.block, lifted.blockKind) === model ? lifted.hash : null;
}

/**
 * The ask of one fresh read of the pane, or null. The read is a Send Protocol `prepare`: the bridge
 * reads the screen, lifts and publishes its dialog in the ask book, and writes nothing.
 */
export async function freshAsk(paneId: string, scope: Scope | undefined): Promise<Ask | null> {
  try {
    const reply = await postSend({ id: mintRequestId(), pane: paneId, text: "", mode: "prepare" }, scope);
    return reply.surface === null ? null : askOf(reply.surface.modal);
  } catch {
    return null;
  }
}

/** One Answer for a tap on a dialog card. Never throws. */
export async function answerAsk(args: AskTapArgs): Promise<AskTapResult> {
  if (!isLive(args.paneId, args.scope)) return { status: "error", error: t("composer.send.reconnect") };
  let ask = args.ask;
  if (args.seen !== undefined && args.seen !== ask.hash) {
    // The card and the held ask name two states of the screen. One fresh read decides: its ask is
    // used only when it is the card's dialog, so nothing commits a row the card did not show.
    const fresh = args.seen === null ? null : await (args.fresh ?? freshAsk)(args.paneId, args.scope);
    if (fresh === null || fresh.hash !== args.seen) return { status: "changed", ask: fresh, why: "card" };
    ask = fresh;
  }
  const optionId = askOptionFor(ask, args.tap);
  if (optionId === null) return { status: "changed", ask: null, why: "card" };
  try {
    const body = { pane: args.paneId, hash: ask.hash, optionId, origin: "person_tap" } as const;
    const reply = await postAskAnswer(ask.id, args.via === undefined ? body : { ...body, via: args.via }, args.scope);
    switch (reply.outcome) {
      case "sent":
        return { status: "sent" };
      case "unknown":
        return { status: "unknown", detail: reply.detail };
      case "refused":
      case null:
        break;
    }
    switch (reply.reason) {
      case "ask_changed":
      case "ask_unknown":
      case "ask_answered":
        return { status: "changed", ask: reply.ask, why: reply.reason };
      case "ask_gone":
        return { status: "gone" };
      case "ask_desk":
        return { status: "desk", detail: reply.detail };
      case "ask_mismatch":
        return { status: "mismatch", ask: reply.ask };
      default:
        return { status: "refused", reason: reply.reason, detail: reply.detail };
    }
  } catch (e) {
    return { status: "error", error: describeThrownError(e) };
  }
}
