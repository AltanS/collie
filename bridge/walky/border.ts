// The space border (M98 spec 03): whether an agent's message may reach a pane of another space. One
// pure function, `borderVerdict`, table tested in border.test.ts. The bridge that owns the target pane
// runs it (deliver.ts `place`, and again before a held message is typed); a lead runs it for a member
// below 1.29.0, which cannot (crew.ts `leadRouteRemote`, README decision 9a).
//
// The rule, in order:
//
//   1. `operator`  the message is the operator's: `kind: "operator"`, which the bridge proved, never the
//                  sender's word (service.ts builds it only for a paired device, and a crew hop signs it and
//                  checks its shape: an operator names no pane). The broadcast rule reads the same field.
//   -  `legacy`    an agent's message that names no space, from a signer below 1.29.0 (README 9b). From a
//                  signer at or above it, the same message is a bad request (README 9c). This check sits
//                  before rules 2 to 4 because 9c holds whatever else the message says: a bridge that
//                  writes the outside flag always writes the space. For every well-formed message the
//                  order gives the spec's table (rule 5 there).
//   2. `in`        the sender's space is the target's: the keys are equal (space.ts `sameSpace`). This
//                  holds before the flag: a message with the outside flag to a pane of the sender's own
//                  space passes as `in`, and its header carries no `outside` word, because the sender
//                  is of the receiver's space (lead's decision, 2026-11-10).
//   3. `outside`   the sender said the message may leave its space (`outside: true`, signed).
//   4. `reply`     the message answers one the TARGET pane sent, and that one went to the sender. Both read
//                  from THIS bridge's log, never from the message (`BorderParent`), so a pane cannot reply
//                  across the border to a message it only knows the id of. A thread goes on both ways:
//                  each reply is in turn a message its target sent to the next replier.
//   6. refused     `outside your space`.

import { parseAddress } from "./address.ts";
import type { Placement } from "./log.ts";
import { sameSpace, type WalkySpace } from "./space.ts";
import type { BorderVerdict, WalkyMessage, WalkySender } from "./types.ts";

/** The one reason a border refusal carries (README decision 10). Printable ASCII, under 120 characters. */
export const OUTSIDE_YOUR_SPACE = "outside your space";

/** An agent's message with no space from a signer at or above 1.29.0 (README decision 9c). */
export const NO_SPACE = "bad request: an agent's message from this version must name its space";

/** A lead's refusal for a member below the release a message needs (CREW_PROTOCOL §21, "An older member"). */
export const OLDER_MEMBER = "older member";

/** How a message passes the border, or the refusal's reason. */
export type BorderAnswer = { readonly via: BorderVerdict } | { readonly refuse: string };

/**
 * The message a reply answers, as THIS bridge's log holds it: the lookup `replyPin` makes (deliver.ts),
 * `log.first(replyTo)` and its `sender`, plus every target the log holds for that id. Every address is
 * in this bridge's spelling (`local/` is this member's id), and `targets` are bare.
 */
export interface BorderParent {
  /** The parent's `from.address`, with its instance token; null for an operator's message. */
  readonly from: string | null;
  /** The pane this bridge took the parent from (the log record's `sender`); null when it came from elsewhere. */
  readonly sender: Placement | null;
  /** Every target this bridge logged the parent under, bare (`<member>/<pane>`, `all`, `<member>/all`, a scope). */
  readonly targets: readonly string[];
  /** The parent's signed `to`. */
  readonly to: string;
}

/** The pane a message is for. */
export interface BorderTarget {
  /** `<member>/<pane>`, bare, in this bridge's spelling. */
  readonly address: string;
  /** The pane's space; null when this bridge does not know it (a pane a lead's sweep does not list): rule 3 never holds then. */
  readonly space: WalkySpace | null;
  /**
   * The pane's place when it is a pane of this bridge: the parent must then have been taken from exactly
   * this pane, the instance too when the log knows it (the check `replyPin` makes). Null when a lead
   * checks a pane on a member below 1.29.0: the lead took nothing from that pane.
   */
  readonly pane: { readonly session: string; readonly paneId: string; readonly instance: string } | null;
  /** The pane's instance token as the lead's list holds it, for a pane with `pane` null; null when unknown. */
  readonly instance: string | null;
}

export interface BorderInput {
  readonly message: Pick<WalkyMessage, "kind" | "outside" | "replyTo"> & { readonly from: Pick<WalkySender, "address" | "space"> };
  /** The message's `from.address` in this bridge's spelling, with its instance token; null for none. */
  readonly sender: string | null;
  readonly target: BorderTarget;
  /** {@link BorderParent} for `message.replyTo`, or null: not a reply, or this bridge's log does not hold it. */
  readonly replyParent: BorderParent | null;
  /**
   * `older` when the signer is known to predate 1.29.0, or the lead that attested the message screened it
   * (deliver.ts `DelivererDeps.signerOlderThanSpace`); `current` otherwise, unknown included.
   */
  readonly signerVersion: "older" | "current";
}

/** Whether a message is a reply the border lets through (rule 4). */
function replyHolds(input: BorderInput): boolean {
  const { replyParent: parent, sender, target } = input;
  if (input.message.replyTo === null || parent === null || parent.from === null || sender === null) return false;
  const from = parseAddress(parent.from);
  const to = parseAddress(target.address);
  const replier = parseAddress(sender);
  if (from?.kind !== "pane" || to?.kind !== "pane" || replier?.kind !== "pane") return false;
  // Sent BY the target pane: the parent's sender is the target's pane id on the target's member ...
  if (from.memberId !== to.memberId || from.paneId !== to.paneId) return false;
  // ... and the same session in it. On this bridge the log took the parent from that very pane, the
  // instance too when it knows it (`replyPin`). A lead checking for an older member compares the tokens
  // the parent and its own list name, when both name one.
  const pane = target.pane;
  if (pane !== null) {
    const took = parent.sender;
    if (took === null || took.session !== pane.session || took.paneId !== pane.paneId) return false;
    if (took.instance !== null && took.instance !== pane.instance) return false;
  } else if (from.instance !== null && target.instance !== null && from.instance !== target.instance) {
    return false;
  }
  // Sent TO the replier: logged under its pane, or addressed to every pane or to the replier's machine.
  const at = `${replier.memberId}/${replier.paneId}`;
  return parent.targets.includes(at) || parent.to === "all" || parent.to === `${replier.memberId}/all`;
}

/** Whether a message may reach a pane, and how it passes: see the rule at the top of this file. */
export function borderVerdict(input: BorderInput): BorderAnswer {
  const { message } = input;
  if (message.kind === "operator" && message.from.address === null) return { via: "operator" };
  const space = message.from.space ?? null;
  if (space === null) return input.signerVersion === "older" ? { via: "legacy" } : { refuse: NO_SPACE };
  if (input.target.space !== null && sameSpace(space, input.target.space)) return { via: "in" };
  if (message.outside === true) return { via: "outside" };
  if (replyHolds(input)) return { via: "reply" };
  return { refuse: OUTSIDE_YOUR_SPACE };
}
