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
// ORDER ON AN ANSWER. Write the receipt, close the decision, then send. A send that fails or throws
// after the close leaves the decision answered with `delivery: "unknown"`, and nothing is sent again.

import { randomBytes } from "node:crypto";

import type { AuditEntry } from "../audit.ts";
import type { JsonObject } from "../json.ts";
import {
  HILL_ANSWER_TEXT_MAX,
  HILL_BODY_MAX,
  HILL_LINK_HREF_MAX,
  HILL_LINK_LABEL_MAX,
  HILL_LINKS_MAX,
  HILL_NOW_MAX,
  HILL_OPEN_MAX,
  HILL_OPTION_CONFIRM_MAX,
  HILL_OPTION_DETAIL_MAX,
  HILL_OPTION_LABEL_MAX,
  HILL_OPTIONS_MAX,
  HILL_SUMMARY_MAX,
  HILL_TITLE_MAX,
  HILL_WHY_MAX,
  isHillOptionIntent,
  sortOpenDecisions,
  type HillAnswerRequest,
  type HillDecision,
  type HillOption,
  type HillPostInput,
  type HillReceipt,
  type HillRefusalCode,
  type HillState,
} from "../../web/src/lib/hill/wire.ts";
import { cleanBody } from "../walky/clean.ts";
import type { WalkyPane } from "../walky/deliver.ts";
import { headerField, WALKY_BODY_MAX, WALKY_LABEL_MAX } from "../walky/types.ts";
import { digestDiffers, withDigest } from "../worktree-receipts.ts";
import { readPostFields } from "./parse.ts";
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

/** Code inside the bridge that posts for itself (a trick, later). Never reachable from the socket. */
export interface HillTrickSender {
  readonly kind: "trick";
  readonly trickId: string;
  readonly label: string;
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
  readonly now?: () => number;
  readonly mintId?: () => string;
  readonly audit?: (entry: AuditEntry) => void;
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
/** The closed reason of a decision whose target session ended, and the receipt's reason. */
export const TARGET_ENDED = "target session ended";
/** The closed reason of an expired decision. */
export const EXPIRED = "expired";
/** The first line of a dismiss's message carries this as its second line. */
export const DISMISSED = "Dismissed.";
/** How many characters of the title the answer message's first line keeps, the `…` included. */
export const MESSAGE_TITLE_MAX = 80;

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

/**
 * The walky message an answer types, as the contract spells it: `Answer to <id> "<title>"`, then
 * `Option: <intent> (<label>)` for an option, then the person's text when there is one. A dismiss is
 * the first line and `Dismissed.`.
 */
export function answerMessage(decision: Pick<HillDecision, "id" | "title">, intent: string, label: string | null, text: string | null): string {
  const lines = [`Answer to ${decision.id} "${messageTitle(decision.title)}"`];
  if (intent === "dismiss") return [...lines, DISMISSED].join("\n");
  if (intent !== "answer") lines.push(`Option: ${intent} (${label ?? intent})`);
  if (text !== null && text !== "") lines.push(text);
  return lines.join("\n");
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
function receiptOf(rid: string, at: number, code: HillReceipt["code"], reason: string | null, state: HillState | null, delivery: HillReceipt["delivery"]): HillReceipt {
  return { rid, code, reason, state, delivery, at };
}

/** What the claim step of an answer hands the send step, or the receipt that ends it. */
type Claim =
  | { readonly kind: "done"; readonly outcome: HillAnswerOutcome }
  | { readonly kind: "send"; readonly decision: HillDecision; readonly record: HillReceiptRecord; readonly to: string; readonly body: string };

export class HillService {
  private readonly now: () => number;
  private readonly mint: () => string;
  /** The answers' claim steps run one after another, so two taps cannot both find a decision open. */
  private lane: Promise<void> = Promise.resolve();

  constructor(private readonly deps: HillServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.mint = deps.mintId ?? (() => mintDecisionId());
  }

  /** The revision on the snapshot, or undefined while no decisions file exists. */
  rev(): number | undefined {
    return this.deps.store.rev();
  }

  /** What `GET /api/hill` serves. */
  list(): ReturnType<HillStore["list"]> {
    return this.deps.store.list();
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
    // A repeated request id from the same sender is the same decision: answered as stored, nothing checked again.
    const repeat = this.deps.store.all().find((decision) => decision.requestId === input.requestId && keyOf(decision) === key);
    if (repeat !== undefined) return { ok: true, decision: repeat };
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
    const open = this.deps.store.all().filter((decision) => decision.state === "open" && keyOf(decision) === key && decision.id !== superseded?.id);
    if (open.length >= HILL_OPEN_MAX) return refuse("too_many_open", `this session has ${String(HILL_OPEN_MAX)} open decisions; withdraw one, or wait for answers`);
    const asked = input.priority ?? "today";
    const priority = asked === "now" && open.filter((decision) => decision.priority === "now").length >= HILL_NOW_MAX ? "today" : asked;

    let id = this.mint();
    for (let tries = 0; this.deps.store.get(id) !== undefined && tries < 8; tries += 1) id = this.mint();
    if (this.deps.store.get(id) !== undefined) return refuse(null, "could not mint a decision id; try again");
    const decision: HillDecision = {
      v: 1,
      id,
      requestId: input.requestId,
      from:
        from.kind === "agent"
          ? { kind: "agent", address: from.address, trickId: null, memberId: from.memberId, harness: from.harness, label: from.label, host: from.host }
          : { kind: "trick", address: null, trickId: from.trickId, memberId: this.deps.memberId, harness: null, label: headerField(from.label, WALKY_LABEL_MAX), host: this.deps.machine },
      about: about?.address ?? null,
      priority,
      priorityAsked: asked,
      ...cleaned.fields,
      media: [],
      replyTo: replyTo?.address ?? null,
      target: target === null ? null : { label: target.label, host: target.host, unattended: target.unattended },
      supersedes: superseded?.id ?? null,
      supersededBy: null,
      expiresAt: input.expiresAt ?? null,
      at: now,
      state: "open",
      closedAt: null,
      closedReason: null,
      answer: null,
    };
    const replaced: HillDecision[] = superseded === null ? [] : [{ ...superseded, state: "superseded", supersededBy: id, closedAt: now, closedReason: `superseded by ${id}` }];
    if (!this.deps.store.put(decision, ...replaced)) return refuse(null, "the decision could not be saved on this machine; nothing was posted");
    const detail = superseded === null ? { decisionId: id, options: decision.options.length } : { decisionId: id, options: decision.options.length, supersedes: superseded.id };
    this.deps.audit?.({ action: "hill.post", detail });
    return { ok: true, decision };
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

  /** One of the sender's own decisions. Another sender's id answers as not found. */
  status(sender: HillSender, id: string): HillOneAnswer {
    const decision = this.mine(sender, id);
    return decision === null ? { ok: false, missing: true, error: `no decision ${id} from this session` } : { ok: true, decision };
  }

  /** The poster takes an open decision back. It closes `withdrawn`, "by the poster". */
  withdraw(sender: HillSender, id: string): HillOneAnswer {
    const decision = this.mine(sender, id);
    if (decision === null) return { ok: false, missing: true, error: `no decision ${id} from this session` };
    if (decision.state !== "open") return { ok: false, missing: false, error: `${id} is ${decision.state}, nothing to withdraw` };
    const closed: HillDecision = { ...decision, state: "withdrawn", closedAt: this.now(), closedReason: BY_THE_POSTER };
    if (!this.deps.store.put(closed)) return { ok: false, missing: false, error: "the change could not be saved on this machine; the decision stays open" };
    this.deps.audit?.({ action: "hill.withdraw", detail: { decisionId: id } });
    return { ok: true, decision: closed };
  }

  /** The sender's own decisions: open first (as the phone sorts them), then closed, newest first. */
  mineList(sender: HillSender): HillDecision[] {
    const key = senderKey(sender);
    const own = this.deps.store.all().filter((decision) => keyOf(decision) === key);
    const open = sortOpenDecisions(own.filter((decision) => decision.state === "open"));
    const closed = own.filter((decision) => decision.state !== "open").toSorted((a, b) => (b.closedAt ?? b.at) - (a.closedAt ?? a.at));
    return [...open, ...closed];
  }

  /** Close every open decision past its `expiresAt` as `expired`. Run from the bridge's slow timer. Answers how many closed. */
  sweep(now: number = this.now()): number {
    const due = this.deps.store.all().filter((decision) => decision.state === "open" && decision.expiresAt !== null && decision.expiresAt <= now);
    if (due.length === 0) return 0;
    const closed = due.map((decision): HillDecision => Object.assign({}, decision, { state: "expired" as const, closedAt: now, closedReason: EXPIRED }));
    return this.deps.store.put(...closed) ? closed.length : 0;
  }

  /**
   * One answer from a phone, by the receipt rules of the contract, in this order: a known `rid`, the
   * decision open, the intent, the text rule, the target still live; then the receipt, the close and
   * the send. `id` is the decision id the node named. `by` is the device's label, as operator walky uses it.
   */
  answer(request: HillAnswerRequest, id: string, by: string): Promise<HillAnswerOutcome> {
    const digest = hillAnswerDigest(request.node, request.intent, request.value.text);
    // SYNCHRONOUS from here to `track`: two requests with one rid must not both get past the look.
    const stored = this.deps.receipts.get(request.rid);
    if (stored !== undefined) return Promise.resolve(stored.payloadDigest === digest ? { kind: "receipt", receipt: stored.receipt } : { kind: "reused" });
    const running = this.deps.receipts.inflight(request.rid);
    if (running !== undefined) return digestDiffers(running, digest) ? Promise.resolve({ kind: "reused" }) : running;
    const work = withDigest(this.run(request, id, by, digest), digest);
    this.deps.receipts.track(request.rid, work);
    return work;
  }

  private async run(request: HillAnswerRequest, id: string, by: string, digest: string): Promise<HillAnswerOutcome> {
    const claimed = this.lane.then(() => this.claim(request, id, by, digest));
    this.lane = claimed.then(
      () => undefined,
      () => undefined,
    );
    const claim = await claimed;
    if (claim.kind === "done") return claim.outcome;
    let delivery: HillDelivery = "unknown";
    try {
      delivery = await this.deps.send(claim.to, claim.body, by);
    } catch {
      // Not confirmed, and never sent again: the decision stays answered with `unknown`.
      delivery = "unknown";
    }
    const receipt: HillReceipt = { ...claim.record.receipt, delivery };
    await this.deps.receipts.record({ ...claim.record, receipt });
    const now = this.deps.store.get(id);
    if (now?.answer?.rid === request.rid && now.answer.delivery !== delivery) this.deps.store.put({ ...now, answer: { ...now.answer, delivery } });
    this.auditAnswer(claim.decision, request, by, receipt);
    return { kind: "receipt", receipt };
  }

  private auditAnswer(decision: Pick<HillDecision, "id">, request: HillAnswerRequest, by: string, receipt: HillReceipt): void {
    this.deps.audit?.({
      action: "hill.answer",
      device: by,
      detail: { decisionId: decision.id, intent: request.intent, textLength: request.value.text?.length ?? 0, receiptCode: receipt.code, delivery: receipt.delivery ?? "none" },
    });
  }

  /** A receipt that ends the answer before any send: written, audited, answered. */
  private async final(request: HillAnswerRequest, id: string, by: string, digest: string, receipt: HillReceipt): Promise<Claim> {
    await this.deps.receipts.record({ requestId: request.rid, payloadDigest: digest, receipt });
    this.auditAnswer({ id }, request, by, receipt);
    return { kind: "done", outcome: { kind: "receipt", receipt } };
  }

  private async claim(request: HillAnswerRequest, id: string, by: string, digest: string): Promise<Claim> {
    const { rid, intent } = request;
    const now = this.now();
    const decision = this.deps.store.get(id);
    if (decision === undefined) return this.final(request, id, by, digest, receiptOf(rid, now, "gone", "no such decision", null, null));
    if (decision.state !== "open") return this.final(request, id, by, digest, receiptOf(rid, now, "gone", `the decision is ${decision.state}`, decision.state, null));
    const option = decision.options.find((candidate) => candidate.intent === intent);
    if (option === undefined && intent !== "answer" && intent !== "dismiss") return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", "not an option of this decision", "open", null));
    const cleaned = cleanText(request.value.text ?? "", HILL_ANSWER_TEXT_MAX);
    if (cleaned.over) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", `text is longer than ${String(HILL_ANSWER_TEXT_MAX)} characters`, "open", null));
    const text = cleaned.text === "" ? null : cleaned.text;
    const textRule = this.textRule(decision, intent, text);
    if (textRule !== null) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", textRule, "open", null));
    const body = answerMessage(decision, intent, option?.label ?? null, text);
    if (codePoints(body) > WALKY_BODY_MAX) return this.final(request, id, by, digest, receiptOf(rid, now, "rejected", "text is too long for one message", "open", null));

    // Where the answer goes: `replyTo`, else the poster. A trick with no `replyTo` has nothing to type into.
    const to = decision.replyTo ?? decision.from.address;
    if (decision.target !== null && to !== null && this.deps.place(to)?.address !== to) {
      const gone = await this.final(request, id, by, digest, receiptOf(rid, now, "gone", TARGET_ENDED, "undeliverable", null));
      this.closeUndeliverable(id, now);
      return gone;
    }
    const state: HillState = intent === "dismiss" ? "dismissed" : "answered";
    const typed = decision.target !== null && to !== null;
    // Written first, as not confirmed: a bridge that stops after this line never types the answer twice.
    const record: HillReceiptRecord = { requestId: rid, payloadDigest: digest, receipt: receiptOf(rid, now, "ok", null, state, typed ? "unknown" : "none") };
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
      answer: { rid, intent, label: option?.label ?? null, text, by: headerField(by, WALKY_LABEL_MAX), at: now, delivery: typed ? "unknown" : "none" },
    };
    if (!this.deps.store.put(closed)) {
      const unsaved = receiptOf(rid, now, "unknown", "the answer could not be saved on this machine; nothing was typed", "open", null);
      return this.final(request, id, by, digest, unsaved);
    }
    if (!typed || to === null) {
      this.auditAnswer(closed, request, by, record.receipt);
      return { kind: "done", outcome: { kind: "receipt", receipt: record.receipt } };
    }
    return { kind: "send", decision: closed, record, to, body };
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

  private closeUndeliverable(id: string, now: number): void {
    const decision = this.deps.store.get(id);
    if (decision === undefined || decision.state !== "open") return;
    this.deps.store.put({ ...decision, state: "undeliverable", closedAt: now, closedReason: TARGET_ENDED });
  }
}
