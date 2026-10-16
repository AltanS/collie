// The free-text reply: one Send Protocol request (M56 spec 06).
//
// This file used to hold the phone's own race guard for issue #34: a pre-flight read of the pane, a
// type-then-verify loop that polled the screen until the text showed in the input box, a sweep of a
// stranded draft and a settle wait before Enter. All of it lived on the phone because the bridge's old
// reply route typed, waited a fixed 350 ms and pressed Enter blind. The bridge now runs the Send
// Protocol on every text (bridge/surface/protocol.ts): it reads the screen fresh at S0, refuses a
// dialog, a draft or a screen it cannot read before any key, probes where it must, checks the box
// before Enter and answers with a receipt. So the phone reads nothing before a send and sends no key
// of its own. What remains here is the request id, the call and the outcome mapping.
//
// The per-harness draft and status readers stay, for display only: the stranded-draft preview, the
// echo suppression (lib/draft-match.ts) and the status line.

import { postSend } from "./api";
import { describeThrownError } from "./api-error-message";
import { requestIdFor, type IntentId } from "./durable-control";
import { t } from "./i18n";
import { isLive } from "./liveness";
import type { Scope } from "./scope";
import { isCommand, readSend, type SendReading, type SendReply } from "./send-protocol";
import type { SendMode, SendRequestBody } from "./surface/send";
import { mintRequestId } from "./worktree-name";

export interface ReplyArgs {
  readonly paneId: string;
  readonly text: string;
  /** Which machine and which named session the pane lives in. */
  readonly scope?: Scope | undefined;
  /** `send`, or `command` for a reserved lead, when absent. An offer names its own mode. */
  readonly mode?: SendMode;
  /** The rows the person saw, for a commit after an `unconfirmed` refusal. */
  readonly rowsHash?: string | null;
  /** The intent the last tap left without an answer: the same intent keeps its request id. */
  readonly held: IntentId | null;
  /** Test seam for the request id. */
  readonly mint?: () => string;
}

export type ReplyOutcome =
  /** The bridge answered. `reading.clear` is true only on `sent` or `effective`. */
  | { readonly status: "answered"; readonly reply: SendReply; readonly reading: SendReading }
  /**
   * No answer arrived (a dropped link, a timeout, a body the phone cannot read). The intent comes
   * back: the next tap on the same text asks for the same request id, so a lost answer never sends
   * twice.
   */
  | { readonly status: "noAnswer"; readonly error: string; readonly intent: IntentId }
  /**
   * Nothing was asked: the bridge has not answered a read for this pane lately (M46 spec 11), so the
   * screen the person acted on may be old. No queue and no retry: a person sends again once the pane
   * reads live.
   */
  | { readonly status: "refused"; readonly reason: "offline"; readonly error: string };

/** The mode of a text with no offer behind it: a reserved lead is a command, everything else a send. */
export function modeFor(text: string): SendMode {
  return isCommand(text) ? "command" : "send";
}

/** One Send Protocol request for a text, and what its answer means. Never throws. */
export async function sendText(args: ReplyArgs): Promise<ReplyOutcome> {
  // The backstop behind every disabled Send: a UI that slipped through (a stale render, a handler held
  // across an outage) still cannot reach the bridge from a pane it has not just read.
  if (!isLive(args.paneId, args.scope)) {
    return { status: "refused", reason: "offline", error: t("composer.send.reconnect") };
  }
  const mode = args.mode ?? modeFor(args.text);
  const rowsHash = args.rowsHash ?? null;
  const intent = requestIdFor(args.held, `${mode}\u0000${rowsHash ?? ""}\u0000${args.text}`, args.mint ?? mintRequestId);
  const body: SendRequestBody = { id: intent.requestId, pane: args.paneId, text: args.text, mode };
  try {
    const reply = await postSend(rowsHash === null ? body : { ...body, rowsHash }, args.scope);
    return { status: "answered", reply, reading: readSend(reply) };
  } catch (e) {
    return { status: "noAnswer", error: describeThrownError(e), intent };
  }
}
