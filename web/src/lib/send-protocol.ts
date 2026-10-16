// The composer's side of the Send Protocol (M56 specs 05 and 06): read the bridge's answer to a send
// and say what it means for the draft, the request id, the offer strip and the sentence at the thumb.
// Pure, so the composer only renders what this decides.
//
// The phone mints a request id at tap time and keeps it across retries of the same intent (the same
// mode, the same text, the same rows hash): a retry after a lost answer then gets the stored receipt
// and never a second send. Every offer the answer makes is a new intent, so it gets a new id.
//
// Since spec 06 this is the only way text leaves the composer. The answer's Surface and the bridge's
// own sentence (`detail`) reach the person: a refusal names what the bridge saw on the screen.

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "./json";
import { SEND_OUTCOMES, SEND_REASONS, type SendMode, type SendOffer, type SendOutcome, type SendReason } from "./surface/send";
import type { Ask, AskOption, Surface, SurfaceComposer, SurfaceModal, SurfaceReason, SurfaceTurn } from "./surface/surface";

/** What the composer needs of an answer. The receipt's marks and gaps are for the log. */
export interface SendReply {
  readonly outcome: SendOutcome | null;
  readonly reason: SendReason | null;
  readonly offers: readonly SendOffer[];
  readonly rowsHash: string | null;
  readonly replayed: boolean;
  /** The Surface of the newest read, when the answer is about the screen (a refusal, a prepare). */
  readonly surface: Surface | null;
  /** The bridge's own sentence: what moved, which route a lead belongs to, why a step stopped. */
  readonly detail: string | null;
}

const OFFERS: readonly SendOffer[] = ["append", "replace", "cancel", "submit", "discard", "commit", "keys"];
const TURNS: readonly SurfaceTurn[] = ["idle", "running", "unknown"];
const COMPOSERS: readonly SurfaceComposer[] = ["empty", "draft", "unreachable", "unknown"];
const REASONS: readonly SurfaceReason[] = ["no-match", "contested", "stale", "torn"];
const MODAL_WORDS = ["none", "unreadable", "unknown"] as const;
const ASK_KINDS = ["permission", "question", "menu"] as const;
const ASK_CHANNELS = ["hook", "keys"] as const;

function pick<const T extends string>(value: JsonValue | undefined, allowed: readonly T[]): T | null {
  return allowed.find((word) => word === value) ?? null;
}

/** An ask on the wire, field by field, or null. */
export function readAsk(value: JsonValue | undefined): Ask | null {
  const node = asJsonObject(value);
  if (node === undefined || !Array.isArray(node.options)) return null;
  const id = asJsonString(node.id);
  const kind = pick(node.kind, ASK_KINDS);
  const channel = pick(node.channel, ASK_CHANNELS);
  const hash = asJsonString(node.hash);
  if (id === undefined || kind === null || channel === null || hash === undefined) return null;
  const options: AskOption[] = [];
  for (const option of node.options) {
    const fields = asJsonObject(option);
    const optionId = asJsonString(fields?.id);
    const label = asJsonString(fields?.label);
    if (optionId === undefined || label === undefined) return null;
    options.push({ id: optionId, label });
  }
  return { id, kind, options, channel, hash };
}

/** A Surface on the wire (a snapshot's pane, an answer), field by field, or null when it is not one. */
export function readSurface(value: JsonValue | undefined): Surface | null {
  const node = asJsonObject(value);
  if (node === undefined) return null;
  const revision = asJsonNumber(node.revision);
  const turn = pick(node.turn, TURNS);
  const composer = pick(node.composer, COMPOSERS);
  if (revision === undefined || turn === null || composer === null) return null;
  let modal: SurfaceModal;
  const word = pick(node.modal, MODAL_WORDS);
  if (word !== null) modal = word;
  else {
    const ask = readAsk(asJsonObject(node.modal)?.ask);
    if (ask === null) return null;
    modal = { ask };
  }
  const reason = pick(node.reason, REASONS);
  return reason === null ? { revision, turn, modal, composer } : { revision, turn, modal, composer, reason };
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
    surface: readSurface(node.surface),
    detail: asJsonString(node.detail) ?? null,
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
  | "bound"
  | "probeFailed"
  | "reservedLead"
  | "moved"
  | "paneGone"
  | "writeFailed"
  | "idReused"
  | "refused";

/** What the screen was, in one word, for the sentence after the note: a key under `composer.surface.*`. */
export type SurfaceNote =
  | "free"
  | "running"
  | "askMenu"
  | "askPermission"
  | "askQuestion"
  | "unreadable"
  | "draft"
  | "unreachable"
  | "unknown"
  | "stale"
  | "torn"
  | "contested";

/** The one word for a Surface the person is told about. The modal comes first: it owns the keyboard. */
export function surfaceNote(surface: Surface): SurfaceNote {
  const { modal } = surface;
  if (modal !== "none" && modal !== "unreadable" && modal !== "unknown") {
    return modal.ask.kind === "menu" ? "askMenu" : modal.ask.kind === "permission" ? "askPermission" : "askQuestion";
  }
  if (modal === "unreadable") return "unreadable";
  if (surface.composer === "unreachable") return "unreachable";
  if (surface.reason === "stale" || surface.reason === "torn" || surface.reason === "contested") return surface.reason;
  if (surface.turn === "running") return "running";
  if (surface.composer === "draft" && modal === "none") return "draft";
  if (surface.turn === "idle" && modal === "none" && surface.composer === "empty") return "free";
  return "unknown";
}

/** What an answer means for the composer. */
export interface SendReading {
  /** The text went out: clear the draft and show the sent pill. */
  readonly clear: boolean;
  readonly note: SendNote;
  /** The offers the strip shows; `keys` is not a button there (the Keys board is one tap away anyway). */
  readonly offers: readonly SendOffer[];
  /** What the bridge saw on the screen, said after the note; null when the answer carried no Surface. */
  readonly surface: SurfaceNote | null;
  /** The bridge's own sentence, shown under the note; null when it said nothing. */
  readonly detail: string | null;
  /** The screen holds an ask or a screen Collie cannot read: the notice's control goes to the card. */
  readonly toCard: boolean;
}

/** The sentence a refusal gets, by its reason. `not_free` and `bound` each have their own. */
function refusalNote(reason: SendReason | null): SendNote {
  switch (reason) {
    case "busy":
      return "busy";
    case "not_free":
      return "notFree";
    case "bound":
      return "bound";
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

/** The verdict half of a reading: whether the draft goes, the sentence, the offers. */
type Verdict = Pick<SendReading, "clear" | "note" | "offers">;

function noteAndOffers(reply: SendReply, offers: readonly SendOffer[]): Verdict {
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

export function readSend(reply: SendReply): SendReading {
  const offers = reply.offers.filter((offer) => offer !== "keys");
  const base = noteAndOffers(reply, offers);
  const surface = base.clear || reply.surface === null ? null : surfaceNote(reply.surface);
  const toCard = surface === "askMenu" || surface === "askPermission" || surface === "askQuestion" || surface === "unreadable";
  return { ...base, surface, detail: base.clear ? null : reply.detail, toCard };
}

/** The mode a tap on an offer sends, or null for one that sends nothing (`cancel`, `keys`). A commit keeps a command a command. */
export function offerMode(offer: SendOffer, text = ""): SendMode | null {
  switch (offer) {
    case "append":
    case "replace":
    case "submit":
    case "discard":
      return offer;
    case "commit":
      return isCommand(text) ? "command" : "send";
    case "cancel":
    case "keys":
      return null;
  }
}

/** The leads a text is a command by: a slash command, a shell line, a file mention at the start. */
export const COMMAND_LEADS = ["/", "!", "@"] as const;

/** Whether a text is sent as a `command` (it starts with a reserved lead), not as a plain `send`. */
export function isCommand(text: string): boolean {
  const head = text.trimStart();
  return COMMAND_LEADS.some((lead) => head.startsWith(lead));
}
