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

import { postAskAnswer } from "./api";
import { describeThrownError } from "./api-error-message";
import { askOptionFor, type CardTap } from "./ask-reply";
import { t } from "./i18n";
import { isLive } from "./liveness";
import type { Scope } from "./scope";
import type { AskReason } from "./surface/ask";
import type { Ask } from "./surface/surface";

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
}

/** One Answer for a tap on a dialog card. Never throws. */
export async function answerAsk(args: AskTapArgs): Promise<AskTapResult> {
  if (!isLive(args.paneId, args.scope)) return { status: "error", error: t("composer.send.reconnect") };
  const optionId = askOptionFor(args.ask, args.tap);
  if (optionId === null) return { status: "changed", ask: null, why: "card" };
  try {
    const body = { pane: args.paneId, hash: args.ask.hash, optionId, origin: "person_tap" } as const;
    const reply = await postAskAnswer(args.ask.id, args.via === undefined ? body : { ...body, via: args.via }, args.scope);
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
