// The Send Protocol's wire shapes and its pure text rules (M56 spec 05; the contract is in the M56
// README, "Send Protocol", and experiments/reader-stability/ARCHITECTURE.md section 2). The bridge
// runs the steps (bridge/surface/protocol.ts); the phone mints the request id, posts one request and
// renders the answer. Both read the types from here, so the closed lists cannot drift apart.
//
// Pure: no DOM, no Bun API, no harness name.

import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "../json";
import type { ProfileStatus } from "./profile";
import { modalWord, type Surface, type SurfaceReason } from "./surface";

/**
 * The closed list of outcomes. `effective` needs a matching prompt edge (spec 11); without one a send closes as `sent`.
 * `discarded` is a Discard that emptied the box: nothing went to the agent, so it is never a send.
 * `held` is not an end (M56 spec 15): the harness could not take the send while its turn ran, so the
 * bridge keeps it and sends it, under the same request id, once the pane reads free. A held request
 * ends like any other send, or `expired` (nobody could send it within 30 minutes; the text is kept for
 * a Resend), or `cancelled` (the person took it back before it went out).
 * `steered` (M69) ends a steer (`when: "steer"`): the harness drew its own sign that the text went into
 * the running turn. A steer the harness queued instead ends `sent` with `queued`, as a queued send does.
 */
export const SEND_OUTCOMES = ["effective", "sent", "discarded", "typed_not_submitted", "refused", "unknown", "held", "expired", "cancelled", "steered"] as const;
export type SendOutcome = (typeof SEND_OUTCOMES)[number];

/**
 * The closed list of reasons. A `refused` outcome always carries one and nothing was typed (or, for
 * `probe_failed`, only the probe character). The other outcomes carry one when there is something to
 * say: why the text was not submitted, or why the outcome is unknown.
 */
export const SEND_REASONS = [
  // refused: nothing of the text was written
  "id_reused",
  "busy",
  "not_free",
  "draft_present",
  "probe_failed",
  "reserved_lead",
  "unconfirmed",
  "stale_surface",
  "pane_gone",
  "write_failed",
  // refused: a text of more than one line on a pane whose newline key is unknown (no profile)
  "multiline",
  // refused: the turn runs and this harness does not take typed input during a turn (its profile
  // does not say it queues), or the text is a command its profile does not queue. A bridge with a
  // hold queue (M56 spec 15) holds such a send instead; only a Submit of a box in a turn is refused.
  "turn_running",
  // typed_not_submitted: the text is in the box, Enter was not sent
  "mismatch",
  "changed",
  "modal_cue",
  "stale_token",
  "submit_failed",
  // typed_not_submitted (M69, counsel on the Edge 5 candidate): a steer's read after its pause and
  // before the steer key showed a dialog (`dialog_open`: the key would answer it), or no box, or a
  // modal it cannot tell (`unreadable`). The text is in the box; no key was pressed.
  "dialog_open",
  "unreadable",
  // unknown: the request ended without evidence either way. `bound` also refuses: an S0 past its own
  // bound (2 reads, 1200 ms) ends `refused(bound)`, since nothing was written yet.
  "bound",
  "crash",
  "lost_lock",
  "no_evidence",
  // unknown: a send queued behind a running turn met a dialog as its Enter went out; the dialog may
  // have taken the Enter, so the person checks the card before answering it
  "dialog_after_enter",
  // refused (M69): a steer on a pane whose profile names no steer key, on a version Collie may not
  // trust with a running turn, or for a text that is no message (a command)
  "steer_unsupported",
  // refused (M69): a steer from a caller that is not a person's send from the phone (walky talky, a
  // hook, the CLI): an agent's text never steers a turn
  "steer_not_allowed",
] as const;
export type SendReason = (typeof SEND_REASONS)[number];

/**
 * What a request asks for. `send` is a new message into an empty box. `command` is a text that starts
 * with a reserved lead (`/`, `!`, `@`): the harness opens its own popup under the box as it is typed,
 * so the S1 check reads the box and the transcript above it and lets the rows under it move, and S2
 * takes the box letting go of the text as the evidence (M56 spec 06). `append` and `replace` answer a
 * `draft_present` refusal; `submit` and `discard` answer a `typed_not_submitted`. `prepare` only reads
 * and hands back the hash of the rows, for the two-tap send on a screen Collie cannot read.
 */
export const SEND_MODES = ["send", "command", "append", "replace", "submit", "discard", "prepare"] as const;
export type SendMode = (typeof SEND_MODES)[number];

/**
 * Whether a Surface takes the manual Send: two taps, `prepare` then a commit with the hash of the rows
 * the person saw (M56 spec 06). Open on `unknown(no-match)`, on a weak cue (modal unknown with no
 * reason) and on `modal unreadable`: a false overlay hit must never block a send, and the probe still
 * refuses a text that would land in a hotkey dialog. Closed while the turn runs, on a draft, on a box
 * that cannot be reached, and on a read that is stale, torn or contested (read again first). The
 * bridge's S0 gate and the phone's Send slot both read this one rule.
 */
export function takesManualSend(surface: Surface): boolean {
  if (surface.composer === "unreachable" || surface.composer === "draft") return false;
  if (surface.turn === "running") return false;
  if (surface.reason === "stale" || surface.reason === "torn" || surface.reason === "contested") return false;
  return surface.modal === "unknown" || surface.modal === "unreadable";
}

/**
 * When a send goes into a running turn (M69). `steer`: into the turn the agent runs now, with the
 * profile's steer key (`keys.steer`). Absent: as before, queued for after the turn (or held). A steer
 * is the person's explicit choice per send; nothing makes it the default.
 */
export const SEND_WHENS = ["steer"] as const;
export type SendWhen = (typeof SEND_WHENS)[number];

/** A next action the answer offers, each a new request with a new id (`cancel` and `keys` send nothing). */
export type SendOffer = "append" | "replace" | "cancel" | "submit" | "discard" | "commit" | "keys";

/** What the phone posts to `POST /api/send`. The id is minted at tap time and kept across retries. */
export interface SendRequestBody {
  readonly id: string;
  readonly pane: string;
  readonly text: string;
  readonly mode?: SendMode;
  /** The hash of the rows the person saw, from a `prepare` or an `unconfirmed` answer. */
  readonly rowsHash?: string | undefined;
  /** The extra confirm of the cap (M56 spec 09): true on a commit the person made after an answer that carried `cap`. */
  readonly capAck?: boolean | undefined;
  /** The Surface revision the phone showed. A program pane refuses `stale_surface` when its turn moved since (M56 spec 14). */
  readonly revision?: number | undefined;
  /**
   * Resend of an ended held row (M56 spec 15): the old request id. The text goes empty; the bridge takes
   * the stored text and mode of that row, sends them under this request's `id`, and drops the old row
   * itself once it took the new request. The phone never sends a row's text back (it may be masked).
   */
  readonly resendOf?: string | undefined;
  /**
   * `steer` (M69): a send into a running turn steers it instead of queueing (the Send button's long
   * press, only where the pane view says `canSteer`). Absent: exactly the send as before. On an idle
   * turn a steer goes as a plain send and its receipt says `sent`.
   */
  readonly when?: SendWhen | undefined;
}

/**
 * The cap's answer (M56 spec 09): after `limit` manual sends on one harness and version inside 24
 * hours, the next one takes one more confirm that names the count and the version. It only adds a
 * confirm: the manual Send and the Keys dock stay, and no setting turns the confirm off.
 */
export interface SendCap {
  /** The manual sends counted inside the window. */
  readonly count: number;
  readonly limit: number;
  readonly harness: string;
  /** The harness's version from its binary, or `-` when it has none. */
  readonly version: string;
}

/** The cap's answer on the wire, field by field, or null. */
export function readSendCap(value: JsonValue | undefined): SendCap | null {
  const node = asJsonObject(value);
  if (node === undefined) return null;
  const count = asJsonNumber(node.count);
  const limit = asJsonNumber(node.limit);
  const harness = asJsonString(node.harness);
  const version = asJsonString(node.version);
  if (count === undefined || limit === undefined || harness === undefined || version === undefined) return null;
  if (!Number.isInteger(count) || !Number.isInteger(limit) || count < 0 || limit < 1) return null;
  return { count, limit, harness, version };
}

/** One read the receipt names: the multiplexer's revision and a short hash of the rows. Never the rows. */
export interface ReadMark {
  readonly revision: number;
  readonly hash: string;
}

/**
 * The steps whose time a receipt measures. `profile` is the wait for the harness's profile and binary
 * version before S0 (#594): the send's bound starts after it, so it is measured and never counted.
 * `proof`: the probe of a draft S0 read, with its second S0 read where it needed one (2026-10-25); S0's gap leaves it out.
 * `settle`: an S0 whose screen geometry was in flux (a resize between its reads, or a torn read), and the
 * pause before the one more S0 that was judged (2026-10-26); S0's gap leaves it out too.
 * `commandSettle`: a command on a harness with a command list, from the S1 read that first passed to the
 * read at least the settle interval later that agreed with it on the rows under the box (2026-10-26); S1's
 * gap ends at the first of the two.
 * `probeWrite`: the multiplexer's time for the probe character's write and its Backspace (2026-10-30); the
 * probe's gap leaves it out, as the probe's read bound does.
 */
export type SendStep = "profile" | "settle" | "s0" | "proof" | "clear" | "probe" | "probeWrite" | "write" | "s1" | "commandSettle" | "commit" | "s2";

/**
 * The receipt, a closed list of fields. It is written to disk, so it holds no screen text and no
 * message text: the rows live only in the bridge's short memory ring, and the text only as a hash.
 */
export interface SendReceipt {
  readonly requestId: string;
  readonly session: string;
  readonly paneId: string;
  readonly paneGeneration: string;
  readonly harness: string;
  /** The harness's version: of the pane's own program when the bridge could see it ({@link binary}), else of the binary on its PATH. */
  readonly version: string | null;
  readonly profileId: string | null;
  readonly profileStatus: ProfileStatus | null;
  /**
   * The file whose version was read, when the read ran the pane's own program (its foreground process,
   * ADR 0124): an absolute path, a local fact. A pane whose argv[0] is a bare `omp` carries it too, by
   * its executable, which may be the same file the PATH holds. Absent when the bridge's PATH lookup
   * answered (no pane, no foreground read, a file it could not stat, a pane over its read limit). The
   * recent-sends rows, and so a problem report, do not carry it.
   */
  readonly binary?: string;
  readonly textHash: string;
  readonly textLength: number;
  readonly s0: ReadMark | null;
  readonly s1: ReadMark | null;
  readonly s2: ReadMark | null;
  readonly gapsMs: Readonly<Partial<Record<SendStep, number>>>;
  /** Named keys sent, in order. The probe character is written as `probe`; text writes are not keys. */
  readonly keys: readonly string[];
  readonly outcome: SendOutcome;
  readonly reason?: SendReason;
  /** Set on the `unconfirmed` refusal the cap adds, so the list can tell it from a plain one: the count, the limit and the harness and version it counted. */
  readonly cap?: SendCap;
  /**
   * Set on a `sent` that went in while the turn ran: the harness queued it for after the turn (its
   * profile says Enter queues while running). Absent on every other receipt.
   */
  readonly queued?: true;
  /**
   * Set later on a `queued` or `steered` receipt whose text came back: the harness put it back into its
   * input box (a Stop ended the turn and the harness returned its queue and its steers to the box), and
   * it never became a prompt. The receipt keeps its outcome and `queued`, which were true when it
   * settled; this says what happened after (ADR 0122). Absent on every other receipt.
   */
  readonly late?: SendLate;
  /**
   * Set on a send a program session took (M56 spec 14): the request id the program acknowledged.
   * The driver passes the request id to the program unchanged, so it equals `requestId`. Absent on
   * every send into a screen.
   */
  readonly acknowledged?: string;
  /**
   * Set on a refusal: the bridge's own line for it, the fixed sentence the phone was shown, cut to
   * {@link RECEIPT_DETAIL_MAX} characters. Set on a `typed_not_submitted` too: the rule that kept
   * Enter back (2026-10-17). Never the person's text and never a screen row.
   */
  readonly detail?: string;
  /**
   * Set on a refusal or a `typed_not_submitted` when the bridge had a read: the Surface it ended on, as
   * words. No rows. Set on every receipt of a blind send on a pane with no profile, with the reason
   * `no-profile`: nothing was read.
   */
  readonly saw?: SurfaceWords;
}

/** What may happen to a settled receipt later (see {@link SendReceipt.late}). One word today. */
export const SEND_LATES = ["returned"] as const;

/**
 * The receipt detail when Discard on a returned queued card (ADR 0122) found the box changed: nothing
 * was pressed and only the card went. The bridge writes it; the phone reads it to say so in its own words.
 */
export const RETURNED_CARD_DROPPED = "The box no longer holds this message. Collie removed its card and pressed nothing.";
export type SendLate = (typeof SEND_LATES)[number];

/** The longest {@link SendReceipt.detail} a receipt keeps. */
export const RECEIPT_DETAIL_MAX = 240;

/**
 * Why a receipt's words say unknown: a Surface's own reason, or `no-profile` on a send that went in
 * blind on a pane with no profile (a bare shell, a program), where the bridge read nothing.
 */
export type SawReason = SurfaceReason | "no-profile";

/** A Surface as four words, for a receipt: what the bridge saw, without an ask's labels. */
export interface SurfaceWords {
  readonly turn: Surface["turn"];
  readonly modal: "none" | "ask" | "unreadable" | "unknown";
  readonly composer: Surface["composer"];
  readonly reason?: SawReason;
}

const WORD_TURNS = ["idle", "running", "unknown"] as const satisfies readonly SurfaceWords["turn"][];
const WORD_MODALS = ["none", "ask", "unreadable", "unknown"] as const satisfies readonly SurfaceWords["modal"][];
const WORD_COMPOSERS = ["empty", "draft", "unreachable", "unknown"] as const satisfies readonly SurfaceWords["composer"][];
const WORD_REASONS = ["no-match", "contested", "stale", "torn", "no-profile"] as const satisfies readonly SawReason[];

/** {@link SurfaceWords} read back from JSON, every word checked; null when it is not one. */
export function readSurfaceWords(value: JsonValue | undefined): SurfaceWords | null {
  const node = asJsonObject(value);
  if (node === undefined) return null;
  const turn = WORD_TURNS.find((word) => word === node.turn);
  const modal = WORD_MODALS.find((word) => word === node.modal);
  const composer = WORD_COMPOSERS.find((word) => word === node.composer);
  if (turn === undefined || modal === undefined || composer === undefined) return null;
  if (node.reason === undefined) return { turn, modal, composer };
  const reason = WORD_REASONS.find((word) => word === node.reason);
  return reason === undefined ? null : { turn, modal, composer, reason };
}

/** The words of a Surface (see {@link SurfaceWords}). */
export function surfaceWords(surface: Surface): SurfaceWords {
  const words = { turn: surface.turn, modal: modalWord(surface.modal), composer: surface.composer };
  return surface.reason === undefined ? words : { ...words, reason: surface.reason };
}

/**
 * One row of a pane's recent sends, for the session page (M56 spec 09): the receipt's outcome, reason,
 * time, keys by name and measured gaps, and the text as the one line the bridge kept of it, when it
 * kept one. No hash of the text and no screen row: a receipt is shown the way it is stored.
 */
export interface SendReceiptRow {
  readonly requestId: string;
  /** When the bridge accepted the request, epoch ms. */
  readonly at: number;
  readonly mode: SendMode;
  readonly outcome: SendOutcome;
  readonly reason?: SendReason;
  readonly keys: readonly string[];
  readonly gapsMs: Readonly<Partial<Record<SendStep, number>>>;
  readonly harness: string;
  readonly version: string | null;
  /**
   * The reader profile the bridge used for this send and its status, when it had one (ADR 0123: the
   * setup block of a report names them). Absent on a pane with no profile and from a bridge before 1.24.1.
   */
  readonly profileId?: string;
  readonly profileStatus?: ProfileStatus;
  /** The cap's numbers, on the cap's refusal only (see {@link SendReceipt.cap}). */
  readonly cap?: SendCap;
  /** Set when the send was queued behind a running turn (see {@link SendReceipt.queued}). */
  readonly queued?: true;
  /** Set when a queued send came back to the box and never became a prompt (see {@link SendReceipt.late}). */
  readonly late?: SendLate;
  /** The line of a refusal or a `typed_not_submitted` (see {@link SendReceipt.detail}). */
  readonly detail?: string;
  /** What the bridge saw at that end, four words (see {@link SendReceipt.saw}). */
  readonly saw?: SurfaceWords;
  /**
   * The text that was sent, as the one line the bridge keeps when Sent's own rule would keep it
   * (`bridge/secret-line.ts`): absent for a text that looked like a secret, ran over several lines or
   * was too long. The row prints it so ten rows can be told apart; it is never searched.
   */
  readonly line?: string;
}

/** Where a held request stands (M56 spec 15): waiting, going out now, or closed with its text kept. */
export type HeldState = "held" | "running" | "ended";

/**
 * One held request as the pane's snapshot carries it (M56 spec 15), oldest first: the composer draws a
 * queued row for each, with the text and Cancel. An `ended` row closed without reaching the agent
 * (`expired`, `refused`, `typed_not_submitted`, `unknown`); its text stays for a Resend until the
 * person dismisses it. A request that went out, or that the person cancelled, has no row.
 */
/**
 * What holds a held request now: the refusal it was held from (a running turn, something open at the
 * box, a box that did not read twice the same in time, a probe that found the box not free, a draft).
 * The phone picks the row's sentence by it.
 */
export const HELD_CAUSES = ["turn_running", "not_free", "bound", "draft_present", "probe_failed"] as const;
export type HeldCause = (typeof HELD_CAUSES)[number];

export interface HeldRow {
  readonly requestId: string;
  readonly mode: SendMode;
  readonly text: string;
  /** When the bridge held it, epoch ms. */
  readonly heldAt: number;
  /** When it ends `expired` if the pane never reads free, epoch ms. */
  readonly expiresAt: number;
  readonly state: HeldState;
  /** On an `ended` row: how it closed. */
  readonly outcome?: SendOutcome;
  readonly reason?: SendReason;
  /** What holds it ({@link HeldCause}); absent on a row a bridge before 1.24.1 held. */
  readonly cause?: HeldCause;
  /**
   * Held for a running turn only because Collie could not read the harness's version (#594): the
   * profile would take a message in a turn, but not on a version it cannot name. `collie doctor` says why.
   */
  readonly versionUnread?: true;
}

/** What `DELETE /api/send/<id>` answers (M56 spec 15): a held request cancelled, or an ended row dismissed. */
export interface HeldCancelAnswer {
  /** `cancelled` for a request that was still held, `dismissed` for an ended row, `refused` when it runs now. */
  readonly result: "cancelled" | "dismissed" | "refused";
  /** On `refused`: `busy`, the request is going out now. */
  readonly reason?: SendReason;
  /** On `refused`: the request already went out, and this is its stored receipt (outcome and reason only). */
  readonly receipt?: HeldCancelReceipt;
}

/** What the phone reads of the stored receipt a refused cancel carries. */
export interface HeldCancelReceipt {
  readonly outcome: SendOutcome;
  readonly reason?: SendReason;
}

/** What `GET /api/send/receipts` answers: the newest first. */
export interface SendReceiptsAnswer {
  readonly receipts: readonly SendReceiptRow[];
}

/** What `POST /api/send` answers. A `prepare` has no receipt; every other request has one. */
export interface SendAnswer {
  readonly receipt?: SendReceipt;
  /** The Surface of the newest read, when the answer is about the screen (a refusal, a prepare). */
  readonly surface?: Surface;
  readonly offers: readonly SendOffer[];
  /** The hash of the rows, for the commit tap after `prepare` or `unconfirmed`. */
  readonly rowsHash?: string;
  /** A sentence for the person: which verb route a reserved lead belongs to, or what moved. */
  readonly detail?: string;
  /** True when the same id came back and this is the stored receipt. */
  readonly replayed?: boolean;
  /** Set on the `unconfirmed` refusal the cap adds: the commit needs one more confirm (`capAck`). */
  readonly cap?: SendCap;
  /** Which rule decided the answer, when the reason alone does not say it. Optional: an older phone
   *  reads the reason and its own sentence for it. */
  readonly cause?: SendCause;
}

/**
 * The rules an answer may name beside its reason. `notice_key`: the send's whole text is one of the
 * keys a notice above the box printed, which a box holding it alone would answer. `stale_screen`: the
 * input box on the screen does not take keys (a probe character landed elsewhere or nowhere) and a
 * second S0 read showed the same rows, so the screen is a stale image (2026-10-25).
 */
export const SEND_CAUSES = ["notice_key", "stale_screen"] as const;
export type SendCause = (typeof SEND_CAUSES)[number];

/**
 * The bridge's line for a `stale_screen` refusal (2026-10-25). The phone says it in its own words; a
 * line that adds to it (a probe character that may remain in the box) gets its own sentence too.
 */
export const STALE_SCREEN = "The screen shows an input box that does not take keys. The pane may need a redraw; focus it on the desktop or resize it.";

/**
 * The offers that go with an outcome and reason. A pane with no frame cannot prove a draft, so it gets the key pad instead.
 * A command onto a draft (`command`) is offered Replace and Cancel only: Add would send the draft with the command at its end.
 */
export function offersFor(outcome: SendOutcome, reason: SendReason | undefined, framed: boolean, command = false): SendOffer[] {
  if (outcome === "refused" && reason === "draft_present") return framed ? (command ? ["replace", "cancel"] : ["append", "replace", "cancel"]) : ["keys"];
  if (outcome === "refused" && reason === "unconfirmed") return ["commit", "keys"];
  // Every reason: the person reads the screen and decides; with no frame the bridge binds both to the rows hash.
  if (outcome === "typed_not_submitted") return ["submit", "discard", "keys"];
  if (outcome === "refused" || outcome === "unknown") return ["keys"];
  return [];
}

/** A request id the bridge accepts: letters, digits, `-` and `_`, 8 to 64 of them. It names a file. */
export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The paste-end sequence a pasted chunk must never carry. */
const PASTE_END = "\u001b[201~";
const PASTE_START = "\u001b[200~";

/** Whether a character is not a control byte: not C0 (below U+0020), not DEL, not C1 (U+0080 to U+009F). */
function printable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && (code < 0x7f || code > 0x9f);
}

/**
 * The text as the lines it will be written as. Line breaks split it (each later line is preceded by
 * the profile's newline key), the paste markers are cut, a Tab becomes one space, and every other
 * control byte (C0, DEL, C1) is dropped. Trailing blank lines are dropped; a line in between stays,
 * even empty, because the person typed it.
 */
export function sendLines(text: string): string[] {
  const cut = text.split(PASTE_END).join("").split(PASTE_START).join("");
  const lines = cut.split(/\r\n|\r|\n/u).map((line) => [...line.replace(/\t/gu, " ")].filter(printable).join(""));
  while (lines.length > 1 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
  return lines;
}

/**
 * The first word of a text is a file the bridge saved from an upload: an absolute path whose last two
 * segments are `uploads/<pane>-<base36 time>-<8 hex>.<ext>` (the name `bridge/server.ts` gives it).
 * Pure and shape only, so the phone and the bridge agree and neither touches the disk. A real command
 * name never holds a second slash.
 */
export function startsWithUploadPath(text: string): boolean {
  const word = text.trimStart().split(/\s/u, 1)[0] ?? "";
  return /^\/(?:[^/]+\/)*uploads\/[A-Za-z0-9_-]+-[a-z0-9]+-[0-9a-f]{8}\.[A-Za-z0-9]+$/u.test(word);
}

/**
 * The reserved lead a text starts with (after leading blanks), or null. A text whose first word is
 * the path of a saved upload (a screenshot sent with no words) starts with `/` but is no command.
 */
export function reservedLead(text: string, leads: readonly string[]): string | null {
  const head = text.trimStart();
  const lead = leads.find((candidate) => head.startsWith(candidate)) ?? null;
  return lead === "/" && startsWithUploadPath(head) ? null : lead;
}

/** The text with every white-space character removed: the compare form for wrapped rows. */
export function wsFree(text: string): string {
  return text.replace(/\s+/gu, "");
}
