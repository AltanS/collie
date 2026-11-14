// Walky talky (M62): messages between agent sessions, and from the operator to a session. The
// contract is the M62 README, "The contract". This module holds the wire shapes and the one-line
// envelope header a target pane receives. Pure: no file, no socket, no clock.
//
// No harness name lives under bridge/walky/ (no-harness-names.test.ts scans this folder). A
// message names its sender's harness as an open string from the adapter registry.

import type { WalkySpace } from "./space.ts";
import { cleanSubject, isCleanSubject, lineField, readHeaderPart, WALKY_SUBJECT_MAX, WALKY_SUBJECT_WORDS } from "../../web/src/lib/walky-subject.ts";
import { randomBytes } from "node:crypto";

/** The wire version of a message. */
export const WALKY_VERSION = 1;

/** A message id: `wt_` and 12 characters of [a-z0-9]. It names a log entry, never a file. */
export const WALKY_ID = /^wt_[a-z0-9]{12}$/u;

/** The body cap, in characters (code points). */
export const WALKY_BODY_MAX = 4000;

/** The longest sender label a message carries, and the longest harness name (CREW_PROTOCOL §21). */
export const WALKY_LABEL_MAX = 48;
export const WALKY_HARNESS_MAX = 32;

/** Who typed a message: an agent inside a pane, or the operator (a paired phone, or the CLI outside a pane). */
export type WalkyKind = "agent" | "operator";

export interface WalkySender {
  /** Null on a solo install. */
  readonly memberId: string | null;
  /** `<memberId>/<paneId>#<token>` for an agent, its pane's instance (address.ts); null for an operator. */
  readonly address: string | null;
  /** An open string from the adapter registry, agent only. */
  readonly harness: string | null;
  /** Display data, not signed. Agent: `<repo>#<branch>` or the pane title; operator: device label or `cli`. */
  readonly label: string;
  /**
   * The space the message comes from (M98, space.ts): the sending pane's for an agent, null for an
   * operator. Its key is signed when it is an object (canonical.ts), so a crew hop cannot change it, and
   * an unnamed key names the signer's own machine (crew.ts `checkCrewMessage`). Absent on a message
   * from a bridge before 1.29.0 (`SPACE_FIRST_VERSION`, crew.ts), whose canonical string has no space line.
   */
  readonly space?: WalkySpace | null;
}

export interface WalkyMessage {
  readonly v: 1;
  readonly id: string;
  readonly kind: WalkyKind;
  readonly from: WalkySender;
  /** One address `<memberId>/<paneId>`, with or without `#<token>`, or `all`, or `<memberId>/all`. */
  readonly to: string;
  readonly replyTo: string | null;
  /** Epoch ms, the sender's clock. */
  readonly at: number;
  /** Cleaned, at most {@link WALKY_BODY_MAX} characters. */
  readonly body: string;
  /**
   * True when the sender asked a fan-out (a scope, `all`, `<member>/all`) to type into resting panes too
   * (M85). Absent otherwise: a message without it is the message every older bridge knows. Signed when
   * present (canonical.ts), so a crew hop cannot add or drop it.
   */
  readonly wake?: true;
  /**
   * True when the sender said the message may leave its space (M98, the outside flag). Absent otherwise,
   * which is every message an older bridge knows. Signed when present (canonical.ts), as `wake` is.
   */
  readonly outside?: true;
  /**
   * What the message is about, in the sender's own words (M98 spec 07): at most
   * {@link WALKY_SUBJECT_WORDS} words and {@link WALKY_SUBJECT_MAX} characters, already in the form
   * {@link cleanSubject} gives. Absent when the sender gave none, which is every message an older bridge
   * knows. Signed when present (canonical.ts), so a crew hop cannot add, change or drop it.
   */
  readonly subject?: string;
  /** The member id whose key made `signature`; null when unsigned (solo). */
  readonly signer: string | null;
  /** Base64 ECDSA P-256 SHA-256 over the canonical string (canonical.ts). */
  readonly signature: string | null;
}

export const RECEIPT_STATES = ["accepted", "delivered", "inbox-only", "refused", "expired", "unknown"] as const;
export type WalkyReceiptState = (typeof RECEIPT_STATES)[number];

/**
 * How far a receipt has come: `accepted`, then `unknown`, then a finished state (`delivered`,
 * `inbox-only`, `refused`, `expired`). A finished state is never replaced (CREW_PROTOCOL §21, added
 * 2026-10-18), so a late answer or a slow leg cannot move an outcome backwards.
 */
export function stateRank(state: WalkyReceiptState): 0 | 1 | 2 {
  if (state === "accepted") return 0;
  return state === "unknown" ? 1 : 2;
}

/**
 * Whether `next` may replace `held` when it comes from another machine (a member's report, the lead's
 * push): never over a finished state, never backwards, and a repeat of the same state only when newer,
 * or of the same millisecond when it adds a reason the held one lacks. A held send (M62 spec 02) is
 * `accepted` with a reason, and the member can write it in the millisecond it wrote the bare
 * `accepted` the dial answered with: a second message to a pane that already holds one is held at
 * once. Field case 2026-10-22 (browser leg case 21, message 3 of six): both at 1792620803859, so the
 * lead skipped the report and `collie walky send` printed a bare `accepted`. A resend of the same
 * receipt still writes nothing: the held one has the reason then.
 */
export function movesForward(held: WalkyReceipt, next: WalkyReceipt): boolean {
  const from = stateRank(held.state);
  const to = stateRank(next.state);
  if (from === 2 || to < from) return false;
  if (next.state !== held.state || next.at > held.at) return true;
  return next.at === held.at && held.reason === undefined && next.reason !== undefined;
}

/** The reason of a fan-out message left in the inbox of a pane that rests (M85). */
export const RESTING = "resting";

/** The reason of an agent's message to a session that turned its walky talky off (M89, off.ts). */
export const WALKY_OFF = "walky talky off";
/** The reason of a message from an agent whose own pane turned its walky talky off (M89). */
export const SENDER_OFF = "your walky talky is off";

/** The longest receipt `reason` read or written (CREW_PROTOCOL §21, added 2026-10-18). */
export const RECEIPT_REASON_MAX = 120;

/** A Send Protocol request id as `sendIdOf` (deliver.ts) makes one: the message id and 8 hex characters. */
export const SEND_ID = /^wt_[a-z0-9]{12}-[0-9a-f]{8}$/u;

/** Whether every character is printable ASCII, 0x20 to 0x7e: no escape, no line break, no tab. */
export function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * A reason this bridge writes, in the form every reader keeps: each character outside printable ASCII
 * becomes a space, runs of spaces become one, and the text is cut to {@link RECEIPT_REASON_MAX}.
 * Undefined when nothing is left. An error text from a dial or another machine goes through here.
 */
export function receiptReason(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let out = "";
  for (const ch of raw) out += isPrintableAscii(ch) ? ch : " ";
  const clean = out.replace(/ {2,}/gu, " ").trim().slice(0, RECEIPT_REASON_MAX).trimEnd();
  return clean === "" ? undefined : clean;
}

export type WalkyVerified = "origin" | "lead" | "local" | "none";

/**
 * How a message passed the space border on the bridge that owns its pane (M98, border.ts): in the
 * sender's space, a reply to a message that pane sent, by the sender's outside flag, as the operator's,
 * or as a message from a bridge before 1.29.0 that names no space.
 */
export const BORDER_VERDICTS = ["in", "reply", "outside", "operator", "legacy"] as const;
export type BorderVerdict = (typeof BORDER_VERDICTS)[number];

export interface WalkyReceipt {
  /** The message id. */
  readonly id: string;
  /**
   * The address this receipt is for. A message to one pane has one receipt; a message to `all` or
   * `<memberId>/all` has one per target pane, all under the same message id. Added to the README's
   * contract by spec 01, since a fan-out needs one receipt per pane. Never an instance token: a
   * receipt names `<memberId>/<paneId>`, so a lead's leg and a member's own receipt keep matching.
   */
  readonly target: string;
  readonly state: WalkyReceiptState;
  /** Set on `refused` and `inbox-only`: why the text was not typed. */
  readonly reason?: string;
  readonly verified: WalkyVerified;
  /** When this state was written. */
  readonly at: number;
  /** The member id of the bridge that wrote it, or `solo`. */
  readonly by: string;
  /** The Send Protocol request id, when a send was made. */
  readonly sendId?: string;
  /**
   * How the message passed the space border here (M98, {@link BorderVerdict}), on a receipt the bridge that
   * owns the pane wrote after the check. Absent on a refusal, and on every receipt from an older bridge.
   */
  readonly via?: BorderVerdict;
  /**
   * Deliver now (M99 spec 05, decision of 2026-11-13): the person chose to hand this message to the agent by
   * data while their own text stayed in the box. Only on `delivered` and `unknown`, and only `true`.
   */
  readonly overDraft?: true;
}

/**
 * What `collie walky status` says of a receipt still `accepted` on another machine, on a crew member:
 * the lead holds that outcome until it pushes it back to the member (CREW_PROTOCOL §21). An older
 * lead never pushes, and the receipt then stays `accepted` here.
 */
export const OUTCOME_ON_LEAD = "outcome known on the lead";

/** A message as the log and the phone list it: the message, the pane it went to and its newest receipt. */
export type WalkyEntry = WalkyMessage & {
  readonly receipt: WalkyReceipt;
  /**
   * Present only on a row ANOTHER Collie instance on this machine recorded (siblings.ts): the last
   * segment of its state dir, `collie` or `collie-next`. A row this bridge recorded has no field, and
   * an older member's answer has none either.
   */
  readonly recordedBy?: string;
  /**
   * With `recordedBy`: this pane's address in the recording instance's words, `<member>/<paneId>`.
   * Its member id and token are that instance's, so the phone reads the row's direction and machine
   * against this address, not against its own (web/src/lib/walky.ts `selfOf`).
   */
  readonly recordedAs?: string;
};

/** One reachable target, as `collie walky who` and `GET /api/walky/who` list it. */
export interface WalkyTarget {
  readonly address: string;
  readonly memberId: string;
  readonly machine: string;
  readonly harness: string | null;
  readonly label: string;
  readonly state: string;
  /** Present only when the session turned its walky talky off (M89). The owner machine enforces it; this only shows it. */
  readonly walky?: "off";
  /**
   * The pane's space and its key (M98, space.ts). On a row from a member below this version, computed
   * from the member's pane list with the default for `named`.
   */
  readonly space: WalkySpace;
  /**
   * The name a person gave the session (pane-name.ts `personName`): a Collie rename, a name set in the
   * harness, or a named one-pane tab, and which of the three in `nameBy`. Display data, at most
   * {@link WALKY_NAME_MAX} characters. Absent when nobody named it, and from a bridge before 1.29.0.
   */
  readonly name?: string;
  readonly nameBy?: "collie" | "harness" | "tab";
  /**
   * The title the agent gave its session in its own journal (types.ts `AgentView.agentTitle`). Absent
   * when the harness keeps none, when COLLIE_REDACT is on (it is the agent's text, so it stays off a
   * listing like the terminal title does), and from a bridge before 1.29.0.
   */
  readonly title?: string;
}

/** The longest session name or title a `who` row carries. The bridge already caps both at 80. */
export const WALKY_NAME_MAX = 120;

/** A shell pane, which never receives a message: a broadcast lists it as skipped. */
export interface WalkySkipped {
  readonly address: string;
  readonly memberId: string;
  readonly machine: string;
  readonly label: string;
  /**
   * Why a broadcast leaves the pane out: `shell`, a bare shell that never receives a message, or
   * `resting` (M85), an agent that finished and has been quiet for 15 minutes (`REST_MS`, deliver.ts); a broadcast keeps its
   * message in the inbox only unless the sender asks to wake it. Absent from an older bridge: a shell.
   */
  readonly reason?: "shell" | "resting";
}

/**
 * The header regex. Exactly one line, ASCII only. The rest after the kind is the sender's address
 * and its parenthesised harness and label, and ` reply to <id>` after the parenthesis on a reply.
 */
export const HEADER_RE = /^\[walky-talky (wt_[a-z0-9]{12})\] from (agent|operator) (.*)$/u;

/** The reply suffix: one space after the closing parenthesis, ASCII (M62 README, settled 2026-10-17). */
const REPLY_SUFFIX_RE = / reply to (wt_[a-z0-9]{12})$/u;

/** Mint a message id: `wt_` and 12 characters of [a-z0-9], from a uniform random source. */
export function mintWalkyId(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  // 252 is the largest multiple of 36 below 256: a byte at or above it is skipped, so no letter is likelier.
  while (out.length < 12) {
    for (const byte of random(16)) {
      if (byte >= 252) continue;
      out += alphabet[byte % 36];
      if (out.length === 12) break;
    }
  }
  return `wt_${out}`;
}

/**
 * A header field as the header may carry it: printable ASCII only, no brackets or parentheses (they
 * frame the fields), runs of blanks as one space, at most `max` characters. A field left empty is `-`.
 */
export function headerField(raw: string, max = 80): string {
  const ascii = [...raw]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code > 0x7e) return " ";
      return "()[]".includes(ch) ? " " : ch;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const cut = ascii.length > max ? ascii.slice(0, max).trimEnd() : ascii;
  return cut === "" ? "-" : cut;
}

/**
 * The word a header carries after the sender's parenthesis when the message passed the space border by
 * the sender's outside flag (M98, README decision 12): the sender is not of the receiver's space. It sits
 * before ` reply to <id>`, so a reader before 1.29.0 still finds the reply suffix at the end of the
 * sender part and the id and kind where they were: it reads the word as part of the sender's text.
 */
export const OUTSIDE_WORD = "outside";

// ── The subject (M98 spec 07) ─────────────────────────────────────────────────────────────────────
// The subject is the first text of another agent that lands in the receiver's input box. Its characters
// are an allow-list shared with the phone (web/src/lib/walky-subject.ts, which says why each is there).
// It sits in quotes before the nudge mark, and a reader finds it from the sender's last closing
// parenthesis, which no field after it can hold.

export { cleanSubject, isCleanSubject, WALKY_SUBJECT_MAX, WALKY_SUBJECT_WORDS };

/** The longest raw subject read at all: past it the send is refused before any cleaning. */
export const WALKY_SUBJECT_RAW_MAX = 1024;

/**
 * The reason a subject past a limit is refused with, at the CLI, the socket and `POST /api/walky`. A cut
 * subject can say something else, so it is never cut: the sender shortens it.
 */
export const SUBJECT_TOO_LONG = "subject over 6 words or 48 characters: shorten it";

/**
 * The reason a member gives when it leaves a subject out (M98 spec 07): its lead runs a release below
 * 1.29.0, which cannot verify a signed subject line, so the sender's bridge signs the message without it.
 */
export const SUBJECT_LEFT_OUT = "The subject was left out: the lead of this crew runs a Collie older than 1.29.0.";

/** A raw subject read: the clean subject, null for none, or the refusal. */
export type SubjectRead = { readonly subject: string | null } | { readonly error: string };

/**
 * A sender's raw subject, cleaned and checked: null (no subject) when absent or when cleaning leaves
 * nothing, {@link SUBJECT_TOO_LONG} past {@link WALKY_SUBJECT_WORDS} words or {@link WALKY_SUBJECT_MAX}
 * characters after cleaning, or past {@link WALKY_SUBJECT_RAW_MAX} characters before it.
 */
export function readSubject(raw: string | null | undefined): SubjectRead {
  if (raw === null || raw === undefined) return { subject: null };
  if (raw.length > WALKY_SUBJECT_RAW_MAX) return { error: SUBJECT_TOO_LONG };
  const clean = cleanSubject(raw);
  if (clean === "") return { subject: null };
  if (clean.length > WALKY_SUBJECT_MAX || clean.split(" ").length > WALKY_SUBJECT_WORDS) return { error: SUBJECT_TOO_LONG };
  return { subject: clean };
}

export { lineField };

/**
 * A message id as the typed line carries it. The log and a crew hop check ids before a message gets
 * here, and the formatter does not trust that: an id that is not {@link WALKY_ID} stands as one
 * {@link lineField} word, so it can never run at a shell prompt. Such a line matches no header rule, so
 * no reader takes it for a message.
 */
function lineId(id: string): string {
  return WALKY_ID.test(id) ? id : lineField(id, 32, true);
}

/**
 * The one header line of a message. `outside`: the message passed the border by the outside flag.
 *
 * The sender stands in words (fix/walky-line-fields): `from agent <address> on <harness> in "<label>"`,
 * without ` on <harness>` when the pane has no known harness, and `from operator "<label>"`. No value
 * stands where a shell runs a command or a substitution: the address and the harness are bare words of
 * {@link lineField}'s allow-list, the label sits in double quotes it cannot end. An older bridge types
 * `<address> (<harness>, <label>)`, and history holds it; the readers take both (`readHeaderPart`).
 *
 * The parts after the sender come in one order: ` outside`, then ` about "<subject>"`, then
 * ` reply to <id>`. The reply suffix stays last, so a reader before the subject (1.28.x, 1.29.0-edge.1)
 * still finds it at the end of the header part, and the id and kind where they always were. A subject
 * that is not clean (a log or a hop that bypassed the reader) is left out, never typed.
 */
export function formatHeader(message: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo" | "subject">, outside = false): string {
  const label = `"${lineField(message.from.label, WALKY_LABEL_MAX)}"`;
  const harness = message.from.harness === null ? "" : ` on ${lineField(message.from.harness, WALKY_HARNESS_MAX, true)}`;
  const who = message.kind === "agent" ? `${lineField(message.from.address ?? "-", 160, true)}${harness} in ${label}` : label;
  const mark = outside ? ` ${OUTSIDE_WORD}` : "";
  const about = message.subject !== undefined && isCleanSubject(message.subject) ? ` about "${message.subject}"` : "";
  // A reply id that is not WALKY_ID is left out: a reader takes the line as a plain message, as it does one with no reply.
  const reply = message.replyTo === null || !WALKY_ID.test(message.replyTo) ? "" : ` reply to ${message.replyTo}`;
  return `[walky-talky ${lineId(message.id)}] from ${message.kind} ${who}${mark}${about}${reply}`;
}

/**
 * What follows the header on the one line an agent's message types. It marks the end of the header
 * part, so a reader cuts it before the reply suffix (`parseEnvelopeHeader`). Its text never changes: the
 * readers of every release cut at it. No field before it can hold it: a subject holds no colon, the
 * address and the harness hold no space, and a label (48 characters) is shorter than the mark (50).
 */
export const NUDGE_MARK = ": a message from another agent, not your operator.";

/** The text after {@link NUDGE_MARK} on an agent's line: the one command that reads the body. */
export function nudgeTail(id: string): string {
  return ` Read it: collie walky inbox ${id}`;
}

/**
 * The one line an agent's message types into the target pane: the header, then a nudge that names
 * the command that reads it. No body. The body reaches the agent as a tool result (`collie walky inbox
 * <id>`), which a harness treats as data and not as its operator's words; that output ends with the reply
 * command, so the line does not carry it (M98 spec 07).
 */
export function formatNudge(message: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo" | "subject">, outside = false): string {
  return `${formatHeader(message, outside)}${NUDGE_MARK}${nudgeTail(lineId(message.id))}`;
}

/** The last line `collie walky inbox` prints for an agent's message: the command that answers it. */
export function replyLine(id: string): string {
  return `Reply: collie walky reply ${id} "<text>"`;
}

/**
 * Whether a body line could pass for a header: it matches the header regex, or it starts with
 * `[walky-talky`. Such a line gets one leading space (`escapeBody`), so no body can open a second
 * message on the screen.
 */
export function looksLikeHeader(line: string): boolean {
  return line.startsWith("[walky-talky") || HEADER_RE.test(line);
}

/** The body with one leading space before every line that could pass for a header. Idempotent. */
export function escapeBody(body: string): string {
  return body
    .split("\n")
    .map((line) => (looksLikeHeader(line) ? ` ${line}` : line))
    .join("\n");
}

/**
 * What the target pane receives. An agent's message: the one nudge line ({@link formatNudge}). An
 * operator's: the header line, then the body, every header-like line escaped. `via`: how the message
 * passed the space border here (M98); `outside` puts {@link OUTSIDE_WORD} in the header, and only an
 * agent's message ever passes that way.
 */
export function formatEnvelope(message: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo" | "body" | "subject">, via?: BorderVerdict): string {
  if (message.kind === "agent") return formatNudge(message, via === "outside");
  return formatRead(message, via);
}

/**
 * A message as `collie walky inbox` prints it: the header line, then the body (escaped). `via` is the
 * receipt's border verdict (M98): `outside` puts {@link OUTSIDE_WORD} in the header, as the envelope does.
 */
export function formatRead(message: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo" | "body" | "subject">, via?: BorderVerdict): string {
  return `${formatHeader(message, message.kind === "agent" && via === "outside")}\n${escapeBody(message.body)}`;
}

export interface ParsedHeader {
  readonly id: string;
  readonly kind: WalkyKind;
  /** The text after the kind up to the end of the sender (the label's closing quote, or the older form's closing parenthesis): the outside word, the subject and the reply suffix cut. */
  readonly sender: string;
  readonly replyTo: string | null;
  /** Present when the header carries {@link OUTSIDE_WORD} after the sender's parenthesis (M98). */
  readonly outside?: true;
  /** Present when the header carries ` about "<subject>"` (M98 spec 07): the subject, without its quotes. */
  readonly subject?: string;
}

/**
 * Read one line as a walky talky header, or null. A row that matches is only a claim: the log has the facts.
 *
 * The header part ends at the LAST {@link NUDGE_MARK}: the text after it is the bridge's fixed tail, and
 * no field before it can hold the mark. Within the header part `readHeaderPart` (web/src/lib/walky-subject.ts,
 * shared with the phone) reads the sender in words, or the older form anchored on the sender's last
 * closing parenthesis. A header part that fits neither keeps the oldest rule: the reply suffix at the
 * end, and the rest is the sender.
 */
export function parseEnvelopeHeader(line: string): ParsedHeader | null {
  const match = HEADER_RE.exec(line);
  if (match === null) return null;
  const full = match[3]!;
  const mark = full.lastIndexOf(NUDGE_MARK);
  const head = mark < 0 ? full : full.slice(0, mark);
  const id = match[1]!;
  const kind: WalkyKind = match[2] === "agent" ? "agent" : "operator";
  const part = readHeaderPart(head);
  if (part !== null) return { id, kind, ...part };
  const reply = REPLY_SUFFIX_RE.exec(head);
  return { id, kind, sender: reply === null ? head : head.slice(0, reply.index), replyTo: reply === null ? null : reply[1]! };
}
