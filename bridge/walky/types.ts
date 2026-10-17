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

/** Who typed a message: an agent inside a pane, or the operator (a paired phone, or the CLI outside a pane). */
export type WalkyKind = "agent" | "operator";

export interface WalkySender {
  /** Null on a solo install. */
  readonly memberId: string | null;
  /** `<memberId>/<paneId>` for an agent; null for an operator. */
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
  /** One address `<memberId>/<paneId>`, or `all`, or `<memberId>/all`. */
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

export type WalkyVerified = "origin" | "lead" | "local" | "none";

export interface WalkyReceipt {
  /** The message id. */
  readonly id: string;
  /**
   * The address this receipt is for. A message to one pane has one receipt; a message to `all` or
   * `<memberId>/all` has one per target pane, all under the same message id. Added to the README's
   * contract by spec 01, since a fan-out needs one receipt per pane.
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
 * the lead keeps that outcome and has no way to tell the member (CREW_PROTOCOL §21).
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
  const label = headerField(message.from.label);
  const who =
    message.kind === "agent"
      ? `${headerField(message.from.address ?? "-", 160)} (${message.from.harness === null ? label : `${headerField(message.from.harness, 32)}, ${label}`})`
      : `(${label})`;
  const reply = message.replyTo === null ? "" : ` reply to ${message.replyTo}`;
  return `[walky-talky ${message.id}] from ${message.kind} ${who}${reply}`;
}

/** What the target pane receives: the header line, then the body as is. */
export function formatEnvelope(message: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo" | "body">): string {
  return `${formatHeader(message)}\n${message.body}`;
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
  const rest = match[3]!;
  const reply = REPLY_SUFFIX_RE.exec(rest);
  const kind: WalkyKind = match[2] === "agent" ? "agent" : "operator";
  return { id: match[1]!, kind, sender: reply === null ? rest : rest.slice(0, reply.index), replyTo: reply === null ? null : reply[1]! };
}
