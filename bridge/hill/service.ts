// The hill (M96): an agent posts a Decision, a person answers it on the phone, and the answer is typed
// into the agent's pane as that person's own WalkyTalky message.
//
// What the walky socket (bridge/walky/socket.ts) and the phone's routes (bridge/server.ts) both call.
// Pure where it can be: the clock, the id mint, the walky send and the "is this address live" probe are
// injected, so `bun test` drives every rule with fakes.
//
// WHO POSTS. The bridge names the poster from the socket's pane binding, exactly as a walky send names
// its sender: the poster's walky address with its instance token. The socket can only ever make
// `from.kind: "agent"`. `postDecision` also takes `"trick"`, for code inside the bridge.
//
// WHERE THE ANSWER GOES. To `replyTo` when set, else to the poster's own address, resolved at post time
// to one live session and kept with its instance token. At answer time that token must still match, or
// the decision closes `undeliverable` and nothing is typed. The answer is typed through the operator
// walky send (`WalkyService.send` with `{ kind: "operator", label }`), as `POST /api/walky` does it.
// The hill has no path of its own into a pane.
//
// NO POSTER WORDS WITH THE PERSON'S AUTHORITY IN ANOTHER SESSION. The answer is typed as the operator.
// Into the poster's own session it may quote the title and the option's label: the poster wrote them for
// itself. Into another session (`replyTo` names someone else, and always for a trick) it carries only the
// id, the option's intent word, the person's own text and one fixed line (`answerMessage`); that session
// reads the decision itself with `collie hill status <id>`, which answers the poster and the `replyTo`
// session, nobody else.
//
// THE NAMES ON THE CARD. `from.label` and `target.label` are the session's name as the Dashboard's row
// shows it (`sessionName`, injected; hill/walky.ts `hillSessionName`), with the walky label (folder
// and branch) only when the bridge has no name for the pane. Several sessions often share one folder
// and branch, so the walky label alone does not say which session asked. An open decision is served
// with the name the pane has NOW, while that pane is live; a closed one keeps the name it had. The
// walky address stays the routing key and is never renamed.
//
// ORDER ON AN ANSWER. Write the receipt, close the decision, then send. A send that fails or throws
// after the close leaves the decision answered with `delivery: "unknown"`, and nothing is sent again;
// one `hill.undelivered` audit line says so, and the session reads the answer with `collie hill status`.
// A bridge that stopped between the receipt and the close left an `ok` receipt the decision does not
// show: a retry of that `rid` settles it once, in the claim lane, instead of answering the stale `ok`.
// An answer to an id this bridge never held, or one past its expiry, is `gone`; the first stores no
// receipt, so junk cannot push real receipts out of the capped file.
//
// A TRICK'S DECISION (M94). A trick posts through `postDecision` from the tricks runner
// (bridge/tricks/hill.ts). The answer reaches the trick's program as a tap, after the walky message
// when `replyTo` is set, with the answer's own `rid`, through the injected `tap` (this file never
// imports the tricks service; bridge/index.ts wires the two). The receipt and the answer record what
// the tap came to in `trick`: `ran`, or `failed` (written first, so a bridge that stops before the tap
// says so), never retried. A `gone` target runs no tap: one outcome, not half of one.

import { randomBytes } from "node:crypto";

import type { AuditEntry } from "../audit.ts";
import type { JsonObject } from "../json.ts";
import {
  HILL_ANSWER_TEXT_MAX,
  HILL_BODY_MAX,
  HILL_LINK_HREF_MAX,
  HILL_LINK_LABEL_MAX,
  HILL_LINKS_MAX,
  HILL_MEDIA_CAPTION_MAX,
  HILL_MEDIA_MAX,
  HILL_NOW_MAX,
  HILL_OPEN_MAX,
  HILL_OPTION_CONFIRM_MAX,
  HILL_OPTION_DETAIL_MAX,
  HILL_OPTION_LABEL_MAX,
  HILL_OPTIONS_MAX,
  HILL_SUMMARY_MAX,
  HILL_TITLE_MAX,
  HILL_WHY_MAX,
  hillNode,
  isHillOptionIntent,
  sortOpenDecisions,
  type HillAnswerRequest,
  type HillDecision,
  type HillImageInput,
  type HillMedia,
  type HillOption,
  type HillPostInput,
  type HillReceipt,
  type HillRefusalCode,
  type HillState,
} from "../../web/src/lib/hill/wire.ts";
import { cleanBody } from "../walky/clean.ts";
import type { WalkyPane } from "../walky/deliver.ts";
import { headerField, WALKY_BODY_MAX, WALKY_LABEL_MAX } from "../walky/types.ts";
import { digestDiffers, payloadDigest, withDigest } from "../worktree-receipts.ts";
import { readPostFields } from "./parse.ts";
import { mintMediaId, type HillImageBytes, type HillMediaStore } from "./media.ts";
import { hillAnswerDigest, type HillAnswerOutcome, type HillReceiptRecord, type HillReceiptSurface } from "./receipts.ts";
import type { HillStore } from "./store.ts";

/** An agent in a pane this bridge placed: what the socket can name. */
export interface HillAgentSender {
  readonly kind: "agent";
  /** The poster's walky address, `<member>/<pane>#<token>`. The sender's identity. */
  readonly address: string;
  readonly memberId: string | null;
  readonly harness: string | null;
  readonly label: string;
  readonly host: string | null;
}

/** A trick, posting through the tricks runner inside the bridge. Never reachable from the socket. */
export interface HillTrickSender {
  readonly kind: "trick";
  readonly trickId: string;
  /** The decision's `key` in the trick's document; the answer comes back to the trick as `hill/<key>`. */
  readonly trickKey: string;
  /** The trick's name, as its manifest gives it. Display only. */
  readonly label: string;
  /**
   * The tricks host name the trick runs under (bridge/tricks/facts.ts `tricksHostName`); the tap goes
   * there. It is stored as the decision's `from.trickHost`; `from.host` is the machine's display name.
   */
  readonly host: string;
  /**
   * The trick's own folder, its real path, from the runner: the one root inside the config folder this
   * trick's images may come from (media.ts, "A TRICK'S OWN FOLDER"). Absent: the images take the agent's rules.
   */
  readonly imageRoot?: string;
}

/** The tap an answer to a trick's decision becomes: the answer's `rid`, `hill/<key>`, the intent, the words. */
export interface HillTrickTap {
  readonly rid: string;
  readonly node: string;
  readonly intent: string;
  readonly value: { readonly text: string | null };
}

export type HillSender = HillAgentSender | HillTrickSender;

/** One live session a walky address names now, as the probe resolves it. */
export interface HillPlace {
  /** The address with the session's instance token, as `who` lists it. */
  readonly address: string;
  readonly label: string;
  readonly host: string | null;
  /** The session runs in bypass or auto-approve mode, when the bridge knows it. */
  readonly unattended: boolean;
}

/** What the walky send reported: typed, held by walky's hold rule, or not confirmed. */
export type HillDelivery = "typed" | "held" | "unknown";

/** The crew role of this bridge, as `crew.mode` names it in bridge/index.ts. */
export type HillCrewMode = "solo" | "lead" | "peer";

export interface HillServiceDeps {
  readonly store: HillStore;
  readonly receipts: HillReceiptSurface;
  /** The one live session a walky pane address names now, or null (gone, a shell, not an address). */
  place(address: string): HillPlace | null;
  /** Type `body` into the session at `to` as an operator walky message under the label `by`. */
  send(to: string, body: string, by: string): Promise<HillDelivery>;
  crewMode(): HillCrewMode;
  /** False with COLLIE_WALKY=off: no answer could be typed, so no decision is taken. */
  walkyOn(): boolean;
  /** This bridge's crew member id, null on a solo install. */
  readonly memberId: string | null;
  /** This machine's name, as walky's `who` prints it. */
  readonly machine: string;
  /**
   * This bridge's tricks host name (bridge/tricks/facts.ts `tricksHostName`). Only for a trick's decision
   * stored before `from.trickHost` existed: its `from.host` holds the routing value, and the list serves
   * `machine` there instead when the two match. Absent: such a decision is served as stored.
   */
  readonly tricksHost?: () => string;
  readonly now?: () => number;
  readonly mintId?: () => string;
  readonly audit?: (entry: AuditEntry) => void;
  /**
   * Run a trick's program with an answer as its tap (bridge/index.ts wires it to the tricks runner).
   * True when the run succeeded. Absent: no tricks runner, so every trick's answer is `failed`.
   */
  readonly tap?: (host: string, trickId: string, tap: HillTrickTap, decisionId: string) => Promise<boolean>;
  /** Where a decision's images are read and kept (media.ts). Absent: a post with images is refused. */
  readonly media?: HillMediaStore;
  readonly mintMediaId?: () => string;
  /** The session's Dashboard name for the live pane a walky address names now, or null to keep the walky label. */
  readonly sessionName?: (address: string) => string | null;
  /**
   * Run `fn` with one look at the live sessions: every `place` and `sessionName` inside it reads the
   * same `who` list (bridge/index.ts, hill/walky.ts `OneLook`). Absent: each call looks for itself.
   */
  readonly look?: <T>(fn: () => T) => T;
  /**
   * Whether the bridge lists any live session yet. False right after boot, before the first refresh:
   * then the sweep closes nothing for a target that seems gone. Absent: always true.
   */
  readonly sessionsKnown?: () => boolean;
}

/** A post's answer: the stored decision, or a refusal with its code and plain words the CLI prints. */
export type HillPostAnswer = { readonly ok: true; readonly decision: HillDecision } | { readonly ok: false; readonly code: HillRefusalCode | null; readonly error: string };

/** A status or withdraw answer. `missing`: this bridge holds no such decision from this sender. */
export type HillOneAnswer = { readonly ok: true; readonly decision: HillDecision } | { readonly ok: false; readonly missing: true; readonly error: string } | { readonly ok: false; readonly missing: false; readonly error: string };

/** The sentence a crew member answers a post with. */
export const NOT_ON_LEAD = "the hill is not merged across the crew yet; post from a session on the lead machine";
/** The sentence a bridge with WalkyTalky off answers a post with. */
export const HILL_WALKY_OFF = "WalkyTalky is off on this machine (COLLIE_WALKY=off), so no answer could reach you";
/** The closed reason of a withdrawn decision. */
export const BY_THE_POSTER = "by the poster";
/** The closed reason of a decision its trick no longer lists, or replaced while closed. */
export const BY_THE_TRICK = "by the trick";
/** The closed reason of every open decision of a trick switched off or removed. */
export const TRICK_OFF = "the trick is off";
/** The closed reason of a decision whose target session ended, and the receipt's reason. */
export const TARGET_ENDED = "target session ended";
/** The closed reason of an expired decision. */
export const EXPIRED = "expired";
/** The first line of a dismiss's message carries this as its second line. */
export const DISMISSED = "Dismissed.";
/** How many characters of the title the answer message's first line keeps, the `…` included. */
export const MESSAGE_TITLE_MAX = 80;
/** How many characters of a session's name a card shows, the `…` included. */
export const SESSION_LABEL_MAX = 80;
/** Open decisions the hill holds at once, across every sender. A further post is refused `too_many_open`. */
export const HILL_OPEN_TOTAL_MAX = 200;
/** The days a decision posted with no expiry stays open; `collie hill post --help` says so. */
export const HILL_DEFAULT_EXPIRY_DAYS = 14;
/** {@link HILL_DEFAULT_EXPIRY_DAYS} in milliseconds: a post with no `expiresAt` gets `at` plus this. */
export const HILL_DEFAULT_EXPIRY_MS = HILL_DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

/** Mint a decision id: `dc_` and 12 characters of [a-z0-9], from a uniform random source. */
export function mintDecisionId(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
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
  return `dc_${out}`;
}

/** A string as the hill keeps it, and whether it is past its field's cap (then it is refused, never cut). */
export interface HillCleanText {
  readonly text: string;
  readonly over: boolean;
}

function codePoints(text: string): number {
  return [...text].length;
}

/**
 * One line of text as the hill keeps it: the walky body cleaning (control and invisible characters
 * dropped, a header-like line escaped), then every line break a space. Never cut: `over` says it is
 * past `max`, and the caller refuses it.
 */
export function cleanLine(raw: string, max: number): HillCleanText {
  const text = cleanBody(raw, Number.MAX_SAFE_INTEGER)
    .body.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  return { text, over: codePoints(text) > max };
}

/** Text that may hold line breaks, cleaned as a walky body is. Never cut: `over` says it is past `max`. */
export function cleanText(raw: string, max: number): HillCleanText {
  const text = cleanBody(raw, Number.MAX_SAFE_INTEGER).body;
  return { text, over: codePoints(text) > max };
}

/** A link address the card may open: http or https, printable ASCII, at most {@link HILL_LINK_HREF_MAX}. */
export function isLinkHref(raw: string): boolean {
  if (raw.length === 0 || raw.length > HILL_LINK_HREF_MAX || !/^[\x21-\x7e]+$/u.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/** The title as the answer message's first line quotes it: at most {@link MESSAGE_TITLE_MAX} characters, cut with `…`. */
export function messageTitle(title: string): string {
  const points = [...title];
  return points.length <= MESSAGE_TITLE_MAX ? title : `${points.slice(0, MESSAGE_TITLE_MAX - 1).join("")}…`;
}

/** The fixed last line of an answer typed into a session other than the poster's: where the decision can be read. */
export function readItLine(id: string): string {
  return `Read the decision with: collie hill status ${id}`;
}

/**
 * The walky message an answer types. It is typed with the person's authority, so it carries words the
 * poster wrote only when it goes back into the poster's own session.
 *
 * To the poster (`toPoster`, the default): `Answer to <id> "<title>"`, then `Option: <intent> (<label>)`
 * for an option, then the person's text when there is one. A dismiss is the first line and `Dismissed.`.
 *
 * To another session (`replyTo` names someone else, always so for a trick): no title and no label, only
 * `Answer to <id>`, `Option: <intent>` (a pattern-checked word, `isHillOptionIntent`), the person's text,
 * and {@link readItLine}. A dismiss is `Answer to <id>` and `Dismissed.` only.
 */
export function answerMessage(decision: Pick<HillDecision, "id" | "title">, intent: string, label: string | null, text: string | null, toPoster = true): string {
  const lines = [toPoster ? `Answer to ${decision.id} "${messageTitle(decision.title)}"` : `Answer to ${decision.id}`];
  if (intent === "dismiss") return [...lines, DISMISSED].join("\n");
  if (intent !== "answer") lines.push(toPoster ? `Option: ${intent} (${label ?? intent})` : `Option: ${intent}`);
  if (text !== null && text !== "") lines.push(text);
  if (!toPoster) lines.push(readItLine(decision.id));
  return lines.join("\n");
}

/** A session's name as the hill keeps it: one cleaned line, cut with `…` past {@link SESSION_LABEL_MAX}. */
export function sessionLabel(raw: string): string {
  const { text } = cleanLine(raw, SESSION_LABEL_MAX);
  const points = [...text];
  return points.length <= SESSION_LABEL_MAX ? text : `${points.slice(0, SESSION_LABEL_MAX - 1).join("")}…`;
}

/**
 * What a post asks for, as a digest (`payloadDigest`), defaults filled: the words, the options, the
 * links, the priority, the addresses and the images as named. Not `expiresAt` (a retried
 * `collie hill post --expires 2h` counts it again from its own clock) and not `supersedes` (a trick
 * names it from the state it reads, which a first post that went through has moved).
 */
export function hillPostDigest(input: HillPostInput): string {
  const options = (input.options ?? []).map((option) => [option.intent, option.label, option.detail ?? null, option.confirm ?? null]);
  const recommends = input.recommends === undefined || input.recommends === null ? null : [input.recommends.intent, input.recommends.why];
  const links = (input.links ?? []).map((link) => [link.label, link.href]);
  const images = (input.images ?? []).map((image) => [image.path, image.caption ?? null]);
  const parts = [input.title, input.summary, input.body ?? "", options, input.text ?? "optional", recommends, links, input.priority ?? "today", input.about ?? null, input.replyTo ?? null, images];
  return payloadDigest([JSON.stringify(parts)]);
}

/** A decision as the phone and the socket get it: without `postDigest`, which only the store needs. */
function served(decision: HillDecision): HillDecision {
  if (decision.postDigest === undefined) return decision;
  const copy = { ...decision };
  delete copy.postDigest;
  return copy;
}

/** The key a sender's decisions are filed under: its address, or the trick's id. */
function senderKey(sender: HillSender): string {
  return sender.kind === "agent" ? sender.address : `trick:${sender.trickId}`;
}

function keyOf(decision: HillDecision): string {
  return decision.from.kind === "agent" ? (decision.from.address ?? "") : `trick:${decision.from.trickId ?? ""}`;
}

function refuse(code: HillRefusalCode | null, error: string): HillPostAnswer {
  return { ok: false, code, error };
}

/** The cleaned fields of a post, or the refusal of the first that fails. */
type Cleaned = Pick<HillDecision, "title" | "summary" | "body" | "options" | "text" | "recommends" | "links">;

function cleanPost(input: HillPostInput): { readonly ok: true; readonly fields: Cleaned } | Extract<HillPostAnswer, { ok: false }> {
  const title = cleanLine(input.title, HILL_TITLE_MAX);
  if (title.text === "") return { ok: false, code: "bad_title", error: "a decision needs a title" };
  if (title.over) return { ok: false, code: "bad_title", error: `the title is longer than ${String(HILL_TITLE_MAX)} characters` };
  const summary = cleanText(input.summary, HILL_SUMMARY_MAX);
  if (summary.text === "") return { ok: false, code: "bad_summary", error: "a decision needs a summary in plain words" };
  if (summary.over) return { ok: false, code: "bad_summary", error: `the summary is longer than ${String(HILL_SUMMARY_MAX)} characters` };
  const body = cleanText(input.body ?? "", HILL_BODY_MAX);
  if (body.over) return { ok: false, code: "bad_body", error: `the body is longer than ${String(HILL_BODY_MAX)} characters` };
  const rawOptions = input.options ?? [];
  if (rawOptions.length > HILL_OPTIONS_MAX) return { ok: false, code: "bad_option", error: `a decision has at most ${String(HILL_OPTIONS_MAX)} options` };
  const options: HillOption[] = [];
  for (const raw of rawOptions) {
    if (!isHillOptionIntent(raw.intent)) return { ok: false, code: "bad_option", error: `\`${headerField(raw.intent, 40)}\` is not an option intent: a lowercase word of at most 32 characters, not answer or dismiss` };
    if (options.some((option) => option.intent === raw.intent)) return { ok: false, code: "bad_option", error: `two options share the intent \`${raw.intent}\`` };
    const label = cleanLine(raw.label, HILL_OPTION_LABEL_MAX);
    if (label.text === "" || label.over) return { ok: false, code: "bad_option", error: `the label of \`${raw.intent}\` is 1 to ${String(HILL_OPTION_LABEL_MAX)} characters` };
    const detail = cleanLine(raw.detail ?? "", HILL_OPTION_DETAIL_MAX);
    if (detail.over) return { ok: false, code: "bad_option", error: `the detail of \`${raw.intent}\` is longer than ${String(HILL_OPTION_DETAIL_MAX)} characters` };
    const confirm = raw.confirm === undefined ? null : cleanLine(raw.confirm, HILL_OPTION_CONFIRM_MAX);
    if (confirm !== null && (confirm.text === "" || confirm.over)) return { ok: false, code: "bad_option", error: `the confirm word of \`${raw.intent}\` is 1 to ${String(HILL_OPTION_CONFIRM_MAX)} characters` };
    const base: HillOption = { intent: raw.intent, label: label.text };
    const withDetail = detail.text === "" ? base : { ...base, detail: detail.text };
    options.push(confirm === null ? withDetail : { ...withDetail, confirm: confirm.text });
  }
  const text = input.text ?? "optional";
  if (text === "none" && options.length === 0) return { ok: false, code: "bad_text_mode", error: "a decision with no options takes text: use --text optional or required" };
  let recommends: HillDecision["recommends"] = null;
  if (input.recommends !== undefined && input.recommends !== null) {
    const named = input.recommends.intent;
    if (!options.some((option) => option.intent === named)) return { ok: false, code: "bad_recommends", error: `the recommendation \`${headerField(named, 40)}\` names no option` };
    const why = cleanLine(input.recommends.why, HILL_WHY_MAX);
    if (why.text === "" || why.over) return { ok: false, code: "bad_recommends", error: `the why is 1 to ${String(HILL_WHY_MAX)} characters` };
    recommends = { intent: named, why: why.text };
  }
  const rawLinks = input.links ?? [];
  if (rawLinks.length > HILL_LINKS_MAX) return { ok: false, code: "bad_link", error: `a decision has at most ${String(HILL_LINKS_MAX)} links` };
  const links: Array<{ label: string; href: string }> = [];
  for (const raw of rawLinks) {
    const label = cleanLine(raw.label, HILL_LINK_LABEL_MAX);
    if (label.text === "" || label.over) return { ok: false, code: "bad_link", error: `a link label is 1 to ${String(HILL_LINK_LABEL_MAX)} characters` };
    const href = raw.href.trim();
    if (!isLinkHref(href)) return { ok: false, code: "bad_link", error: `a link is an http or https address of at most ${String(HILL_LINK_HREF_MAX)} characters` };
    links.push({ label: label.text, href });
  }
  return { ok: true, fields: { title: title.text, summary: summary.text, body: body.text, options, text, recommends, links } };
}

/** The receipt an answer writes, before or instead of any send. */
function receiptOf(rid: string, at: number, code: HillReceipt["code"], reason: string | null, state: HillState | null, delivery: HillReceipt["delivery"], trick: HillReceipt["trick"] = null): HillReceipt {
  return { rid, code, reason, state, delivery, trick, at };
}

/** The trick a decision came from, when it came from one: where its tap goes. */
function trickOf(decision: HillDecision): { readonly host: string; readonly trickId: string; readonly trickKey: string } | null {
  const { kind, trickId, trickKey } = decision.from;
  // A decision stored before `trickHost` existed holds the routing value in `host`.
  const host = decision.from.trickHost ?? decision.from.host;
  return kind === "trick" && host !== null && trickId !== null && trickKey !== null ? { host, trickId, trickKey } : null;
}

/** What the claim step of an answer hands the send step, or the receipt that ends it. */
type Claim =
  | { readonly kind: "done"; readonly outcome: HillAnswerOutcome }
  | {
      readonly kind: "deliver";
      readonly decision: HillDecision;
      readonly record: HillReceiptRecord;
      /** The walky message, or null when nothing is typed (a trick with no `replyTo`). */
      readonly send: { readonly to: string; readonly body: string } | null;
      /** The trick's tap, or null for an agent's decision. */
      readonly tap: { readonly host: string; readonly trickId: string; readonly decisionId: string; readonly tap: HillTrickTap } | null;
    };

export class HillService {
  private readonly now: () => number;
  private readonly mint: () => string;
  /** The names of the open decisions at the last `rev()`, and how often they changed since the start. */
  private namesSeen: string | null = null;
  private namesMoved = 0;
  /** The answers' claim steps run one after another, so two taps cannot both find a decision open. */
  private lane: Promise<void> = Promise.resolve();
  /** The open decisions whose target the last sweep found gone. Gone at two sweeps in a row closes one. */
  private absent = new Set<string>();

  constructor(private readonly deps: HillServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.mint = deps.mintId ?? (() => mintDecisionId());
  }

  /**
   * The revision on the snapshot, or undefined while no decisions file exists. It also moves when a
   * session behind an open decision is renamed, so the phone refetches the list and shows the new name.
   */
  rev(): number | undefined {
    const stored = this.deps.store.rev();
    if (stored === undefined) return undefined;
    if (this.deps.sessionName !== undefined) {
      const names = this.look(() => JSON.stringify(this.deps.store.list().open.map((decision) => this.named(decision)).map((decision) => [decision.id, decision.from.label, decision.target?.label ?? null])));
      if (this.namesSeen !== null && names !== this.namesSeen) this.namesMoved += 1;
      this.namesSeen = names;
    }
    return stored + this.namesMoved;
  }

  /** `fn` under one look at the live sessions, when the bridge gives one. */
  private look<T>(fn: () => T): T {
    return this.deps.look === undefined ? fn() : this.deps.look(fn);
  }

  /** One decision by id, any sender (the tricks runner reads its own decisions' states). */
  decision(id: string): HillDecision | undefined {
    return this.deps.store.get(id);
  }

  /** What `GET /api/hill` serves: every open decision with the names its sessions have now. */
  list(): ReturnType<HillStore["list"]> {
    return this.look(() => {
      const list = this.deps.store.list();
      // The same revision the snapshot carries, so a phone that holds it reads `unchanged`.
      return { ...list, rev: this.rev() ?? list.rev, open: list.open.map((decision) => served(this.named(decision))), closed: list.closed.map(served) };
    });
  }

  /** The session's name for a walky address, or `fallback` when the bridge has none. */
  private nameOf(address: string | null, fallback: string): string {
    const name = address === null ? null : (this.deps.sessionName?.(address) ?? null);
    const label = name === null ? "" : sessionLabel(name);
    return label === "" ? fallback : label;
  }

  /** An open decision with the names its sessions have now, while they are live. A closed one, as stored. */
  private named(stored: HillDecision): HillDecision {
    if (stored.state !== "open") return stored;
    const decision = this.displayed(stored);
    if (this.deps.sessionName === undefined) return decision;
    const fromLabel = decision.from.kind === "agent" ? this.nameOf(decision.from.address, decision.from.label) : decision.from.label;
    const to = decision.replyTo ?? decision.from.address;
    const target = decision.target === null ? null : { ...decision.target, label: this.nameOf(to, decision.target.label) };
    if (fromLabel === decision.from.label && target?.label === decision.target?.label) return decision;
    return { ...decision, from: { ...decision.from, label: fromLabel }, target };
  }

  /**
   * An open trick's decision stored before `from.trickHost` existed holds the tricks host name (the
   * routing value) in `from.host`; served with the machine's display name instead when that routing
   * host is this bridge's own. The stored file is not rewritten: the next post of the key carries both.
   */
  private displayed(decision: HillDecision): HillDecision {
    const { from } = decision;
    if (from.kind !== "trick" || from.trickHost !== null || from.host === null) return decision;
    if (this.deps.tricksHost === undefined || from.host !== this.deps.tricksHost()) return decision;
    return { ...decision, from: { ...from, host: this.deps.machine } };
  }

  /** The sender a pane of this bridge stands for, at its walky address (`WalkyService.addressOf`). */
  agentSender(pane: Pick<WalkyPane, "harness" | "label">, address: string): HillAgentSender {
    return { kind: "agent", address, memberId: this.deps.memberId, harness: pane.harness, label: headerField(pane.label, WALKY_LABEL_MAX), host: this.deps.machine };
  }

  /** A `hill.post` request's raw fields, from the socket: read, then posted. */
  postFields(from: HillAgentSender, fields: JsonObject): HillPostAnswer {
    const read = readPostFields(fields);
    if (!read.ok) return refuse(read.code, read.error);
    return this.post(from, read.input);
  }

  /** One post from an agent's pane. The socket's only entry; it can never make a trick's post. */
  post(from: HillAgentSender, input: HillPostInput): HillPostAnswer {
    return this.postDecision(from, input);
  }

  /** One post, from an agent or from a trick inside the bridge. */
  postDecision(from: HillSender, input: HillPostInput): HillPostAnswer {
    if (!this.deps.walkyOn()) return refuse("walky_off", HILL_WALKY_OFF);
    if (this.deps.crewMode() === "peer") return refuse("not_on_lead", NOT_ON_LEAD);
    const key = senderKey(from);
    const digest = hillPostDigest(input);
    // A repeated request id from the same sender with the same payload is the same decision: answered as
    // stored, nothing checked again. With another payload it is refused, as a reused answer `rid` is (409).
    const repeat = this.deps.store.all().find((decision) => decision.requestId === input.requestId && keyOf(decision) === key);
    if (repeat !== undefined && repeat.postDigest !== undefined && repeat.postDigest !== digest) return refuse("request_id_reused", `this request id already posted ${repeat.id} with other content; post with a new --request-id`);
    if (repeat !== undefined) return { ok: true, decision: served(repeat) };
    const cleaned = cleanPost(input);
    if (!cleaned.ok) return cleaned;
    const now = this.now();
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt <= now) return refuse(null, "bad request: the expiry is in the past");

    const about = this.resolveAbout(from, input.about ?? null);
    if (about === undefined) return refuse("bad_target", `\`${headerField(input.about ?? "", 80)}\` is not a live session's walky address`);
    let replyTo: HillPlace | null = null;
    if (input.replyTo !== undefined && input.replyTo !== null) {
      replyTo = this.deps.place(input.replyTo);
      if (replyTo === null) return refuse("bad_target", `\`${headerField(input.replyTo, 80)}\` is not a live session's walky address`);
    }
    const own = from.kind === "agent" ? this.deps.place(from.address) : null;
    if (from.kind === "agent" && own === null && replyTo === null) return refuse("bad_target", "this session is not a live walky address: run it inside an agent's pane");
    const target = replyTo ?? own;

    let superseded: HillDecision | null = null;
    if (input.supersedes !== undefined && input.supersedes !== null) {
      const old = this.deps.store.get(input.supersedes);
      if (old === undefined || keyOf(old) !== key) return refuse("bad_supersedes", `no decision ${input.supersedes} from this session`);
      if (old.state !== "open") return refuse("bad_supersedes", `${old.id} is ${old.state}, only an open decision can be replaced`);
      superseded = old;
    }
    const allOpen = this.deps.store.all().filter((decision) => decision.state === "open" && decision.id !== superseded?.id);
    const open = allOpen.filter((decision) => keyOf(decision) === key);
    if (open.length >= HILL_OPEN_MAX) return refuse("too_many_open", `this session has ${String(HILL_OPEN_MAX)} open decisions; withdraw one, or wait for answers`);
    if (allOpen.length >= HILL_OPEN_TOTAL_MAX) return refuse("too_many_open", `the hill holds ${String(HILL_OPEN_TOTAL_MAX)} open decisions; withdraw one, or wait for answers`);
    const asked = input.priority ?? "today";
    const priority = asked === "now" && open.filter((decision) => decision.priority === "now").length >= HILL_NOW_MAX ? "today" : asked;
    // A trick's own folder is a root for a trick's images only; an agent's post never has one.
    const images = this.readImages(input.images ?? [], from.kind === "trick" ? (from.imageRoot ?? null) : null);
    if (!images.ok) return images;

    let id = this.mint();
    for (let tries = 0; this.deps.store.taken(id) && tries < 8; tries += 1) id = this.mint();
    if (this.deps.store.taken(id)) return refuse(null, "could not mint a decision id; try again");
    const media = this.keepImages(id, images.images);
    if (media === null) return refuse(null, "the images could not be saved on this machine; nothing was posted");
    const decision: HillDecision = {
      v: 1,
      id,
      requestId: input.requestId,
      from:
        from.kind === "agent"
          ? { kind: "agent", address: from.address, trickId: null, trickKey: null, memberId: from.memberId, harness: from.harness, label: this.nameOf(from.address, from.label), host: from.host, trickHost: null }
          : { kind: "trick", address: null, trickId: from.trickId, trickKey: from.trickKey, memberId: this.deps.memberId, harness: null, label: headerField(from.label, WALKY_LABEL_MAX), host: this.deps.machine, trickHost: from.host },
      about: about?.address ?? null,
      priority,
      priorityAsked: asked,
      ...cleaned.fields,
      media,
      replyTo: replyTo?.address ?? null,
      target: target === null ? null : { label: this.nameOf(target.address, target.label), host: target.host, unattended: target.unattended },
      supersedes: superseded?.id ?? null,
      supersededBy: null,
      // No expiry asked for: it closes `expired` after the default, so a forgotten decision does not stay forever.
      expiresAt: input.expiresAt ?? now + HILL_DEFAULT_EXPIRY_MS,
      at: now,
      state: "open",
      closedAt: null,
      closedReason: null,
      answer: null,
      postDigest: digest,
    };
    const replaced: HillDecision[] = superseded === null ? [] : [{ ...superseded, state: "superseded", supersededBy: id, closedAt: now, closedReason: `superseded by ${id}` }];
    if (!this.deps.store.put(decision, ...replaced)) {
      if (media.length > 0) this.deps.media?.remove(id);
      return refuse(null, "the decision could not be saved on this machine; nothing was posted");
    }
    const base = superseded === null ? { decisionId: id, options: decision.options.length } : { decisionId: id, options: decision.options.length, supersedes: superseded.id };
    // The images as a count and a byte sum, never a path or a caption.
    const detail = media.length === 0 ? base : { ...base, images: media.length, imageBytes: media.reduce((sum, item) => sum + item.bytes, 0) };
    this.deps.audit?.({ action: "hill.post", detail });
    return { ok: true, decision: served(decision) };
  }

  /** Read and check every image a post names, in order, before anything is kept. The first that fails refuses the post. */
  private readImages(raw: readonly HillImageInput[], trickRoot: string | null): { readonly ok: true; readonly images: Array<HillImageBytes & { readonly caption: string | null }> } | Extract<HillPostAnswer, { ok: false }> {
    if (raw.length === 0) return { ok: true, images: [] };
    if (raw.length > HILL_MEDIA_MAX) return { ok: false, code: "too_many_images", error: `a decision has at most ${String(HILL_MEDIA_MAX)} images` };
    const store = this.deps.media;
    if (store === undefined) return { ok: false, code: "bad_image", error: "this bridge keeps no images" };
    const images: Array<HillImageBytes & { readonly caption: string | null }> = [];
    for (const image of raw) {
      const caption = cleanLine(image.caption ?? "", HILL_MEDIA_CAPTION_MAX);
      if (caption.over) return { ok: false, code: "bad_image", error: `an image caption is at most ${String(HILL_MEDIA_CAPTION_MAX)} characters` };
      const read = store.read(image.path, trickRoot);
      if (!read.ok) return { ok: false, code: read.code, error: read.error };
      images.push({ mime: read.mime, bytes: read.bytes, width: read.width, height: read.height, caption: caption.text === "" ? null : caption.text });
    }
    return { ok: true, images };
  }

  /** Keep a new decision's images under ids the bridge mints. The media entries, or null when the write failed. */
  private keepImages(decisionId: string, images: ReadonlyArray<HillImageBytes & { readonly caption: string | null }>): HillMedia[] | null {
    if (images.length === 0) return [];
    const store = this.deps.media;
    if (store === undefined) return null;
    const mint = this.deps.mintMediaId ?? (() => mintMediaId());
    const ids: string[] = [];
    for (let tries = 0; ids.length < images.length && tries < images.length + 8; tries += 1) {
      const next = mint();
      if (!ids.includes(next)) ids.push(next);
    }
    if (ids.length < images.length) return null;
    const files = images.map((image, i) => ({ id: ids[i]!, bytes: image.bytes }));
    if (!store.save(decisionId, files)) return null;
    return images.map((image, i): HillMedia => {
      const entry: HillMedia = { id: ids[i]!, kind: "image", mime: image.mime, bytes: image.bytes.length, width: image.width, height: image.height };
      return image.caption === null ? entry : { ...entry, caption: image.caption };
    });
  }

  /** The bytes and type of one image of a held decision, for the phone's read route. Null for any id this bridge does not hold. */
  mediaFile(decisionId: string, mediaId: string): { readonly mime: HillMedia["mime"]; readonly bytes: Uint8Array<ArrayBuffer> } | null {
    const store = this.deps.media;
    if (store === undefined) return null;
    const media = this.deps.store.get(decisionId)?.media.find((item) => item.id === mediaId);
    if (media === undefined) return null;
    const bytes = store.bytesOf(decisionId, media);
    return bytes === null ? null : { mime: media.mime, bytes };
  }

  /**
   * Remove the image folders of decisions the store no longer holds. Run at start and from the sweep.
   * Never after the decisions file was set aside, and never while an entry this build cannot read has
   * no id it can tell (store.ts `mediaKeep`): a folder it cannot tie to a decision may still be one's.
   */
  pruneMedia(): number {
    const keep = this.deps.store.mediaKeep();
    if (keep === null) return 0;
    return this.deps.media?.prune(keep) ?? 0;
  }

  /** `about` as the post named it: none, `here` (the poster's own session) or an address. Undefined: not a live one. */
  private resolveAbout(from: HillSender, about: string | null): HillPlace | null | undefined {
    if (about === null || about.trim() === "") return null;
    if (about.trim() === "here") return from.kind === "agent" ? (this.deps.place(from.address) ?? undefined) : undefined;
    return this.deps.place(about) ?? undefined;
  }

  private mine(sender: HillSender, id: string): HillDecision | null {
    const decision = this.deps.store.get(id);
    return decision === undefined || keyOf(decision) !== senderKey(sender) ? null : decision;
  }

  /** Whether the walky address `address` is the live session `replyTo` names (the instance token included). */
  private isReplyTo(replyTo: string | null, address: string | null): boolean {
    if (replyTo === null || address === null) return false;
    return replyTo === address || this.deps.place(address)?.address === replyTo;
  }

  /**
   * Whether an answer to `decision` goes back into the poster's own session. Not so when `replyTo` names
   * another session, and never for a trick: then the typed message carries no word the poster wrote.
   */
  private answersThePoster(decision: HillDecision): boolean {
    if (decision.replyTo === null) return true;
    return decision.from.kind === "agent" && this.isReplyTo(decision.replyTo, decision.from.address);
  }

  /**
   * One decision, for its poster or for the session its `replyTo` names: the one an answer is typed into
   * reads it with `collie hill status`. Anybody else's id answers as not found.
   */
  status(sender: HillSender, id: string): HillOneAnswer {
    const decision = this.mine(sender, id) ?? this.addressedTo(sender, id);
    return decision === null ? { ok: false, missing: true, error: `no decision ${id} from this session` } : { ok: true, decision: served(this.named(decision)) };
  }

  /** A decision whose `replyTo` is the asking agent's live session, or null. */
  private addressedTo(sender: HillSender, id: string): HillDecision | null {
    if (sender.kind !== "agent") return null;
    const decision = this.deps.store.get(id);
    return decision !== undefined && this.isReplyTo(decision.replyTo, sender.address) ? decision : null;
  }

  /** The poster takes an open decision back. It closes `withdrawn`, "by the poster" (a trick's runner names its own reason). */
  withdraw(sender: HillSender, id: string, reason: string = BY_THE_POSTER): HillOneAnswer {
    const decision = this.mine(sender, id);
    if (decision === null) return { ok: false, missing: true, error: `no decision ${id} from this session` };
    if (decision.state !== "open") return { ok: false, missing: false, error: `${id} is ${decision.state}, nothing to withdraw` };
    const closed: HillDecision = { ...decision, state: "withdrawn", closedAt: this.now(), closedReason: reason };
    if (!this.deps.store.put(closed)) return { ok: false, missing: false, error: "the change could not be saved on this machine; the decision stays open" };
    this.deps.audit?.({ action: "hill.withdraw", detail: { decisionId: id } });
    return { ok: true, decision: served(closed) };
  }

  /** The sender's own decisions: open first (as the phone sorts them), then closed, newest first. */
  mineList(sender: HillSender): HillDecision[] {
    const key = senderKey(sender);
    const own = this.deps.store.all().filter((decision) => keyOf(decision) === key);
    const open = this.look(() => sortOpenDecisions(own.filter((decision) => decision.state === "open")).map((decision) => this.named(decision)));
    const closed = own.filter((decision) => decision.state !== "open").toSorted((a, b) => (b.closedAt ?? b.at) - (a.closedAt ?? a.at));
    return [...open, ...closed].map(served);
  }

  /**
   * The bridge's slow timer (every 15 s): close every open decision past its `expiresAt` as `expired`,
   * and every one whose target session has ended as `undeliverable` ("target session ended"), so a
   * poster that is gone does not leave its decisions on the hill. Answers how many closed.
   *
   * A target counts as ended only when it is absent at two sweeps in a row, and never while the bridge
   * lists no session at all (right after boot, before the first refresh). A trick's decision with no
   * `replyTo` has no session to end; its runner owns it.
   */
  sweep(now: number = this.now()): number {
    this.pruneMedia();
    const due = this.deps.store.all().filter((decision) => decision.state === "open" && decision.expiresAt !== null && decision.expiresAt <= now);
    const expired = due.map((decision): HillDecision => Object.assign({}, decision, { state: "expired" as const, closedAt: now, closedReason: EXPIRED }));
    const ended = this.look(() => this.endedTargets(new Set(due.map((decision) => decision.id))));
    const closed = [...expired, ...ended.map((decision): HillDecision => Object.assign({}, decision, { state: "undeliverable" as const, closedAt: now, closedReason: TARGET_ENDED }))];
    if (closed.length === 0) return 0;
    if (this.deps.store.put(...closed)) return closed.length;
    // Not saved: the ended ones are still absent, and the next sweep tries them again.
    for (const decision of ended) this.absent.add(decision.id);
    return 0;
  }

  /** The open decisions whose target was gone at this sweep and the last one. Moves the memory of who was gone. */
  private endedTargets(skip: ReadonlySet<string>): HillDecision[] {
    if (!(this.deps.sessionsKnown?.() ?? true)) {
      this.absent.clear();
      return [];
    }
    const gone: string[] = [];
    const ended: HillDecision[] = [];
    for (const decision of this.deps.store.all()) {
      if (decision.state !== "open" || skip.has(decision.id)) continue;
      const to = decision.replyTo ?? decision.from.address;
      // A trick's decision with no `replyTo` types into nothing: the trick runner owns it.
      if (decision.target === null || to === null) continue;
      if (this.deps.place(to)?.address === to) continue;
      if (this.absent.has(decision.id)) ended.push(decision);
      else gone.push(decision.id);
    }
    this.absent = new Set(gone);
    return ended;
  }

  /**
   * One answer from a phone, by the receipt rules of the contract, in this order: a known `rid`, the
   * decision open, the intent, the text rule, the target still live; then the receipt, the close and
   * the send. `id` is the decision id the node named. `by` is the device's label, as operator walky uses it.
   *
   * A known `rid` with the same payload answers its stored receipt and runs nothing, with one exception:
   * an `ok` receipt the decision does not show (the bridge stopped between the receipt and the close, or
   * a close the receipt never heard of). That answer is settled once, in the claim lane: closed and
   * delivered when the decision is still open, else answered `gone` with the state it has.
   */
  answer(request: HillAnswerRequest, id: string, by: string): Promise<HillAnswerOutcome> {
    const digest = hillAnswerDigest(request.node, request.intent, request.value.text);
    // SYNCHRONOUS from here to `track`: two requests with one rid must not both get past the look.
    const stored = this.deps.receipts.get(request.rid);
    if (stored !== undefined) {
      if (stored.payloadDigest !== digest) return Promise.resolve({ kind: "reused" });
      if (!this.unsettled(stored, id)) return Promise.resolve({ kind: "receipt", receipt: stored.receipt });
    }
    const running = this.deps.receipts.inflight(request.rid);
    if (running !== undefined) return digestDiffers(running, digest) ? Promise.resolve({ kind: "reused" }) : running;
    const work = withDigest(this.run(request, id, by, digest), digest);
    this.deps.receipts.track(request.rid, work);
    return work;
  }

  /**
   * Whether a stored receipt says `ok` for an answer its decision does not show: the decision is held and
   * its answer is not this `rid`'s. A decision the store no longer holds left the closed list after it
   * closed, so its `ok` stands.
   */
  private unsettled(stored: HillReceiptRecord, id: string): boolean {
    if (stored.receipt.code !== "ok") return false;
    const decision = this.deps.store.get(id);
    return decision !== undefined && decision.answer?.rid !== stored.requestId;
  }

  private async run(request: HillAnswerRequest, id: string, by: string, digest: string): Promise<HillAnswerOutcome> {
    const claimed = this.lane.then(() => this.claim(request, id, by, digest));
    this.lane = claimed.then(
      () => undefined,
      () => undefined,
    );
    const claim = await claimed;
    if (claim.kind === "done") return claim.outcome;
    let delivery: NonNullable<HillReceipt["delivery"]> = "none";
    let threw = false;
    if (claim.send !== null) {
      try {
        delivery = await this.deps.send(claim.send.to, claim.send.body, by);
      } catch {
        // Not confirmed, and never sent again: the decision stays answered with `unknown`.
        delivery = "unknown";
        threw = true;
      }
    }
    // One line of its own: the answer is kept on the decision, and the session reads it with `collie hill status`.
    if (claim.send !== null && delivery === "unknown") this.deps.audit?.({ action: "hill.undelivered", device: by, detail: { decisionId: id, why: threw ? "the send failed" : "not confirmed" } });
    let trick: NonNullable<HillReceipt["trick"]> = "none";
    if (claim.tap !== null) trick = (await this.runTap(claim.tap)) ? "ran" : "failed";
    const receipt: HillReceipt = { ...claim.record.receipt, delivery, trick };
    await this.deps.receipts.record({ ...claim.record, receipt });
    const now = this.deps.store.get(id);
    if (now?.answer?.rid === request.rid && (now.answer.delivery !== delivery || now.answer.trick !== trick)) this.deps.store.put({ ...now, answer: { ...now.answer, delivery, trick } });
    this.auditAnswer(claim.decision, request, by, receipt);
    return { kind: "receipt", receipt };
  }

  /** The trick's tap, run once. A throw, or no tricks runner, is a failed tap; nothing retries. */
  private async runTap(tap: NonNullable<Extract<Claim, { kind: "deliver" }>["tap"]>): Promise<boolean> {
    if (this.deps.tap === undefined) return false;
    try {
      return await this.deps.tap(tap.host, tap.trickId, tap.tap, tap.decisionId);
    } catch {
      return false;
    }
  }

  private auditAnswer(decision: Pick<HillDecision, "id">, request: HillAnswerRequest, by: string, receipt: HillReceipt): void {
    this.deps.audit?.({
      action: "hill.answer",
      device: by,
      detail: { decisionId: decision.id, intent: request.intent, textLength: request.value.text?.length ?? 0, receiptCode: receipt.code, delivery: receipt.delivery ?? "none", trick: receipt.trick ?? "none" },
    });
  }

  /**
   * A receipt that ends the answer before any send: written (unless `keep` is false), audited, answered.
   * It replaces a stored `ok` for the same `rid` that the decision never showed.
   */
  private async final(request: HillAnswerRequest, id: string, by: string, digest: string, receipt: HillReceipt, keep = true): Promise<Claim> {
    if (keep) await this.deps.receipts.record({ requestId: request.rid, payloadDigest: digest, receipt });
    this.auditAnswer({ id }, request, by, receipt);
    return { kind: "done", outcome: { kind: "receipt", receipt } };
  }

  private async claim(request: HillAnswerRequest, id: string, by: string, digest: string): Promise<Claim> {
    const { rid, intent } = request;
    // A retry of an unsettled `ok` (see `answer`) waited in the lane: another may have settled it meanwhile.
    const known = this.deps.receipts.get(rid);
    if (known !== undefined && !this.unsettled(known, id)) return { kind: "done", outcome: { kind: "receipt", receipt: known.receipt } };
    const now = this.now();
    const decision = this.deps.store.get(id);
    // No receipt for an id this bridge never held: junk ids must not push real receipts out of the capped file.
    if (decision === undefined) return this.final(request, id, by, digest, receiptOf(rid, now, "gone", "no such decision", null, null), false);
    if (decision.state !== "open") return this.final(request, id, by, digest, receiptOf(rid, now, "gone", `the decision is ${decision.state}`, decision.state, null));
    // Past its expiry and not swept yet: it is expired now, as the sweep would close it.
    if (decision.expiresAt !== null && decision.expiresAt <= now) {
      const expired = await this.final(request, id, by, digest, receiptOf(rid, now, "gone", "the decision is expired", "expired", null));
      this.closeAs(id, now, "expired", EXPIRED);
      return expired;
    }
    const option = decision.options.find((candidate) => candidate.intent === intent);
    // The intent is typed into the session; only a word the post rules let through ever is (a stored file is not re-checked on load).
    if (option !== undefined && !isHillOptionIntent(option.intent)) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", "not an option of this decision", "open", null));
    if (option === undefined && intent !== "answer" && intent !== "dismiss") return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", "not an option of this decision", "open", null));
    const cleaned = cleanText(request.value.text ?? "", HILL_ANSWER_TEXT_MAX);
    if (cleaned.over) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", `text is longer than ${String(HILL_ANSWER_TEXT_MAX)} characters`, "open", null));
    const text = cleaned.text === "" ? null : cleaned.text;
    const textRule = this.textRule(decision, intent, text);
    if (textRule !== null) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", textRule, "open", null));
    const body = answerMessage(decision, intent, option?.label ?? null, text, this.answersThePoster(decision));
    if (codePoints(body) > WALKY_BODY_MAX) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", "text is too long for one message", "open", null));

    // Where the answer goes: `replyTo`, else the poster. A trick with no `replyTo` has nothing to type into.
    const to = decision.replyTo ?? decision.from.address;
    if (decision.target !== null && to !== null && this.deps.place(to)?.address !== to) {
      const gone = await this.final(request, id, by, digest, receiptOf(rid, now, "gone", TARGET_ENDED, "undeliverable", null));
      this.closeAs(id, now, "undeliverable", TARGET_ENDED);
      return gone;
    }
    const state: HillState = intent === "dismiss" ? "dismissed" : "answered";
    const typed = decision.target !== null && to !== null;
    const trick = trickOf(decision);
    // Written first, as not confirmed: a bridge that stops after this line never types the answer twice,
    // and never runs the trick's tap twice (it reads `failed`, the tap that did not run).
    const firstTrick = trick === null ? "none" : "failed";
    const record: HillReceiptRecord = { requestId: rid, payloadDigest: digest, receipt: receiptOf(rid, now, "ok", null, state, typed ? "unknown" : "none", firstTrick) };
    if (!(await this.deps.receipts.recordFirst(record))) return { kind: "done", outcome: { kind: "unsaved" } };
    // A withdraw or an expiry may have closed it while the receipt was written.
    const fresh = this.deps.store.get(id);
    if (fresh === undefined || fresh.state !== "open") {
      const late = receiptOf(rid, now, "gone", `the decision is ${fresh?.state ?? "gone"}`, fresh?.state ?? null, null);
      return this.final(request, id, by, digest, late);
    }
    const closed: HillDecision = {
      ...fresh,
      state,
      closedAt: now,
      closedReason: null,
      answer: { rid, intent, label: option?.label ?? null, text, by: headerField(by, WALKY_LABEL_MAX), at: now, delivery: typed ? "unknown" : "none", trick: firstTrick },
    };
    if (!this.deps.store.put(closed)) {
      const unsaved = receiptOf(rid, now, "unknown", "the answer could not be saved on this machine; nothing was typed", "open", null);
      return this.final(request, id, by, digest, unsaved);
    }
    const send = typed && to !== null ? { to, body } : null;
    const tap = trick === null ? null : { host: trick.host, trickId: trick.trickId, decisionId: id, tap: { rid, node: hillNode(trick.trickKey), intent, value: { text } } };
    if (send === null && tap === null) {
      this.auditAnswer(closed, request, by, record.receipt);
      return { kind: "done", outcome: { kind: "receipt", receipt: record.receipt } };
    }
    return { kind: "deliver", decision: closed, record, send, tap };
  }

  /** Why the text breaks the decision's rule, or null when it keeps it. */
  private textRule(decision: HillDecision, intent: string, text: string | null): string | null {
    if (intent === "dismiss") return text === null ? null : "a dismiss carries no text";
    if (intent === "answer") {
      if (decision.text === "none") return "this decision takes no text";
      return text === null ? "text is required" : null;
    }
    if (decision.text === "required" && text === null) return "text is required";
    if (decision.text === "none" && text !== null) return "this decision takes no text";
    return null;
  }

  /** Close an open decision with no answer, as the sweep would: `undeliverable` or `expired`, with its reason. */
  private closeAs(id: string, now: number, state: "undeliverable" | "expired", reason: string): void {
    const decision = this.deps.store.get(id);
    if (decision === undefined || decision.state !== "open") return;
    this.deps.store.put({ ...decision, state, closedAt: now, closedReason: reason });
  }
}
