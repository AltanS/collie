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
import {
  SEND_MODES,
  SEND_OUTCOMES,
  SEND_CAUSES,
  SEND_REASONS,
  SEND_LATES,
  readSendCap,
  readSurfaceWords,
  RECEIPT_DETAIL_MAX,
  type SendCap,
  type SendCause,
  type SendMode,
  type SendOffer,
  type SendOutcome,
  type HeldCancelAnswer,
  type SendReason,
  type SendReceiptRow,
  type SendReceiptsAnswer,
  type SendStep,
  STALE_SCREEN,
} from "./surface/send";
import type { ProfileStatus } from "./surface/profile";
import { ASK_CHANNELS, type Ask, type AskOption, type Surface, type SurfaceComposer, type SurfaceModal, type SurfaceReason, type SurfaceTurn } from "./surface/surface";

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
  /** Set when the cap asks for one more confirm (M56 spec 09): the next commit carries `capAck`. */
  readonly cap: SendCap | null;
  /** The receipt says the send went in while the turn ran: the harness queued it for after the turn. */
  readonly queued: boolean;
  /** Which rule decided the answer beside its reason (`notice_key`); null when the bridge named none. */
  readonly cause: SendCause | null;
}

const PROFILE_STATUSES: readonly ProfileStatus[] = ["verified", "provisional", "revoked"];
const OFFERS: readonly SendOffer[] = ["append", "replace", "cancel", "submit", "discard", "commit", "keys"];
const TURNS: readonly SurfaceTurn[] = ["idle", "running", "unknown"];
const COMPOSERS: readonly SurfaceComposer[] = ["empty", "draft", "unreachable", "unknown"];
const REASONS: readonly SurfaceReason[] = ["no-match", "contested", "stale", "torn"];
const MODAL_WORDS = ["none", "unreadable", "unknown"] as const;
const ASK_KINDS = ["permission", "question", "menu"] as const;

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
  const read: Surface = reason === null ? { revision, turn, modal, composer } : { revision, turn, modal, composer, reason };
  // `staleFrame` (2026-10-25): only `true` is a word; anything else is dropped.
  return node.staleFrame === true ? { ...read, staleFrame: true } : read;
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
    cap: readSendCap(node.cap),
    queued: receipt?.queued === true,
    cause: pick(node.cause, SEND_CAUSES),
  };
}

/** A row of the list being built, field by field. */
type RowDraft = { -readonly [K in keyof SendReceiptRow]: SendReceiptRow[K] };

const STEPS: readonly SendStep[] = ["profile", "settle", "s0", "proof", "clear", "probe", "probeWrite", "write", "s1", "commandSettle", "commit", "s2"];

/**
 * The session page's list of recent sends, row by row. A row that is not whole is left out. The wire
 * carries no screen row, and this reads none: outcome, reason, time, the keys by name and the measured
 * gaps, on a refusal Collie's own line and four Surface words, and `line`, the one line of the text
 * the bridge kept when Sent's rule would (see {@link SendReceiptRow.line}). Any other text field is
 * not read.
 */
export function readSendReceipts(body: JsonValue | undefined): SendReceiptsAnswer {
  const list = asJsonObject(body)?.receipts;
  if (!Array.isArray(list)) return { receipts: [] };
  const receipts: SendReceiptRow[] = [];
  for (const raw of list) {
    const node = asJsonObject(raw);
    if (node === undefined) continue;
    const requestId = asJsonString(node.requestId);
    const at = asJsonNumber(node.at);
    const mode = pick(node.mode, SEND_MODES);
    const outcome = pick(node.outcome, SEND_OUTCOMES);
    const harness = asJsonString(node.harness);
    if (requestId === undefined || at === undefined || mode === null || outcome === null || harness === undefined) continue;
    if (!Array.isArray(node.keys)) continue;
    const keys = node.keys.flatMap((key) => {
      const name = asJsonString(key);
      return name === undefined ? [] : [name];
    });
    const gapsMs: Partial<Record<SendStep, number>> = {};
    const gaps = asJsonObject(node.gapsMs);
    for (const step of STEPS) {
      const gap = asJsonNumber(gaps?.[step]);
      if (gap !== undefined) gapsMs[step] = gap;
    }
    const reason = pick(node.reason, SEND_REASONS);
    const cap = readSendCap(node.cap);
    const row: RowDraft = { requestId, at, mode, outcome, keys, gapsMs, harness, version: asJsonString(node.version) ?? null };
    if (reason !== null) row.reason = reason;
    if (cap !== null) row.cap = cap;
    const profileId = asJsonString(node.profileId);
    if (profileId !== undefined && profileId.length > 0) row.profileId = profileId;
    const profileStatus = pick(node.profileStatus, PROFILE_STATUSES);
    if (profileStatus !== null) row.profileStatus = profileStatus;
    if (node.queued === true) row.queued = true;
    const late = pick(node.late, SEND_LATES);
    if (late !== null) row.late = late;
    const detail = asJsonString(node.detail);
    if (detail !== undefined && detail.length > 0) row.detail = detail.slice(0, RECEIPT_DETAIL_MAX);
    const saw = readSurfaceWords(node.saw);
    if (saw !== null) row.saw = saw;
    const line = asJsonString(node.line);
    if (line !== undefined && line.length > 0) row.line = line;
    receipts.push(row);
  }
  return { receipts };
}

const HELD_RESULTS: readonly HeldCancelAnswer["result"][] = ["cancelled", "dismissed", "refused"];

/** What `DELETE /api/send/<id>` answered, field by field; null when it is not one (a proxy page, an old bridge). */
export function readHeldCancelAnswer(body: JsonValue | undefined): HeldCancelAnswer | null {
  const node = asJsonObject(body);
  const result = pick(node?.result, HELD_RESULTS);
  if (result === null) return null;
  const reason = pick(node?.reason, SEND_REASONS);
  // Only a refusal carries a receipt that matters: the request already went out.
  const stored = asJsonObject(node?.receipt);
  const outcome = result === "refused" ? pick(stored?.outcome, SEND_OUTCOMES) : null;
  const storedReason = pick(stored?.reason, SEND_REASONS);
  const receipt = outcome === null ? null : storedReason === null ? { outcome } : { outcome, reason: storedReason };
  if (receipt !== null) return reason === null ? { result, receipt } : { result, reason, receipt };
  return reason === null ? { result } : { result, reason };
}

/** The sentence an answer gets: a key under `composer.protocol.*`. */
export type SendNote =
  | "sent"
  | "queued"
  | "steered"
  | "steerUnsupported"
  | "steerNotAllowed"
  | "held"
  | "expired"
  | "cancelled"
  | "discarded"
  | "draft"
  | "draftCommand"
  | "typed"
  | "unconfirmed"
  | "noticeKey"
  | "noticeKeyHeld"
  | "staleScreen"
  | "staleScreenProbe"
  | "capConfirm"
  | "unknown"
  | "busy"
  | "agentBusy"
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
  /** Set when the cap asks for one more confirm; its words name the count and the version. */
  readonly cap: SendCap | null;
}

/**
 * The sentence a refusal gets, by its reason. `not_free` and `bound` each have their own; `multiline`
 * takes the plain refusal, and the bridge's detail says to send one line at a time. `turn_running`
 * (a harness that does not take a message during a turn) says the agent is working, not that the box
 * is taken.
 */
function refusalNote(reason: SendReason | null): SendNote {
  switch (reason) {
    case "busy":
      return "busy";
    case "not_free":
      return "notFree";
    case "turn_running":
      return "agentBusy";
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
    case "steer_unsupported":
      return "steerUnsupported";
    case "steer_not_allowed":
      return "steerNotAllowed";
    default:
      return "refused";
  }
}

/**
 * The sentence for an outcome and its reason: a key under `composer.protocol.*`. The composer's
 * answer and the session page's list of recent sends both read it, so a reason code never reaches
 * the person raw.
 */
export function sendNote(outcome: SendOutcome | null, reason: SendReason | null): SendNote {
  switch (outcome) {
    case "sent":
    case "effective":
      return "sent";
    case "steered":
      return "steered";
    case "discarded":
      return "discarded";
    case "held":
      return "held";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    case "typed_not_submitted":
      return "typed";
    case "refused":
      return refusalNote(reason);
    case "unknown":
    case null:
      return "unknown";
  }
}

/**
 * The catalog key of a note's sentence. Most are under `composer.protocol.*`; the steer ones (M69)
 * live with their feature. `steered` is a sentence here; Recent sends wears the one word
 * (`sendReceipts.outcome.steered`), as its other outcomes do.
 */
export type NoteKey = `composer.protocol.${Exclude<SendNote, "steered" | "steerUnsupported" | "steerNotAllowed">}` | "composer.steer.unsupported" | "composer.steer.notAllowed" | "composer.steer.steered";

export function noteKey(note: SendNote): NoteKey {
  switch (note) {
    case "steered":
      return "composer.steer.steered";
    case "steerUnsupported":
      return "composer.steer.unsupported";
    case "steerNotAllowed":
      return "composer.steer.notAllowed";
    default:
      return `composer.protocol.${note}`;
  }
}

/** Stands for a version that is not there while the cap's sentence is filled; the sentence is cut around it. */
const NO_VERSION = "\u0000";

/**
 * The cap's sentence, from the catalog's words with `{count}`, `{harness}` and `{version}` filled by
 * `say`. A harness with no version (the bridge writes `-` when it read none) is named alone: the
 * placeholder and the space in front of it go, so no dash and no double space is left behind.
 */
export function capSentence(cap: SendCap, say: (vars: { count: string; harness: string; version: string }) => string): string {
  const none = cap.version === "" || cap.version === "-";
  const text = say({ count: String(cap.count), harness: cap.harness, version: none ? NO_VERSION : cap.version });
  return none ? text.replace(` ${NO_VERSION}`, "").replace(NO_VERSION, "") : text;
}

/**
 * The label a row of the session page's list wears for its outcome: a key in the catalog. A discard has
 * no row label of its own; it wears the Discard button's word, so the list never calls it "Sent".
 */
export function receiptLabelKey(outcome: SendOutcome): "composer.protocol.discard" | `sendReceipts.outcome.${Exclude<SendOutcome, "discarded">}` {
  if (outcome === "discarded") return "composer.protocol.discard";
  return `sendReceipts.outcome.${outcome}`;
}

/**
 * The sentence under a row's label, or null when it has none. A reason reads as the composer's sentence
 * for it; the cap's refusal, which carries its numbers, reads as the cap's sentence with them filled in;
 * a discard carries no reason and has its own sentence; a send queued behind the turn says so.
 */
export function receiptSentence(
  row: SendReceiptRow,
  say: (key: NoteKey | "sendReceipts.queued" | "sendReceipts.returned", vars?: Record<string, string>) => string,
): string | null {
  if (row.outcome === "discarded") return say("composer.protocol.discarded");
  // Stop gave the queued text back to the box (ADR 0122): the row is still `sent`, but not waiting.
  if (row.late === "returned") return say("sendReceipts.returned");
  if (row.queued === true) return say("sendReceipts.queued");
  if (row.reason === undefined) return null;
  if (row.outcome === "refused" && row.reason === "unconfirmed" && row.cap !== undefined) {
    return capSentence(row.cap, (vars) => say("composer.protocol.capConfirm", vars));
  }
  // A steered row wears its one word, like Sent; the sentence is the status line's under the box.
  if (row.outcome === "steered") return null;
  return say(noteKey(sendNote(row.outcome, row.reason)));
}

/** The verdict half of a reading: whether the draft goes, the sentence, the offers. */
type Verdict = Pick<SendReading, "clear" | "note" | "offers">;

function noteAndOffers(reply: SendReply, offers: readonly SendOffer[]): Verdict {
  // The cap's refusal is an `unconfirmed` one with a count: its own sentence, the same offer.
  if (reply.outcome === "refused" && reply.reason === "unconfirmed" && reply.cap !== null) return { clear: false, note: "capConfirm", offers };
  // A send of one of the digits a notice above the box printed: the sentence says the digit would answer it.
  // With no commit offered (a running turn, a Replace) it names the card and the turn's end, not Type here.
  if (reply.outcome === "refused" && reply.cause === "notice_key") return { clear: false, note: offers.includes("commit") ? "noticeKey" : "noticeKeyHeld", offers };
  // A box that did not take the probe, and a second read of the same rows (2026-10-25). A line longer
  // than the plain one says a probe character may remain in the live editor: that has its own sentence.
  if (reply.outcome === "refused" && reply.cause === "stale_screen") return { clear: false, note: reply.detail === null || reply.detail === STALE_SCREEN ? "staleScreen" : "staleScreenProbe", offers };
  const note = sendNote(reply.outcome, reply.reason);
  // A discard has its own outcome: the box emptied, but nothing went to the agent, so the phone's draft stays.
  // A send queued behind the running turn went out all the same: it clears, and its sentence says it waits.
  if (note === "sent") return { clear: true, note: reply.queued ? "queued" : note, offers: [] };
  // A steer the witness saw land: the text went into the running turn, so the draft goes like a send's.
  if (note === "steered") return { clear: true, note, offers: [] };
  if (note === "discarded") return { clear: false, note, offers: [] };
  // A held send is the bridge's to keep: its text now lives in the queued row above the box, so the
  // draft goes. Not a refusal, so it carries no offers. `expired` and `cancelled` end a held send and
  // answer a DELETE or a snapshot row, not a POST; they are read here for a receipt that arrives late.
  if (note === "held") return { clear: true, note, offers: [] };
  if (note === "expired" || note === "cancelled") return { clear: false, note, offers: [] };
  // A command onto a draft is offered Replace and Cancel, not Add (the bridge's list): the sentence names only those.
  if (note === "draft" && offers.includes("replace") && !offers.includes("append")) return { clear: false, note: "draftCommand", offers };
  return { clear: false, note, offers };
}

/**
 * What the screen word adds after the verdict. After `typed_not_submitted` the box holds the person's
 * own text, which the Surface reads as a draft; "The box held a draft" would call it someone else's.
 * Only a `mismatch` (the box shows other text than was typed) keeps the draft word.
 */
function surfaceAfter(reply: SendReply, note: SurfaceNote): SurfaceNote | null {
  if (reply.outcome === "typed_not_submitted" && note === "draft" && reply.reason !== "mismatch") return null;
  return note;
}

export function readSend(reply: SendReply): SendReading {
  const offers = reply.offers.filter((offer) => offer !== "keys");
  const base = noteAndOffers(reply, offers);
  const surface = base.clear || reply.surface === null ? null : surfaceAfter(reply, surfaceNote(reply.surface));
  // A queued send whose Enter met a dialog points to the card too, whatever the dialog read as.
  const toCard =
    surface === "askMenu" || surface === "askPermission" || surface === "askQuestion" || surface === "unreadable" || (reply.outcome === "unknown" && reply.reason === "dialog_after_enter");
  const cap = base.note === "capConfirm" ? reply.cap : null;
  return { ...base, surface, detail: base.clear || cap !== null || ownSentence(reply) ? null : reply.detail, toCard, cap };
}

/**
 * Whether the phone's own sentence already says what the bridge's English detail says (the
 * 2026-10-16 field case, "Collie cannot read this screen" twice). Only for a refusal, and only for
 * the reasons whose bridge line repeats the phone's sentence: `unconfirmed`, `stale_surface`, `busy`,
 * `pane_gone`, `draft_present`, and `not_free` when the line is the plain one. Every other reason,
 * and every outcome that is no refusal, keeps the line: it says what the phone's sentence does not
 * (a `not_free` that names what is open, a dialog that Enter may have answered).
 */
const REPEATS_THE_NOTE: ReadonlySet<SendReason> = new Set(["unconfirmed", "stale_surface", "busy", "pane_gone", "draft_present"]);
const PLAIN_NOT_FREE = "The input box is not free.";

function ownSentence(reply: SendReply): boolean {
  if (reply.outcome !== "refused" || reply.reason === null) return false;
  if (reply.cause === "stale_screen") return true;
  if (REPEATS_THE_NOTE.has(reply.reason)) return true;
  return reply.reason === "not_free" && reply.detail === PLAIN_NOT_FREE;
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
