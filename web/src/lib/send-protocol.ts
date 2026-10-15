// The composer's side of the Send Protocol (M56 spec 05): read the bridge's answer to `POST /api/send`
// and say what it means for the draft, the request id and the offer strip. Pure, so the composer only
// renders what this decides.
//
// The phone mints a request id at tap time and keeps it across retries of the same intent (the same
// mode, the same text, the same rows hash): a retry after a lost answer then gets the stored receipt
// and never a second send. Every offer the answer makes is a new intent, so it gets a new id.

import { asJsonBoolean, asJsonObject, asJsonString, type JsonValue } from "./json";
import { SEND_OUTCOMES, SEND_REASONS, type SendMode, type SendOffer, type SendOutcome, type SendReason } from "./surface/send";

/** What the composer needs of an answer. Everything else in it (the Surface, the receipt's marks) is for the log. */
export interface SendReply {
  readonly outcome: SendOutcome | null;
  readonly reason: SendReason | null;
  readonly offers: readonly SendOffer[];
  readonly rowsHash: string | null;
  readonly replayed: boolean;
}

const OFFERS: readonly SendOffer[] = ["append", "replace", "cancel", "submit", "discard", "commit", "keys"];

function pick<const T extends string>(value: JsonValue | undefined, allowed: readonly T[]): T | null {
  return allowed.find((word) => word === value) ?? null;
}

/** The bridge's answer, field by field; null when it is not one (a proxy page, an old bridge). */
export function readSendReply(body: JsonValue | undefined): SendReply | null {
  const node = asJsonObject(body);
  if (node === undefined || !Array.isArray(node.offers)) return null;
  const receipt = asJsonObject(node.receipt);
  const offers = node.offers.flatMap((offer) => {
    const known = pick(offer, OFFERS);
    return known === null ? [] : [known];
  });
  return {
    outcome: pick(receipt?.outcome, SEND_OUTCOMES),
    reason: pick(receipt?.reason, SEND_REASONS),
    offers,
    rowsHash: asJsonString(node.rowsHash) ?? null,
    replayed: asJsonBoolean(node.replayed) === true,
  };
}

/** The sentence an answer gets: a key under `composer.protocol.*`. */
export type SendNote =
  | "sent"
  | "discarded"
  | "draft"
  | "typed"
  | "unconfirmed"
  | "unknown"
  | "busy"
  | "notFree"
  | "probeFailed"
  | "reservedLead"
  | "moved"
  | "paneGone"
  | "writeFailed"
  | "idReused"
  | "refused";

/** What an answer means for the composer. */
export interface SendReading {
  /** The text went out: clear the draft and show the sent pill. */
  readonly clear: boolean;
  readonly note: SendNote;
  /** The offers the strip shows; `keys` is not a button there (the Keys board is one tap away anyway). */
  readonly offers: readonly SendOffer[];
}

/** The sentence a refusal gets, by its reason. */
function refusalNote(reason: SendReason | null): SendNote {
  switch (reason) {
    case "busy":
      return "busy";
    case "not_free":
      return "notFree";
    case "draft_present":
      return "draft";
    case "probe_failed":
      return "probeFailed";
    case "reserved_lead":
      return "reservedLead";
    case "unconfirmed":
      return "unconfirmed";
    case "stale_surface":
      return "moved";
    case "pane_gone":
      return "paneGone";
    case "write_failed":
      return "writeFailed";
    case "id_reused":
      return "idReused";
    default:
      return "refused";
  }
}

export function readSend(reply: SendReply): SendReading {
  const offers = reply.offers.filter((offer) => offer !== "keys");
  switch (reply.outcome) {
    case "sent":
    case "effective":
      // A discard ends `sent` too: the box emptied, but nothing went to the agent, so the phone's draft stays.
      return reply.reason === "discarded" ? { clear: false, note: "discarded", offers: [] } : { clear: true, note: "sent", offers: [] };
    case "typed_not_submitted":
      return { clear: false, note: "typed", offers };
    case "refused":
      return { clear: false, note: refusalNote(reply.reason), offers };
    case "unknown":
    case null:
      return { clear: false, note: "unknown", offers };
  }
}

/** The mode a tap on an offer sends, or null for one that sends nothing (`cancel`, `keys`). */
export function offerMode(offer: SendOffer): SendMode | null {
  switch (offer) {
    case "append":
    case "replace":
    case "submit":
    case "discard":
      return offer;
    case "commit":
      return "send";
    case "cancel":
    case "keys":
      return null;
  }
}

/** The leads the composer keeps on the old reply route, whose slash palette and mention path own them. */
export const OLD_ROUTE_LEADS = ["/", "!", "@"] as const;

/** Whether a text goes through the old reply route even with the protocol on: it starts with a reserved lead. */
export function keepsOldRoute(text: string): boolean {
  const head = text.trimStart();
  return OLD_ROUTE_LEADS.some((lead) => head.startsWith(lead));
}
