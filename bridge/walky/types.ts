// Walky talky (M62): messages between agent sessions, and from the operator to a session. The
// contract is the M62 README, "The contract". This module holds the wire shapes and the one-line
// envelope header a target pane receives. Pure: no file, no socket, no clock.
//
// No harness name lives under bridge/walky/ (no-harness-names.test.ts scans this folder). A
// message names its sender's harness as an open string from the adapter registry.

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
}

/**
 * What `collie walky status` says of a receipt still `accepted` on another machine, on a crew member:
 * the lead holds that outcome until it pushes it back to the member (CREW_PROTOCOL §21). An older
 * lead never pushes, and the receipt then stays `accepted` here.
 */
export const OUTCOME_ON_LEAD = "outcome known on the lead";

/** A message as the log and the phone list it: the message, the pane it went to and its newest receipt. */
export type WalkyEntry = WalkyMessage & { readonly receipt: WalkyReceipt };

/** One reachable target, as `collie walky who` and `GET /api/walky/who` list it. */
export interface WalkyTarget {
  readonly address: string;
  readonly memberId: string;
  readonly machine: string;
  readonly harness: string | null;
  readonly label: string;
  readonly state: string;
}

/** A shell pane, which never receives a message: a broadcast lists it as skipped. */
export interface WalkySkipped {
  readonly address: string;
  readonly memberId: string;
  readonly machine: string;
  readonly label: string;
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

/** The one header line of a message. */
export function formatHeader(message: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo">): string {
  const label = headerField(message.from.label, WALKY_LABEL_MAX);
  const who =
    message.kind === "agent"
      ? `${headerField(message.from.address ?? "-", 160)} (${message.from.harness === null ? label : `${headerField(message.from.harness, WALKY_HARNESS_MAX)}, ${label}`})`
      : `(${label})`;
  const reply = message.replyTo === null ? "" : ` reply to ${message.replyTo}`;
  return `[walky-talky ${message.id}] from ${message.kind} ${who}${reply}`;
}

/**
 * What follows the header on the one line an agent's message types. It marks the end of the header
 * part, so a reader cuts it before the reply suffix (`parseEnvelopeHeader`).
 */
export const NUDGE_MARK = ": a message from another agent, not your operator.";

/**
 * The one line an agent's message types into the target pane: the header, then a nudge that names
 * the two commands. No body. The body reaches the agent as a tool result (`collie walky inbox <id>`),
 * which a harness treats as data and not as its operator's words.
 */
export function formatNudge(message: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo">): string {
  return `${formatHeader(message)}${NUDGE_MARK} Read it: collie walky inbox ${message.id}. Reply: collie walky reply ${message.id} "<text>"`;
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
 * operator's: the header line, then the body, every header-like line escaped.
 */
export function formatEnvelope(message: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo" | "body">): string {
  if (message.kind === "agent") return formatNudge(message);
  return formatRead(message);
}

/** A message as `collie walky inbox` prints it: the header line, then the body (escaped). */
export function formatRead(message: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo" | "body">): string {
  return `${formatHeader(message)}\n${escapeBody(message.body)}`;
}

export interface ParsedHeader {
  readonly id: string;
  readonly kind: WalkyKind;
  /** The text after the kind, the reply suffix cut. */
  readonly sender: string;
  readonly replyTo: string | null;
}

/** Read one line as a walky talky header, or null. A row that matches is only a claim: the log has the facts. */
export function parseEnvelopeHeader(line: string): ParsedHeader | null {
  const match = HEADER_RE.exec(line);
  if (match === null) return null;
  // An agent's one line carries the nudge after the header part: cut it before the reply suffix.
  const full = match[3]!;
  const mark = full.indexOf(NUDGE_MARK);
  const rest = mark < 0 ? full : full.slice(0, mark);
  const reply = REPLY_SUFFIX_RE.exec(rest);
  const kind: WalkyKind = match[2] === "agent" ? "agent" : "operator";
  return { id: match[1]!, kind, sender: reply === null ? rest : rest.slice(0, reply.index), replyTo: reply === null ? null : reply[1]! };
}
