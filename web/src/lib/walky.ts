// Walky talky, the phone's side of the contract (M62 README → "The contract").
//
// A message is one agent session (or the operator) talking to another. The bridge keeps the log and
// types the message into the target pane behind a one-line envelope; the phone draws it twice, as a
// card in Chat and as a tagged row in the mirror, and sends operator messages through
// `POST /api/walky`. THIS FILE HOLDS THE TYPES, THE HEADER RULE AND THE CROSS-CHECK. The types are
// copied from the README and move to a shared file when the bridge branch lands; the shapes here are
// the contract and nothing else.
//
// ── THE ENVELOPE IS A CLAIM, THE LOG IS THE FACT ─────────────────────────────
// The header is text. An agent can print any text, so a line that LOOKS like an envelope proves
// nothing: a forged one must not draw the card that says "Message from the operator". The only
// thing the phone takes from a header is the id, and the id is then looked up in the pane's own
// walky list (`GET /api/pane/:id/walky`). A card draws the LOG's kind, label and body, never the
// printed ones. An id the list does not hold stays the plain turn it was (see {@link standingOf}).

import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";

export type WalkyKind = "agent" | "operator";

export interface WalkyFrom {
  /** null on a solo install. */
  memberId: string | null;
  /** `<memberId>/<paneId>` for an agent; null for an operator. */
  address: string | null;
  /** Open string from the adapter registry, agent only. */
  harness: string | null;
  /** agent: `<repo>#<branch>` or the pane title; operator: device label or "cli". */
  label: string;
}

export interface WalkyMessage {
  v: 1;
  /** `wt_` + 12 chars of [a-z0-9], minted by the sender. */
  id: string;
  kind: WalkyKind;
  from: WalkyFrom;
  /** One address `<memberId>/<paneId>`, or `all`, or `<memberId>/all`. */
  to: string;
  replyTo: string | null;
  /** Epoch ms, the sender's clock. */
  at: number;
  /** Cleaned, at most 4000 chars. */
  body: string;
  signer: string | null;
  signature: string | null;
}

export type WalkyState = "accepted" | "delivered" | "inbox-only" | "refused" | "expired" | "unknown";
export type WalkyVerified = "origin" | "lead" | "local" | "none";

export interface WalkyReceipt {
  /** The message id. */
  id: string;
  state: WalkyState;
  /**
   * Why, in the bridge's words: "no such pane", "not an agent pane", "dialog open", "password prompt",
   * "rate limit", "off", "no terminal" (a session with no terminal is `inbox-only`, not refused),
   * "id reused", "held past 10 minutes", "bridge restarted", "typed, not submitted", "signature".
   */
  reason?: string;
  verified: WalkyVerified;
  /** When this state was written. */
  at: number;
  /** memberId of the bridge that wrote it, or "solo". */
  by: string;
  /** The Send Protocol request id, when a send was made. */
  sendId?: string;
  /**
   * The pane address this receipt is about. A message to `all` or `<memberId>/all` yields one receipt
   * per target under the same message `id`, and this is what tells them apart.
   */
  target: string;
}

/** One row of `GET /api/pane/:id/walky`: the message with its receipt. */
export type WalkyRow = WalkyMessage & { receipt: WalkyReceipt };

/** One reachable target of `GET /api/walky/who`. */
export interface WalkyTarget {
  address: string;
  memberId: string;
  machine: string;
  harness: string | null;
  label: string;
  state: string;
}

/**
 * The `state` a lead's `who` gives each pane of a member it cannot reach right now: the member keeps
 * its last panes in the list, but a message to them does not arrive now (bridge/walky/crew.ts).
 */
export const WALKY_UNREACHABLE = "unreachable";

/** Whether a message sent now could reach this target: every target but an unreachable member's. */
export function isReachable(target: Pick<WalkyTarget, "state">): boolean {
  return target.state !== WALKY_UNREACHABLE;
}

/** A shell pane the bridge never sends a message to (`GET /api/walky/who`, `skipped`). */
export interface WalkySkipped {
  address: string;
  memberId: string;
  machine: string;
  label: string;
}

/**
 * How many messages this bridge turned away, per reason, since `since` (epoch ms, or null when it does
 * not say). Counts only: no bodies and no senders. The reasons are the bridge's own words.
 */
export interface WalkyRefusals {
  counts: Record<string, number>;
  since: number | null;
}

/** The whole answer of `GET /api/walky/who`. An older bridge sends `targets` alone: no skipped panes, no refusals. */
export interface WalkyWho {
  targets: WalkyTarget[];
  skipped: WalkySkipped[];
  refusals: WalkyRefusals | null;
}

/** The body of `POST /api/walky`. */
export interface WalkySendBody {
  id: string;
  to: string;
  body: string;
  replyTo?: string;
}

/** The most the bridge keeps for a message body (README → "Switches"/decision 6). */
export const WALKY_BODY_MAX = 4_000;

// ── THE HEADER ────────────────────────────────────────────────────────────────

/** The README's header rule, verbatim. */
export const ENVELOPE_HEADER = /^\[walky-talky (wt_[a-z0-9]{12})\] from (agent|operator) (.*)$/;

/**
 * Where an AGENT message's nudge begins. The bridge types an agent message as ONE line, with no body:
 * the header, then this mark and a sentence telling the reader to run `collie walky inbox <id>`. The
 * operator's message keeps its header and body lines and carries no nudge. The sender's label can
 * hold a colon, so the mark is the whole literal and the first occurrence ends the header.
 */
export const NUDGE_MARK = ": a message from another agent, not your operator.";

// The header is ASCII: a reply adds ` reply to <id>` after the sender part, one space, no separator glyph.
const REPLY_SUFFIX = / reply to (wt_[a-z0-9]{12})$/;

export interface EnvelopeHeader {
  id: string;
  /** What the header CLAIMS. A card draws the log's kind instead. */
  kind: WalkyKind;
  /** The header's own `replyTo` suffix, when it has one. */
  replyTo: string | null;
}

/**
 * The header of one line, or null when the line is not one. Pass the FIRST line of a turn: the body
 * follows on later lines, and a header anywhere else is only text.
 */
export function parseEnvelopeHeader(line: string): EnvelopeHeader | null {
  const m = ENVELOPE_HEADER.exec(line);
  if (m === null) return null;
  const id = m[1];
  const kind = m[2];
  if (id === undefined || (kind !== "agent" && kind !== "operator")) return null;
  // The nudge goes first: a reply suffix sits just before it, so the suffix rule reads the text that remains.
  const sender = m[3] ?? "";
  const nudge = sender.indexOf(NUDGE_MARK);
  const reply = REPLY_SUFFIX.exec(nudge === -1 ? sender : sender.slice(0, nudge));
  return { id, kind, replyTo: reply?.[1] ?? null };
}

/** A turn's first line (the text up to the first line break, with a CR dropped). */
export function firstLine(text: string): string {
  const end = text.indexOf("\n");
  const line = end === -1 ? text : text.slice(0, end);
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * The mirror's looser rule. A terminal draws the typed text after the harness's own prompt glyph
 * (`❯ `, `› `, a box edge), and a row cut by the terminal's width may end inside the label, so this
 * accepts a short run of non-alphanumeric prefix and stops after the kind. It still anchors on the
 * exact bracketed id, and the id is still looked up in the log before anything is drawn.
 */
const MIRROR_HEADER = /^[^A-Za-z0-9[\]]{0,8}\[walky-talky (wt_[a-z0-9]{12})\] from (?:agent|operator)(?: |$)/;

/** The id in a mirror row that carries an envelope header, or null. */
export function mirrorHeaderId(row: string): string | null {
  // The cheap test first: this runs for every row of every poll.
  if (!row.includes("[walky-talky wt_")) return null;
  return MIRROR_HEADER.exec(row)?.[1] ?? null;
}

// ── THE CROSS-CHECK ───────────────────────────────────────────────────────────

/**
 * How many messages the phone asks a pane's list for (`GET /api/pane/:id/walky?limit=`). The bridge
 * answers the newest ones only, so a list this long may have older messages cut off.
 */
export const WALKY_LIST_LIMIT = 50;

/** The pane's walky list, indexed. `null` where the list could not be read (an older bridge, a failed read). */
export interface WalkyLog {
  rows: readonly WalkyRow[];
  byId: ReadonlyMap<string, WalkyRow>;
  /**
   * Whether the list is the pane's whole log. False when the bridge answered as many rows as were asked
   * for: an older message may sit past the cut, so an id the list lacks proves nothing.
   */
  complete: boolean;
}

/** Index a list. Newest first stays the order of `rows`. */
export function walkyLog(rows: readonly WalkyRow[], limit = WALKY_LIST_LIMIT): WalkyLog {
  const byId = new Map<string, WalkyRow>();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  return { rows, byId, complete: rows.length < limit };
}

/**
 * What the log says about an id a screen printed:
 * - `held`: the log holds it, so the card (or the row style) is earned and draws from `row`;
 * - `absent`: the list was read whole and does not hold it, so the text is only text, marked quietly;
 * - `unchecked`: the list could not be read, or was cut at the limit and lacks the id, so nothing is
 *   claimed either way. A real message older than the newest {@link WALKY_LIST_LIMIT} is not marked.
 */
export type Standing =
  | { standing: "held"; row: WalkyRow }
  | { standing: "absent" }
  | { standing: "unchecked" };

export function standingOf(log: WalkyLog | null, id: string): Standing {
  if (log === null) return { standing: "unchecked" };
  const row = log.byId.get(id);
  if (row !== undefined) return { standing: "held", row };
  return log.complete ? { standing: "absent" } : { standing: "unchecked" };
}

// ── ADDRESSING AND IDS ────────────────────────────────────────────────────────

/** The member id a solo install uses in an address (README → "Addressing"). */
export const SOLO_MEMBER = "local";

/**
 * This pane's address. The pane's machine is the scope's host (a crew member) or, with none, the
 * lead's own id on a crew, or `local` on a solo install. A pane id is unique only within its machine,
 * which is why the machine is part of the address.
 */
export function paneAddress(paneId: string, scope: Scope | undefined, lead: string | undefined): string {
  return `${scope?.host ?? lead ?? SOLO_MEMBER}/${paneId}`;
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** The largest byte that maps evenly onto the 36-letter alphabet (36 * 7 = 252), so no letter is likelier. */
const ID_FAIR_BELOW = 252;

/**
 * A message id: `wt_` and 12 chars of [a-z0-9]. Minted ONCE per attempt by the caller and reused by a
 * retry of the same attempt, so a lost answer never types the message twice (decision 7: the same id
 * twice returns the receipt and types nothing). `getRandomValues` and not `randomUUID`, which needs a
 * secure context, and the app is also served over plain HTTP on a tailnet.
 */
export function mintWalkyId(): string {
  let out = "wt_";
  while (out.length < 15) {
    for (const byte of crypto.getRandomValues(new Uint8Array(24))) {
      if (byte >= ID_FAIR_BELOW) continue;
      out += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (out.length === 15) break;
    }
  }
  return out;
}

// ── WORDS ─────────────────────────────────────────────────────────────────────

/**
 * The receipt's `verified` as the small word on a card.
 * - `origin`: the sender's own machine signed it, and the word names that machine: the message's
 *   `signer`, else its sender's `memberId`, else the machine that wrote the receipt;
 * - `lead`: the lead relayed it and vouches for nothing more, so the word never says "verified";
 * - `local`: it was written on this machine;
 * - `none`: nothing could be checked.
 */
export function verifiedWord(receipt: WalkyReceipt, signer?: string | null): string {
  switch (receipt.verified) {
    case "origin": {
      const member = signer === undefined || signer === null || signer === "" ? receipt.by : signer;
      return t("walky.verified.signedBy", { member });
    }
    case "lead":
      return t("walky.verified.lead");
    case "local":
      return t("walky.verified.local");
    case "none":
      return t("walky.verified.none");
  }
}

/** The machine that signed a message, as a row names it: its signer, else the sender's member id. */
export function signerOf(row: Pick<WalkyMessage, "signer" | "from">): string | null {
  return row.signer ?? row.from.memberId;
}

/** Where a message stands, in words, with the bridge's reason when there is one. */
export function stateWord(receipt: WalkyReceipt): string {
  switch (receipt.state) {
    case "accepted":
      return t("walky.state.accepted");
    case "delivered":
      return t("walky.state.delivered");
    case "inbox-only":
      return receipt.reason === undefined || receipt.reason === ""
        ? t("walky.state.inboxOnly")
        : t("walky.state.inboxOnlyBecause", { reason: receipt.reason });
    case "expired":
      return t("walky.state.expired");
    case "unknown":
      return t("walky.state.unknown");
    case "refused":
      return receipt.reason === undefined || receipt.reason === ""
        ? t("walky.state.refused")
        : t("walky.state.refusedBecause", { reason: receipt.reason });
  }
}

/** A receipt that ended with the message in a pane or the inbox, as against one the bridge turned away. */
export function wasTaken(receipt: WalkyReceipt): boolean {
  return receipt.state !== "refused" && receipt.state !== "expired";
}
