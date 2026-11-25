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
  SEND_WORDS,
  readSendCap,
  readSurfaceWords,
  reservedLead,
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
  type SendWord,
  STALE_SCREEN,
  ANOTHER_SEND,
} from "./surface/send";
import type { ProfileStatus } from "./surface/profile";
import { ASK_CHANNELS, askOf, type Ask, type AskOption, type Surface, type SurfaceComposer, type SurfaceModal, type SurfaceReason, type SurfaceTurn } from "./surface/surface";
import { CODE_REJECTED_PLAIN } from "./surface/secret-field";

/**
 * Whether the person's override ("Send anyway") can go past the screen this answer refused on. A `menu_open`
 * with no rows hash is one no override passes (the bridge's blind-road guards, 2026-11-25: a plain program
 * with no agent's rows, or a row of one-key items): the hash is what an override binds to, so with none there
 * is nothing to go past, and the card offers no Send anyway. Every other answer leaves the card as it was.
 */
export function overridePasses(reply: Pick<SendReply, "reason" | "rowsHash">): boolean {
  return !(reply.reason === "menu_open" && reply.rowsHash === null);
}

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
  /**
   * A send from an agent view: the exact text the bridge typed into the session (`view.line`), head and
   * tail included, for the view's "Sent to this session". Absent on every other send.
   */
  readonly viewLine?: string;
  /** The person's word on the receipt (M102 spec 01), when it carries one: beside the outcome, never a proof. */
  readonly word?: SendWord;
  /**
   * Until when the agent's own word on this send may still come, epoch milliseconds (M102 spec 13): the receipt's
   * `awaitingEventUntil`. Absent on a bridge that does not say, which reads as "not waiting".
   */
  readonly awaitingUntil?: number;
  /**
   * The receipt's `draftSeen` (M102 spec 12): an override found words already in the agent's box and
   * typed its text after them. Absent on any other send, and on a bridge that does not say.
   */
  readonly draftSeen?: true;
  /**
   * The receipt's `textAlreadyTyped` (M102 spec 12): the box already held this very text, so nothing was
   * typed again and no key went out. The person presses Enter on the Keys pad.
   */
  readonly textAlreadyTyped?: true;
  /**
   * On a `draft_present` refusal: the box's text as the bridge read it, in the read its `rowsHash` covers
   * (ADR 0166), masked. Absent when the bridge could not read the box whole, on a sign-in field, and from
   * an older bridge. `draftCut`: the text was cut at the bridge's limit.
   */
  readonly draftText?: string;
  readonly draftCut?: true;
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
  // `staleFrame` (2026-10-25): only `true` is a word; anything else is dropped. So is `field`: only `secret`.
  const marked = node.staleFrame === true ? { ...read, staleFrame: true as const } : read;
  return node.field === "secret" ? { ...marked, field: "secret" } : marked;
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
    ...viewLineOf(node.view),
    ...wordOf(receipt?.word),
    ...awaitingOf(receipt?.awaitingEventUntil),
    ...draftSeenOf(receipt?.draftSeen),
    ...alreadyTypedOf(receipt?.textAlreadyTyped),
    ...draftTextOf(node.draftText, node.draftCut),
  };
}

/** The receipt's `awaitingEventUntil` as the field to spread: a positive finite number of epoch milliseconds, else nothing. */
function awaitingOf(value: JsonValue | undefined): { awaitingUntil?: number } {
  const until = asJsonNumber(value);
  return until === undefined || !Number.isFinite(until) || until <= 0 ? {} : { awaitingUntil: until };
}

/** The receipt's `word` as the field to spread: one of {@link SEND_WORDS}, else nothing. */
/** The receipt's `draftSeen` as the field to spread: only a literal true counts. */
/** The receipt's `textAlreadyTyped` as the field to spread: only a literal true counts. */
function alreadyTypedOf(value: JsonValue | undefined): { textAlreadyTyped?: true } {
  return value === true ? { textAlreadyTyped: true } : {};
}

/** The bridge's limit for a quoted draft; a longer one is cut here too, and marked cut. */
const DRAFT_TEXT_MAX = 2000;

/** The answer's quoted draft as the fields to spread: a non-empty string, kept to the bridge's 2000 characters. */
function draftTextOf(text: JsonValue | undefined, cut: JsonValue | undefined): Pick<SendReply, "draftText" | "draftCut"> {
  const value = asJsonString(text);
  if (value === undefined || value === "") return {};
  const kept = [...value];
  const over = kept.length > DRAFT_TEXT_MAX;
  const draftText = over ? kept.slice(0, DRAFT_TEXT_MAX).join("") : value;
  return cut === true || over ? { draftText, draftCut: true } : { draftText };
}

function draftSeenOf(value: JsonValue | undefined): { draftSeen?: true } {
  return value === true ? { draftSeen: true } : {};
}

function wordOf(value: JsonValue | undefined): { word?: SendWord } {
  const word = pick(value, SEND_WORDS);
  return word === null ? {} : { word };
}

/** The `view.line` of a view send's answer, as the field to spread: one string of 1 to 4096 characters, else nothing. */
function viewLineOf(view: JsonValue | undefined): { viewLine?: string } {
  const line = asJsonString(asJsonObject(view)?.line);
  return line === undefined || line === "" || line.length > 4096 ? {} : { viewLine: line };
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
    const word = pick(node.word, SEND_WORDS);
    if (word !== null) row.word = word;
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
  | "codeRejected"
  | "noSecretField"
  | "held"
  | "expired"
  | "cancelled"
  | "discarded"
  | "draft"
  | "draftCommand"
  | "draftUnseen"
  | "typed"
  | "overrideTyped"
  | "menuOpen"
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
  | "badHead"
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

/**
 * Whether a Surface reads as a screen Collie cannot read, the pane's unread state (the M102 review 2, H): an
 * unreadable modal, an unreachable box, a stale, torn or contested read, or no word for it at all. A free box, a
 * running turn, a draft and an ask Collie read are states it can read.
 */
export function readsUnread(surface: Surface): boolean {
  const note = surfaceNote(surface);
  return note === "unreadable" || note === "unreachable" || note === "unknown" || note === "stale" || note === "torn" || note === "contested";
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
  /** The one step that gets the person on (M102 spec 02), or null when the send went or nothing is blocked. */
  readonly step: NextStep | null;
  /** The step is Send again, and it waits until the other send on this pane ends (A31). */
  readonly waits: boolean;
}

/**
 * The step a stop card offers beside the card and the Keys pad (M102 spec 02): the action that changes
 * the situation, so no refusal is a dead end. The composer draws one button for it, first; the card (or,
 * with no card, the Screen) and Open Keys come after it, so a card holds at most two buttons plus the
 * card. `offers` and `card` are steps the strip or the card button already draw. `field` is the person's
 * own field: the text must change before it can go (a reserved lead, a line only Collie writes, line
 * breaks a one-line box cannot take, a new sign-in code), and the sentence says what to change.
 * `screen` is the step of a screen Collie cannot read: the person reads it, then uses the Keys pad.
 */
export type NextStep = "offers" | "card" | "sendAgain" | "stop" | "emptyBox" | "screen" | "field";

/** The steps that draw a button of their own in the notice. `offers`, `card` and `field` have theirs already. */
export const STEP_BUTTONS = ["sendAgain", "stop", "emptyBox", "screen"] as const satisfies readonly NextStep[];
export type StepButton = (typeof STEP_BUTTONS)[number];

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
    case "bad_head":
      return "badHead";
    case "stale_view":
      return "moved";
    case "code_rejected":
      return "codeRejected";
    case "no_secret_field":
      return "noSecretField";
    case "menu_open":
      return "menuOpen";
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
      return reason === "override" ? "overrideTyped" : "typed";
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
export type NoteKey =
  | `composer.protocol.${Exclude<SendNote, "steered" | "steerUnsupported" | "steerNotAllowed" | "unconfirmed" | "noticeKey" | "capConfirm">}`
  | "composer.protocol.unconfirmedPast"
  | "composer.protocol.capConfirmPast"
  | "composer.protocol.noticeKeyPast"
  | "composer.steer.unsupported"
  | "composer.steer.notAllowed"
  | "composer.steer.steered";

export function noteKey(note: SendNote): NoteKey {
  switch (note) {
    case "steered":
      return "composer.steer.steered";
    case "steerUnsupported":
      return "composer.steer.unsupported";
    case "steerNotAllowed":
      return "composer.steer.notAllowed";
    // The two sentences that name the commit offer name it as it reads, Send anyway, and promise nothing
    // about Enter: the phone's read can differ from the bridge's (the M102 review, pass 2).
    case "unconfirmed":
      return "composer.protocol.unconfirmedPast";
    case "noticeKey":
      return "composer.protocol.noticeKeyPast";
    // The cap's sentence names its confirm as it reads, Confirm and send anyway (the M102 review 3).
    case "capConfirm":
      return "composer.protocol.capConfirmPast";
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
    return capSentence(row.cap, (vars) => say("composer.protocol.capConfirmPast", vars));
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
  // With no commit offered (a running turn, a Replace) it names the card and the turn's end, not Send anyway.
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
  // A draft with no Add, Replace or Cancel (too long, too tall, or no frame to prove it): Empty the box is the way.
  if (note === "draft" && offers.length === 0) return { clear: false, note: "draftUnseen", offers };
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

/**
 * The person's override after a `not_free` refusal (M102 spec 03, invariant I4): when the refusal carries
 * the rows hash and the screen is no sign-in field and no ask Collie has read, the phone offers the
 * commit, Send anyway, which sends the text with `override` bound to those rows (spec 01). The bridge's
 * own offers stay as they are; this only adds the one the phone may offer by itself.
 *
 * NEVER FOR A SUBMIT (the M102 review, F). A Submit's text is already in the box (a popup at Enter
 * refused it), so an override would type it a second time. A commit is always sent with `override`, so
 * a Submit's answer carries no commit at all, not even one the bridge offered.
 */
function withOverride(reply: SendReply, offers: readonly SendOffer[], mode: SendMode): readonly SendOffer[] {
  if (mode === "submit") return offers.filter((offer) => offer !== "commit");
  if (reply.outcome !== "refused" || reply.reason !== "not_free" || reply.rowsHash === null || reply.surface === null) return offers;
  if (reply.surface.field === "secret" || askOf(reply.surface.modal) !== null || offers.includes("commit")) return offers;
  return [...offers, "commit"];
}

/** What an answer means. `mode` is the request's: a Submit's answer never offers the override. */
export function readSend(reply: SendReply, mode: SendMode = "send"): SendReading {
  const offers = withOverride(
    reply,
    reply.offers.filter((offer) => offer !== "keys"),
    mode,
  );
  const base = noteAndOffers(reply, offers);
  const surface = base.clear || reply.surface === null ? null : surfaceAfter(reply, surfaceNote(reply.surface));
  // A queued send whose Enter met a dialog points to the card too, whatever the dialog read as.
  const toCard =
    surface === "askMenu" || surface === "askPermission" || surface === "askQuestion" || surface === "unreadable" || (reply.outcome === "unknown" && reply.reason === "dialog_after_enter");
  const cap = base.note === "capConfirm" ? reply.cap : null;
  const step = base.clear ? null : nextStep(reply, base, toCard, surface);
  const waits = step === "sendAgain" && reply.reason === "busy" && (reply.detail === null || reply.detail === ANOTHER_SEND);
  return { ...base, surface, detail: base.clear || cap !== null || ownSentence(reply) ? null : reply.detail, toCard, cap, step, waits };
}

/**
 * The step of an answer that did not send (M102 spec 02, the table in experiments/m102/refusal-table.md).
 * Total over every outcome and reason, so a new reason gets a step before it can ship (send.test.ts,
 * "no dead end"). Null only where nothing is blocked (a discard, an end of a held send) and for a pane
 * that is gone, where nothing on this pane can change it and the draft is kept.
 */
export function nextStep(reply: SendReply, verdict: Verdict, toCard: boolean, surface: SurfaceNote | null): NextStep | null {
  const { outcome, reason } = reply;
  if (outcome === "discarded" || outcome === "held" || outcome === "expired" || outcome === "cancelled") return null;
  // The strip's own buttons are the step: Add, Replace, Cancel; Submit, Discard; Send anyway.
  if (verdict.offers.length > 0) return "offers";
  if (toCard) return "card";
  if (outcome === "typed_not_submitted") return "screen";
  if (outcome === "unknown" || outcome === null) return "sendAgain";
  switch (reason) {
    case "pane_gone":
      return null;
    // A draft Collie cannot read whole (too long, too tall, no frame): the Clear empties it in verified rounds.
    case "draft_present":
      return "emptyBox";
    case "turn_running":
      return "stop";
    // A menu or a yes/no prompt stood in the way of an override: the person answers it on the pad.
    case "menu_open":
    // A code that met no sign-in field: there is no field to enter it again into, so the person reads the screen.
    case "no_secret_field":
      return "screen";
    case "reserved_lead":
    case "multiline":
    case "bad_head":
    case "code_rejected":
      return "field";
    // Something Collie cannot read holds the box, or no box was found: the person reads the screen.
    case "not_free":
    case "unconfirmed":
      return surface === "unknown" || surface === "unreachable" ? "screen" : "sendAgain";
    default:
      return "sendAgain";
  }
}

/**
 * Whether the phone's own sentence already says what the bridge's English detail says (the
 * 2026-10-16 field case, "Collie cannot read this screen" twice). Only for a refusal, and only for
 * the reasons whose bridge line repeats the phone's sentence: `unconfirmed`, `stale_surface`, `no_secret_field`, `busy`,
 * `pane_gone`, `draft_present`, and `not_free` when the line is the plain one. Every other reason,
 * and every outcome that is no refusal, keeps the line: it says what the phone's sentence does not
 * (a `not_free` that names what is open, a dialog that Enter may have answered). An `unconfirmed`
 * with the `short_pane` cause keeps it too: the line names the rows read and what to resize. A
 * `probe_failed` with the `late_keys` cause keeps it as every `probe_failed` does: the line says the
 * agent showed Collie's keys late and to wait, which the phone's sentence does not (#623).
 */
const REPEATS_THE_NOTE: ReadonlySet<SendReason> = new Set(["unconfirmed", "stale_surface", "pane_gone", "draft_present", "bad_head", "stale_view", "no_secret_field"]);
const PLAIN_NOT_FREE = "The input box is not free.";

function ownSentence(reply: SendReply): boolean {
  if (reply.outcome !== "refused" || reply.reason === null) return false;
  if (reply.cause === "stale_screen") return true;
  if (reply.cause === "short_pane") return false;
  if (REPEATS_THE_NOTE.has(reply.reason)) return true;
  // A full hold queue names its count under the sentence; only the plain "still running" repeats it.
  if (reply.reason === "busy") return reply.detail === null || reply.detail === ANOTHER_SEND;
  // A refused code whose words held the code: the bridge sent only the plain sentence (M102 spec 05).
  if (reply.reason === "code_rejected") return reply.detail === CODE_REJECTED_PLAIN;
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

/**
 * Whether a text is sent as a `command` (it starts with a reserved lead), not as a plain `send`. It
 * reads the lead with the bridge's own rule (`reservedLead`), so a text whose first word is the path
 * of a saved upload (an image attached first) is a message, never a slash command.
 */
export function isCommand(text: string): boolean {
  return reservedLead(text, COMMAND_LEADS) !== null;
}
