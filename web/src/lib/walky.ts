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
   * Why, in the bridge's words: "no such pane", "not an agent pane", "pane busy", "box not free", "password prompt",
   * "rate limit", "off", "no terminal" (a session with no terminal is `inbox-only`, not refused),
   * "id reused", "held past 60 minutes", "bridge restarted", "typed, not submitted", "signature",
   * "pane replaced" (the address named a session instance and the pane now holds another).
   * On `accepted` it is a held message (M62 spec 02): "draft present" or "turn running". Collie types
   * it when the box clears or the turn ends, up to 60 minutes, so nobody sends it again.
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

// ── IDS IN TEXT, AND THE AGENT'S OWN COMMANDS ─────────────────────────────────
// Everything below is a CLAIM too: an id in prose, a `collie walky` line in a tool card and the first
// line of its output are all text an agent can print. They only choose WHERE to look; what a screen
// then draws comes from the log row (`standingOf`), and an id the log does not hold stays plain text.

/**
 * A message id inside running text. The lookarounds keep it from matching inside a longer word or
 * inside an id of another length (`wt_` and exactly 12 characters, no letter, digit or `_` either
 * side). Global: scan with {@link findWalkyIds}, not with `exec` on this object.
 */
export const WALKY_ID_IN_TEXT = /(?<![A-Za-z0-9_])wt_[a-z0-9]{12}(?![A-Za-z0-9_])/g;

/** One id found in a text, with where it sits. */
export interface WalkyIdHit {
  id: string;
  start: number;
  end: number;
}

/** Every message id in `text`, in order. The cheap test first: this runs for each text of a thread. */
export function findWalkyIds(text: string): WalkyIdHit[] {
  if (!text.includes("wt_")) return [];
  return [...text.matchAll(WALKY_ID_IN_TEXT)].map((m) => ({ id: m[0], start: m.index, end: m.index + m[0].length }));
}

/** A piece of a text: plain, or an id the caller asked about. */
export type WalkyTextPart = { kind: "text"; text: string } | { kind: "id"; id: string };

/**
 * `text` cut at the ids that `held` accepts. An id `held` refuses stays inside the text around it, so a
 * run with no held id comes back as one `text` part. Joining the parts gives `text` back, always.
 */
export function splitWalkyIds(text: string, held: (id: string) => boolean): WalkyTextPart[] {
  const parts: WalkyTextPart[] = [];
  let at = 0;
  for (const hit of findWalkyIds(text)) {
    if (!held(hit.id)) continue;
    if (hit.start > at) parts.push({ kind: "text", text: text.slice(at, hit.start) });
    parts.push({ kind: "id", id: hit.id });
    at = hit.end;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}

/** `collie walky send` and `reply` print the id on a line of its own, first. */
const RESULT_ID_LINE = /^(wt_[a-z0-9]{12})[ \t]*$/;

/** The id a tool result opens with (its first line is exactly an id), or null. */
export function resultId(output: string | undefined): string | null {
  if (output === undefined) return null;
  return RESULT_ID_LINE.exec(firstLine(output))?.[1] ?? null;
}

/**
 * The walky talky CLI as the first words of one command segment: `collie walky`, where `collie` may carry
 * a path in front (`/home/me/.local/bin/collie`, `~/.local/bin/collie`, `C:\\tools\\collie.exe`). The installed
 * skill names the binary by its absolute path, so a bare `collie` is only one of the shapes.
 */
const WALKY_BINARY = /^(?:[^\s;&|]*[\\/])?collie(?:\.exe)?\s+walky(?=\s|$)/;
/** After the binary: the verb, and for `inbox` the id it names. */
const WALKY_VERB = /^(?:\s+(send|reply|inbox)(?=\s|$))?(?:\s+(wt_[a-z0-9]{12})(?![A-Za-z0-9_]))?/;
/** Words that may stand before the command in a segment: `env`, and `NAME=value` assignments. */
const SEGMENT_LEAD = /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*/;

/**
 * A command line cut into its segments at `;`, `&&`, `||`, `|`, `&`, an opening `(` or `{`, and a line
 * break, outside quotes. `cd x && git log | collie walky send a` is three segments. A quote hides its
 * separators, so `echo "a; collie walky send"` stays one segment that starts with `echo`.
 */
function shellSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (quote !== null) {
      cur += c;
      if (c === "\\" && quote === '"') cur += command.charAt(++i);
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === "\\") {
      cur += c + command.charAt(++i);
    } else if (c === ";" || c === "&" || c === "|" || c === "(" || c === "{" || c === "\n") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export interface WalkyCommand {
  /** The verb, or `other` for any other (`who`, `status`, a bare `collie walky`). */
  verb: "send" | "reply" | "inbox" | "other";
  /** For `inbox` only: the id the command names. */
  id: string | null;
}

/**
 * The walky command a shell line runs, or null when it is not one. The CLI must be the first words of a
 * segment of the line (after `env` and `NAME=value` words), so a `cd x &&` or `export X=1;` before it, a
 * path in front of `collie`, and a pipe into it (`git log | collie walky send a`) all match, while
 * `echo collie walky send` and `ls collie` do not. The first segment that is a walky command wins.
 */
export function parseWalkyCommand(command: string): WalkyCommand | null {
  for (const segment of shellSegments(command)) {
    const words = segment.trimStart().replace(SEGMENT_LEAD, "");
    const bin = WALKY_BINARY.exec(words);
    if (bin === null) continue;
    const m = WALKY_VERB.exec(words.slice(bin[0].length));
    const verb = m?.[1];
    if (verb !== "send" && verb !== "reply" && verb !== "inbox") return { verb: "other", id: null };
    return { verb, id: verb === "inbox" ? (m?.[2] ?? null) : null };
  }
  return null;
}

/**
 * The shell line of a tool call, in the shapes the chat model has: a command run (`execute`), or a
 * tool the adapter did not recognise (`other`), whose one-line summary is what it ran. Any other kind
 * runs no command.
 */
export function shellLineOf(call: { kind: string; command?: string; summary?: string }): string | null {
  if (call.kind === "execute") return call.command ?? null;
  if (call.kind === "other" && call.summary !== undefined) return firstLine(call.summary);
  return null;
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
 *
 * A pane that carries an `instance` (the four-character token of its current session) gets `#<token>`
 * after the pane id, so the message goes to that session only: if the pane id is reused by another
 * session, the bridge refuses with `pane replaced` instead of typing into a stranger. A pane without
 * one (an older machine in a crew) gets the bare address, which means whatever holds the id now.
 */
export function paneAddress(
  paneId: string,
  scope: Scope | undefined,
  lead: string | undefined,
  instance?: string,
): string {
  const bare = `${scope?.host ?? lead ?? SOLO_MEMBER}/${paneId}`;
  return instance === undefined || instance === "" ? bare : `${bare}#${instance}`;
}

/**
 * An address without its `#<token>`. A receipt's `target` is always bare, while a message's `to`, a
 * sender's `from.address` and a `who` target may carry the token, so a place that compares or shows
 * the pane on its own goes through this first.
 */
export function bareAddress(address: string): string {
  const at = address.indexOf("#");
  return at === -1 ? address : address.slice(0, at);
}

export type WalkyDirection = "received" | "sent";

/**
 * Which way a row of a pane's list went, for the pane at address `self` (see {@link paneAddress}). The list
 * holds both the messages that reached the pane and the ones it sent (each with its receipt), and the row
 * has no field for the direction: it is read off the addresses. A row is SENT when its sender is this pane
 * and its receipt's target is another one; every other row is received, including a pane's message to
 * itself. With no `self` (a mount that cannot name its pane) every row reads as received, as it did before
 * the list held sent rows. Tokens are ignored on both sides ({@link bareAddress}).
 */
export function directionOf(row: Pick<WalkyRow, "from" | "receipt">, self: string | undefined): WalkyDirection {
  if (self === undefined || row.from.address === null) return "received";
  const me = bareAddress(self);
  if (bareAddress(row.receipt.target) === me) return "received";
  return bareAddress(row.from.address) === me ? "sent" : "received";
}

/**
 * The machine a received message came from, when it is not the machine of the pane at address `self`, else
 * null. The sender's machine is the member id of its address (`<memberId>/<paneId>`), and the pane's own
 * machine is the same part of `self` (see {@link paneAddress}: the scope's host, the lead's id, or `local`).
 * An operator message, a solo install (no member id) and a mount with no `self` all read as this machine.
 */
export function remoteMachineOf(row: Pick<WalkyRow, "kind" | "from">, self: string | undefined): string | null {
  if (row.kind !== "agent" || self === undefined) return null;
  const slashAt = row.from.address?.indexOf("/") ?? -1;
  const sender = slashAt > 0 && row.from.address !== null ? row.from.address.slice(0, slashAt) : row.from.memberId;
  if (sender === null || sender === "") return null;
  const slash = self.indexOf("/");
  if (slash <= 0) return null;
  return sender === self.slice(0, slash) ? null : sender;
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

/**
 * A receipt's target as a row names it when no pane is known for it. The bare `all` is the line a
 * broadcast writes for the crew leg before the members answer (bridge/walky/deliver.ts), and reads
 * as "every machine"; any other address is shown as it is.
 */
export function targetWord(address: string): string {
  return address === "all" ? t("walky.crew.receiptAll") : address;
}

/** A held message (M62 spec 02): `accepted`, with the reason that holds it ("draft present", "turn running"). */
export function isHeld(receipt: WalkyReceipt): boolean {
  return receipt.state === "accepted" && receipt.reason !== undefined && receipt.reason !== "";
}

/** Where a message stands, in words, with the bridge's reason when there is one. A held one reads "held: <reason>". */
export function stateWord(receipt: WalkyReceipt): string {
  switch (receipt.state) {
    case "accepted":
      return isHeld(receipt) ? t("walky.state.held", { reason: receipt.reason ?? "" }) : t("walky.state.accepted");
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

/**
 * The messages held for the pane at `self` (M62 spec 03): received, and `accepted` with the reason that
 * holds them. What the held mark above the box counts, and what the Messages sheet offers Drop on. With
 * no `self` nothing is held: a mount that cannot name its pane cannot tell a sent row from a received one.
 */
export function heldForPane(rows: readonly WalkyRow[], self: string | undefined): WalkyRow[] {
  if (self === undefined) return [];
  return rows.filter((row) => isHeld(row.receipt) && directionOf(row, self) === "received");
}

/** How one target's take-back ended (M62 spec 03), as the bridge's cancel and drop routes answer it. */
export type TakeBackResult = "taken" | "repeat" | "already typed" | "not held" | "elsewhere";

export interface WalkyTakeBack {
  target: string;
  result: TakeBackResult;
  receipt: WalkyReceipt;
}

/**
 * What the sheet says under a row after a take-back, or null when there is nothing to say: the hold
 * ended (or had ended), and the row's own receipt tells the rest once the list is read again.
 */
export function takeBackNote(results: readonly WalkyTakeBack[]): string | null {
  if (results.length === 0) return t("walky.sheet.notHeld");
  if (results.some((entry) => entry.result === "taken" || entry.result === "repeat")) return null;
  if (results.some((entry) => entry.result === "already typed")) return t("walky.sheet.alreadyTyped");
  if (results.some((entry) => entry.result === "elsewhere")) return t("walky.sheet.elsewhere");
  return t("walky.sheet.notHeld");
}

/** A receipt that ended with the message in a pane or the inbox, as against one the bridge turned away. */
export function wasTaken(receipt: WalkyReceipt): boolean {
  return receipt.state !== "refused" && receipt.state !== "expired";
}
