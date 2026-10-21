// The layout store and the handles a program holds: workspace, tab, pane.
// No Pi Durable import here, and no runtime import: it runs in Bun and in a Cloudflare Worker. A program (or an adapter) calls these methods; the server reads the store.
// Every id a program passes in is checked against the id rule, and every string is cleaned and cut to
// its byte cap (WIRE.md section 6) before it is stored, so the wire never carries a string over a cap.

import { randomHex, sha256Hex } from "./hash.ts";
import type { SeededAsk } from "./journal.ts";
import { type ReceiptStore, Receipts } from "./receipts.ts";
import { ACTION_ICONS } from "./types.ts";

/** The icon names the phone draws, for a lookup by any string. */
const ICON_NAMES: ReadonlySet<string> = new Set(ACTION_ICONS);
import {
  actionLabelOf,
  ANSWER_TEXT_DEFAULT,
  assertId,
  badgeOf,
  bytes,
  CAPS,
  cut,
  cwdOf,
  hrefOf,
  langOf,
  LIMITS,
  LINK_LABEL_MAX,
  maxLengthOf,
  PLACEHOLDER_MAX,
  progressOf,
  pushTextOf,
  shortLine,
  subtitleOf,
  tsOf,
} from "./rules.ts";
import type {
  ActionContext,
  Answer,
  AnswerResult,
  Ask,
  AskInput,
  AskOutcome,
  Badge,
  ChoiceAnswer,
  ChoiceAskInput,
  CloseTarget,
  ClosedBy,
  ConversationRow,
  DecidedBy,
  EventsReply,
  Field,
  FormAnswer,
  FormAskInput,
  HistoryProvider,
  Item,
  Option,
  PaneAction,
  PaneInfo,
  PaneRef,
  PermissionAnswer,
  PermissionAskInput,
  Progress,
  TextAnswer,
  TextAskInput,
  PaneState,
  ProgramEvent,
  ProgramHooks,
  SessionEvent,
  Snapshot,
  Starter,
  ToolCall,
  Workspace,
} from "./types.ts";

export const DEFAULT_TAIL = 500;
/** The newest events a pane keeps. The wire promises no more than 1000. */
export const MAX_TAIL = LIMITS.eventsPerReply;

/** At least 128 bits of randomness, as 32 hex characters. */
export const mintId = () => randomHex(16);

/**
 * The ask id of a tool call: SHA-256 over the pane id and the tool call id, as hex, the first 32 characters
 * (128 bits). It is not random on purpose. A program that raises the same tool call again after a restart gets
 * the same id, so an answer the phone sent across the wake lands (WIRE.md section 6, ADR 0100). The two ids are
 * joined with a newline, which the id rule keeps out of both, so no two pairs share an input.
 */
export const askIdFor = (paneId: string, toolCallId: string): string => sha256Hex(`${paneId}\n${toolCallId}`).slice(0, 32);

/**
 * An ask closed with no answer from the phone. `by` is the wire's word (`stopped`); `decidedBy` says who closed it: the
 * program (a stop, a close, an abort signal) or the clock past the ask's `expiresAt` (`timeout`, WIRE.md 7.3).
 */
export class AskClosed extends Error {
  readonly by: ClosedBy;
  readonly decidedBy: DecidedBy;
  constructor(by: ClosedBy, decidedBy: DecidedBy = by === "phone" ? "phone" : "program") {
    super(decidedBy === "timeout" ? "ask closed: timeout" : `ask closed: ${by}`);
    this.by = by;
    this.decidedBy = decidedBy;
  }
}

/** How many decided asks a pane remembers, newest first, so a second answer gets 409 `decided` with the first outcome. */
export const DECIDED_KEPT = 500;
/** The phone sent an answer that picks an id the ask does not offer. The server maps it to 400 `bad-option`. */
export class BadAnswer extends Error {
  readonly code: "bad-option" | "bad-body" = "bad-option";
}
/** The phone sent an answer of the wrong shape for the ask: a text over its `maxLength`, a missing required field. 400 `bad-body`. */
export class BadAnswerBody extends BadAnswer {
  override readonly code = "bad-body";
}

/**
 * What a host with no process of its own gives an ask it seeded ({@link PaneHandle.seedAsk}): the place an answer goes.
 * The pane has no promise to resolve for such an ask, so `answer` writes the answer where the host keeps its facts,
 * reads back who won, and says so.
 */
export interface AskSink {
  /** `revision` is the one of the open ask; the caller has checked it against the phone's. Either method may return a promise. */
  answer(askId: string, revision: number, answer: Answer, requestId: string): SinkReply | Promise<SinkReply>;
}

/**
 * What an {@link AskSink} says. `taken`: this answer stands (`at`, an ISO stamp, is when the host recorded it; absent,
 * the pane reads the clock). Not taken: the ask was decided first, with that outcome (409 `decided`), or the host does
 * not know the ask any more (`too-late`).
 */
export type SinkReply = { taken: true; at?: string } | { taken: false; decided: AskOutcome } | { taken: false; tooLate: true };

/** An answer through a sink found the ask decided already. The server maps it to 409 `decided` with the first outcome. */
export class AnswerDecided extends Error {
  readonly outcome: AskOutcome;
  constructor(outcome: AskOutcome) {
    super("ask decided");
    this.outcome = outcome;
  }
}

/** What a pane can be made with besides its title and harness. Every field is optional; left out, the pane is the memory pane. */
export interface PaneOptions {
  cwd?: string;
  sessionId?: string | null;
  /**
   * The pane's turn id, fixed by the host. A pane made without one mints a new id whenever it goes from not working to
   * working. A pane made with one keeps it: a host that derives its state from a log rebuilds the pane on every
   * request, so the turn id is a fact it computes, not an event the pane sees.
   */
  turnId?: string;
  /** True: `canSend` is false while the pane works or waits. For a host that cannot steer a running turn. */
  sendWhenIdleOnly?: boolean;
  /**
   * The pane's events cursor, fixed by the host: a whole number that rises whenever anything the pane shows changes. A
   * host that rebuilds the pane from its log on every request cannot replay the events between two cursors, so a read
   * at exactly this cursor (and this epoch) gets no events, and any other read gets the reset view with this cursor as
   * `next` (WIRE.md 7.2 allows a reset for any cursor). Left out, the pane counts its own events.
   */
  cursor?: number;
}

// ── cleaning ──────────────────────────────────────────────────────────────────

function cleanTool(t: ToolCall): ToolCall {
  const out: ToolCall = { kind: "other", name: cut(t.name, CAPS.toolName), summary: cut(t.summary, CAPS.summary, true) };
  if (t.output !== undefined && t.output !== null) out.output = cut(t.output, CAPS.output, true);
  return out;
}

type CodeItem = Extract<Item, { kind: "code" }>;
type LinkItem = Extract<Item, { kind: "link" }>;
type UserItem = Extract<Item, { kind: "user" }>;

/** What every cleaned item starts with: its id, and its stamp when it has a valid one. */
interface ItemHead {
  id: string;
  ts?: string;
}

export function cleanItem(item: Item): Item {
  assertId(item.id, "item id");
  const ts = tsOf(item.ts);
  const head: ItemHead = { id: item.id };
  if (ts) head.ts = ts;
  if (item.kind === "tool") return { ...head, kind: "tool", tool: cleanTool(item.tool), status: item.status };
  if (item.kind === "markdown") return { ...head, kind: "markdown", text: cut(item.text, CAPS.richText, true), ...partialOf(item) };
  if (item.kind === "code") {
    // A part of its own, so `lang` keeps its place between `kind` and `text`.
    const lang: Pick<CodeItem, "lang"> = {};
    if (item.lang !== undefined) lang.lang = langOf(item.lang);
    return { ...head, kind: "code", ...lang, text: cut(item.text, CAPS.richText, true) };
  }
  if (item.kind === "link") {
    const label = item.label === undefined ? undefined : shortLine(item.label, LINK_LABEL_MAX);
    const link: LinkItem = { ...head, kind: "link", href: hrefOf(item.href) };
    if (label !== undefined) link.label = label;
    return link;
  }
  if (item.kind === "user") {
    if (item.requestId !== undefined) assertId(item.requestId, "item requestId");
    const user: UserItem = { ...head, kind: "user", text: cut(item.text, CAPS.text, true) };
    if (item.requestId !== undefined) user.requestId = item.requestId;
    return user;
  }
  return { ...head, kind: item.kind, text: cut(item.text, CAPS.text, true), ...partialOf(item) };
}

/**
 * One row of the program's conversation list (WIRE.md 7.16), checked and cut to the wire's caps. An id that breaks the
 * id rule, a start that is not an ISO stamp, an unknown state or an item count that is not a whole number is a
 * TypeError: the program made a mistake, and the wire never carries what the adapter would drop.
 */
export function cleanConversationRow(row: ConversationRow): ConversationRow {
  assertId(row.id, "conversation id");
  const startedAt = tsOf(row.startedAt);
  if (startedAt === undefined) throw new TypeError(`a conversation's startedAt is an ISO 8601 stamp: ${JSON.stringify(row.startedAt)}`);
  if (row.state !== "open" && row.state !== "closed") throw new TypeError(`a conversation's state is open or closed: ${JSON.stringify(row.state)}`);
  if (!Number.isSafeInteger(row.items) || row.items < 0) throw new TypeError(`a conversation's item count is a whole number: ${JSON.stringify(row.items)}`);
  const out: ConversationRow = { id: row.id, title: cut(row.title, CAPS.title), startedAt, state: row.state, items: row.items };
  const subtitle = row.subtitle === undefined ? undefined : subtitleOf(row.subtitle);
  if (subtitle !== undefined) out.subtitle = subtitle;
  if (row.workspaceId !== undefined) out.workspaceId = assertId(row.workspaceId, "conversation workspaceId");
  if (row.tabId !== undefined) out.tabId = assertId(row.tabId, "conversation tabId");
  const endedAt = tsOf(row.endedAt);
  if (endedAt !== undefined) out.endedAt = endedAt;
  return out;
}

/** `partial: true` only when the program set exactly that. Anything else reads as a finished text (WIRE.md 7.15). */
const partialOf = (item: { partial?: true }): { partial?: true } => (item.partial === true ? { partial: true } : {});

/** An ask as `cleanAsk` takes it: an input with its id and revision set, or an open ask patched. */
type AskDraft = Pick<Ask, "id" | "revision" | "toolCallId" | "title" | "itemId" | "reason" | "tool" | "cleaned" | "push" | "multiple" | "placeholder" | "maxLength" | "fields"> & {
  kind: string;
  options?: Option[];
  expiresAt?: string | Date;
};

/** An ask's `expiresAt` as the wire carries it: ISO 8601 with a zone. A value that is no time is a TypeError. */
function expiresAtOf(value: string | Date | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const iso = value instanceof Date ? (Number.isNaN(value.getTime()) ? "" : value.toISOString()) : value;
  const stamp = tsOf(iso);
  if (stamp === undefined || Number.isNaN(Date.parse(stamp))) throw new TypeError(`an ask's expiresAt is an ISO 8601 stamp with a zone: ${JSON.stringify(value)}`);
  return stamp;
}

/** Ids of a list are unique and pass the id rule. `what` names them in the error. */
function checkIds(list: readonly { id: string }[], what: string): void {
  const seen = new Set<string>();
  for (const entry of list) {
    assertId(entry.id, `${what} id`);
    if (seen.has(entry.id)) throw new TypeError(`${what} id used twice: ${entry.id}`);
    seen.add(entry.id);
  }
}

/** The options of a `choice` ask or of a choice field: 1 to 8, no effect (WIRE.md 7.14). */
function cleanPlainOptions(raw: readonly Option[] | undefined, what: string): Option[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new TypeError(`${what} needs at least one option (WIRE.md 7.14)`);
  if (raw.length > LIMITS.choiceOptions) throw new RangeError(`${what} has at most ${LIMITS.choiceOptions} options (WIRE.md 7.14)`);
  checkIds(raw, "option");
  return raw.map((o) => {
    if (o.effect !== undefined) throw new TypeError(`${what} option has no effect: only a permission option does (WIRE.md 7.14)`);
    return { id: o.id, label: cut(o.label, CAPS.optionLabel) };
  });
}

function cleanField(raw: Field): Field {
  assertId(raw.id, "field id");
  if (raw.kind !== "text" && raw.kind !== "choice" && raw.kind !== "toggle") throw new TypeError(`a field has kind text, choice or toggle (WIRE.md 7.14): ${String(raw.kind)}`);
  const field: Field = { id: raw.id, label: cut(raw.label, CAPS.optionLabel), kind: raw.kind };
  if (raw.required === true) field.required = true;
  if (raw.kind === "text") {
    if (raw.options !== undefined) throw new TypeError("a text field has no options (WIRE.md 7.14)");
    if (raw.maxLength !== undefined) field.maxLength = maxLengthOf(raw.maxLength);
  } else if (raw.kind === "toggle") {
    if (raw.options !== undefined || raw.maxLength !== undefined) throw new TypeError("a toggle field has no options and no maxLength (WIRE.md 7.14)");
  } else {
    if (raw.maxLength !== undefined) throw new TypeError("a choice field has no maxLength (WIRE.md 7.14)");
    field.options = cleanPlainOptions(raw.options, "a choice field");
  }
  return field;
}

function cleanAsk(input: AskDraft): Ask {
  const kind = input.kind;
  if (kind !== "permission" && kind !== "choice" && kind !== "text" && kind !== "form") {
    throw new TypeError(`an ask has kind permission, choice, text or form (WIRE.md 7.14): ${String(kind)}`);
  }
  assertId(input.id, "ask id");
  assertId(input.toolCallId, "ask toolCallId");
  assertId(input.itemId, "ask itemId");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new RangeError("an ask revision starts at 1");
  const extra: Partial<Pick<Ask, "multiple" | "placeholder" | "maxLength" | "fields">> = {};
  let options: Option[] = [];
  if (kind === "permission") {
    if (!Array.isArray(input.options) || input.options.length === 0) throw new TypeError("an ask needs at least one option");
    checkIds(input.options, "option");
    options = input.options.slice(0, LIMITS.options).map((o) => {
      if (!["allow", "allow-always", "deny", "cancel"].includes(String(o.effect))) throw new TypeError(`bad option effect: ${String(o.effect)}`);
      return { id: o.id, label: cut(o.label, CAPS.optionLabel), effect: o.effect };
    });
  } else if (kind === "choice") {
    options = cleanPlainOptions(input.options, "a choice ask");
    if (input.multiple === true) extra.multiple = true;
  } else if (kind === "text") {
    if (input.options !== undefined && input.options.length > 0) throw new TypeError("a text ask has no options (WIRE.md 7.14)");
    if (input.placeholder !== undefined) {
      const hint = shortLine(input.placeholder, PLACEHOLDER_MAX);
      if (hint !== undefined) extra.placeholder = hint;
    }
    if (input.maxLength !== undefined) extra.maxLength = maxLengthOf(input.maxLength);
  } else {
    if (input.options !== undefined && input.options.length > 0) throw new TypeError("a form ask has fields, not options (WIRE.md 7.14)");
    if (!Array.isArray(input.fields) || input.fields.length === 0) throw new TypeError("a form ask needs at least one field (WIRE.md 7.14)");
    if (input.fields.length > LIMITS.formFields) throw new RangeError(`a form ask has at most ${LIMITS.formFields} fields (WIRE.md 7.14)`);
    checkIds(input.fields, "field");
    extra.fields = input.fields.map(cleanField);
  }
  const title = cut(input.title, CAPS.askTitle);
  const ask: Ask = {
    id: input.id,
    kind,
    toolCallId: input.toolCallId,
    revision: input.revision,
    title,
    itemId: input.itemId,
    options,
  };
  Object.assign(ask, extra);
  // `cleaned` (WIRE.md section 4): the title or the reason is not what the program passed in. It stays once set.
  let cleaned = input.cleaned === true || title !== String(input.title ?? "");
  if (input.reason !== undefined && input.reason !== null) {
    ask.reason = cut(input.reason, CAPS.reason, true);
    cleaned ||= ask.reason !== String(input.reason);
  }
  if (cleaned) ask.cleaned = true;
  if (input.tool) ask.tool = cleanTool(input.tool);
  const push = pushTextOf(input.push);
  if (push !== undefined) ask.push = push;
  const expiresAt = expiresAtOf(input.expiresAt);
  if (expiresAt !== undefined) ask.expiresAt = expiresAt;
  return ask;
}

/** What a program may change in an open ask (WIRE.md 7.14). Its kind and its ids stay. */
export interface AskPatch {
  title?: string;
  reason?: string;
  tool?: ToolCall;
  options?: Option[];
  placeholder?: string;
  maxLength?: number;
  fields?: Field[];
}

/** The characters of a string, counted as the wire counts them (code points). */
const lengthOf = (text: string): number => [...text].length;

/**
 * Whether the phone's answer fits the ask (WIRE.md 7.3 and 7.14): an id the ask does not offer is `BadAnswer`; the wrong
 * shape for the kind, a text over its `maxLength`, a missing required field, or a pick count the ask does not take
 * is `BadAnswerBody`.
 */
function checkAnswer(ask: Ask, answer: Answer): void {
  if (ask.kind === "choice") {
    if (!("optionIds" in answer)) throw new BadAnswerBody("a choice ask takes optionIds");
    const ids = answer.optionIds;
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw new BadAnswerBody("optionIds are one or more distinct ids");
    if (ids.some((id) => !ask.options.some((o) => o.id === id))) throw new BadAnswer("unknown option");
    if (ids.length > 1 && ask.multiple !== true) throw new BadAnswerBody("this choice takes one option");
    return;
  }
  if (ask.kind === "text") {
    if (!("text" in answer)) throw new BadAnswerBody("a text ask takes text");
    const size = lengthOf(answer.text);
    if (size < 1 || size > (ask.maxLength ?? ANSWER_TEXT_DEFAULT)) throw new BadAnswerBody("the text is empty or over the ask's maxLength");
    return;
  }
  if (ask.kind === "form") {
    if (!("values" in answer)) throw new BadAnswerBody("a form ask takes values");
    checkForm(ask.fields ?? [], answer.values);
    return;
  }
  if (!("optionId" in answer)) throw new BadAnswerBody("a permission takes an optionId");
  if (!ask.options.some((o) => o.id === answer.optionId)) throw new BadAnswer("unknown option");
}

/** The values of a form against its fields. */
function checkForm(fields: readonly Field[], values: FormAnswer["values"]): void {
  for (const key of Object.keys(values)) {
    if (!fields.some((f) => f.id === key)) throw new BadAnswerBody(`no field ${key}`);
  }
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined) {
      if (field.required === true) throw new BadAnswerBody(`field ${field.id} is required`);
      continue;
    }
    if (field.kind === "toggle") {
      if (value !== true && value !== false) throw new BadAnswerBody(`field ${field.id} is a toggle`);
    } else if (value === true || value === false || Array.isArray(value)) {
      throw new BadAnswerBody(`field ${field.id} takes one string`);
    } else if (field.kind === "text") {
      if (lengthOf(value) > (field.maxLength ?? ANSWER_TEXT_DEFAULT) || (field.required === true && value === "")) throw new BadAnswerBody(`field ${field.id} is over its maxLength or empty`);
    } else if (!(field.options ?? []).some((o) => o.id === value)) {
      throw new BadAnswer("unknown option");
    }
  }
}

function cleanEvent(e: ProgramEvent): ProgramEvent {
  // Read before the switch: past the last case the types say nothing is left, and a caller past the types still sent a type.
  const named = e.type;
  switch (e.type) {
    case "item":
      return { type: "item", item: cleanItem(e.item) };
    case "remove":
      return { type: "remove", id: assertId(e.id, "remove id") };
    case "settled": {
      const out: ProgramEvent = { type: "settled", inputId: assertId(e.inputId, "settled inputId"), status: e.status };
      if (e.requestId !== undefined && e.requestId !== null) out.requestId = assertId(e.requestId, "settled requestId");
      if (e.reason !== undefined && e.reason !== null) out.reason = cut(e.reason, CAPS.settledReason);
      return out;
    }
    case "reset":
    case "synced":
      return { type: e.type };
    default:
      throw new TypeError(`a program may not append a ${named} event`);
  }
}

// ── handles ───────────────────────────────────────────────────────────────────

export interface SendContext {
  /** Join the running turn (true) or wait for the next one (false). On an idle pane: no effect. */
  steer: boolean;
  /** Pass it on to the program's own input call, for example Pi Durable's `submit({ requestId })`. */
  requestId: string;
}

export interface PaneHandle {
  readonly id: string;
  /** The conversation id the program's history serves this pane under (WIRE.md 7.16), or null. */
  readonly sessionId: string | null;
  /** The newest turn: the running one, or the last one that ran. */
  readonly turnId: string;
  /** Every open ask, oldest first, at most 50. */
  readonly openAsks: Ask[];
  state(s: PaneState): void;
  /**
   * One line under the conversation's title (WIRE.md 7.11), cut to 120 characters. `null` clears it. The revision
   * rises only when what the phone reads changes.
   */
  subtitle(text: string | null): void;
  /**
   * A small mark next to the title (WIRE.md 7.11): `{ count }` with an integer from 0 to 9999, or `{ text }` of at
   * most 12 characters. `null` clears it. A bad count is a RangeError. The revision rises only on a change.
   */
  badge(value: Badge | null): void;
  /**
   * How far a working conversation is (WIRE.md 7.12): `{ kind: "steps", steps }` with 1 to 12 steps (more are left
   * out), or `{ kind: "percent", value, label? }` with a value from 0 to 100. `null` clears it; the program owns
   * clearing, and the phone draws it only while the pane works or waits. A bad shape is a TypeError or RangeError.
   * The revision rises only on a change.
   */
  progress(value: Progress | null): void;
  event(e: ProgramEvent): void;
  /**
   * Sets the pane to `waiting`, emits `ask`, resolves with the phone's answer. Without an `id`, the ask id comes
   * from the pane and the tool call ({@link askIdFor}), so it is the same after a restart.
   */
  ask(ask: PermissionAskInput, opts?: { signal?: AbortSignal }): Promise<PermissionAnswer>;
  /** A `choice` ask (WIRE.md 7.14): resolves with `{ optionIds }`, one id unless the ask is `multiple`. */
  ask(ask: ChoiceAskInput, opts?: { signal?: AbortSignal }): Promise<ChoiceAnswer>;
  /** A `text` ask: resolves with `{ text }`. */
  ask(ask: TextAskInput, opts?: { signal?: AbortSignal }): Promise<TextAnswer>;
  /** A `form` ask: resolves with `{ values }`, keyed by field id. */
  ask(ask: FormAskInput, opts?: { signal?: AbortSignal }): Promise<FormAnswer>;
  ask(ask: AskInput, opts?: { signal?: AbortSignal }): Promise<Answer>;
  /** Change an open ask in place. Its revision rises by one. False when the ask is not open. */
  updateAsk(askId: string, patch: AskPatch): boolean;
  /**
   * The program decided an open ask itself, somewhere other than the phone (WIRE.md 7.3): it closes with
   * `decidedBy: "program"`, so the phone says it was decided in the program, not that it stopped. With `answer`, the
   * waiting `ask()` resolves with it, as if the phone had sent it; without, it rejects with `AskClosed` (`decidedBy`
   * `program`). A later answer from the phone gets 409 `decided`. False when the ask is not open.
   */
  decideAsk(askId: string, answer?: Answer): boolean;
  /** The first decision of an ask this pane closed, with who and when, or undefined for one it never raised or forgot. */
  outcomeOf(askId: string): AskOutcome | undefined;
  /**
   * Open an ask a host read from its own durable record (`foldJournal`), not one a program raised: it has no promise
   * and no timer. The pane goes to `waiting` and shows the ask, as `ask()` would. An answer from the phone goes to
   * `sink.answer`, and is `taken` only when the sink says this answer stands. An ask past its `expiresAt` closes at the
   * next read, decided by `timeout` at exactly `expiresAt`, so every instance of the host says the same. The ask is
   * checked as `ask()` checks it: a bad record is a TypeError. Nothing else moves: no `lastActiveAt`, no revision.
   */
  seedAsk(record: SeededAsk, sink: AskSink): void;
  /** Remember the first outcome of asks decided before this pane existed, oldest first, so a late tap gets 409 `decided`. */
  seedDecided(outcomes: ReadonlyMap<string, AskOutcome>): void;
  onSend(fn: (text: string, o: SendContext) => void | Promise<void>): void;
  onAbort(fn: (o: { requestId: string }) => void | Promise<void>): void;
  /**
   * Set the pane's belt actions (WIRE.md 7.10): at most 4, each with an id, a label of at most 16 characters
   * and an optional icon, `busy` and `disabled`. `null` or an empty list clears them. `rev` rises only when the
   * list changed. An id that breaks the id rule throws.
   */
  actions(list: PaneAction[] | null): void;
  /** Run a tap on one of the pane's actions. Return `false` to refuse it (422 `action-refused`). */
  onAction(fn: (o: ActionContext) => boolean | void | Promise<boolean | void>): void;
  close(): void;
}
export interface TabHandle {
  readonly id: string;
  /**
   * `sessionId`: the conversation id the program's history serves this pane under (WIRE.md 7.16). Left out, it is
   * the pane id once a history provider is set, and null before. Pass `null` when the id does not stay the same
   * across a restart.
   */
  pane(id: string, o: PaneOptions & { title: string; harness: string }): PaneHandle;
}
export interface WorkspaceHandle {
  readonly id: string;
  tab(id: string, o: { title: string }): TabHandle;
}

interface OpenAsk {
  ask: Ask;
  openedAt: number;
  /** Absent on a seeded ask: the host that seeded it has no promise to resolve. */
  resolve?: (a: Answer) => void;
  reject?: (e: Error) => void;
  /** Present on a seeded ask: where an answer goes. */
  sink?: AskSink;
  /** The timer that closes the ask at its `expiresAt`. A snapshot or an answer sweeps it too, for a host whose timers sleep. */
  timer?: ReturnType<typeof setTimeout>;
}

export class Pane implements PaneHandle {
  base: PaneState = "idle";
  lastActiveAt = Date.now();
  turnId: string;
  /** True when the host fixed the turn id: `state()` never mints one. */
  private readonly turnFixed: boolean;
  private readonly sendWhenIdleOnly: boolean;
  /** The host's cursor ({@link PaneOptions.cursor}), or undefined for a pane that counts its own events. */
  private readonly fixedCursor: number | undefined;
  /** The raw tail: the newest `limit` events. `total` counts every event ever, so a cursor is `total` at read time. */
  readonly tail: SessionEvent[] = [];
  private total = 0;
  /** The compacted history: the latest version of each item, in order of first appearance. */
  private readonly items = new Map<string, Item>();
  readonly asks = new Map<string, OpenAsk>();
  /** The first decision of each ask closed in this process, newest last, at most {@link DECIDED_KEPT}. */
  private readonly decided = new Map<string, AskOutcome>();
  closed = false;
  private subtitleText: string | undefined;
  private badgeValue: Badge | undefined;
  private progressValue: Progress | undefined;
  sendFn?: (text: string, o: SendContext) => void | Promise<void>;
  abortFn?: (o: { requestId: string }) => void | Promise<void>;
  actionFn?: (o: ActionContext) => boolean | void | Promise<boolean | void>;
  private actionList: PaneAction[] = [];
  /** The state last put in the log. Unset until the first sync, so the log always starts with one. */
  private shown?: PaneState;
  private readonly limit: number;
  private store: Store;
  readonly id: string;
  readonly tabId: string;
  readonly workspaceId: string;
  title: string;
  readonly harness: string;
  readonly cwd: string | undefined;
  /** The program's own session id, when it passed one. Undefined: the default of {@link sessionId}. */
  private readonly session?: string | null;

  // Plain fields, no parameter properties: the SDK is erasable TypeScript, so Node runs it with its type stripping.
  constructor(
    store: Store,
    id: string,
    tabId: string,
    workspaceId: string,
    title: string,
    harness: string,
    cwd: string | undefined,
    limit = DEFAULT_TAIL,
    session?: string | null,
    extra: Pick<PaneOptions, "turnId" | "sendWhenIdleOnly" | "cursor"> = {},
  ) {
    this.store = store;
    this.id = id;
    this.tabId = tabId;
    this.workspaceId = workspaceId;
    this.title = title;
    this.harness = harness;
    this.cwd = cwd;
    this.session = session;
    this.turnFixed = extra.turnId !== undefined;
    this.turnId = extra.turnId === undefined ? mintId() : assertId(extra.turnId, "pane turnId");
    this.sendWhenIdleOnly = extra.sendWhenIdleOnly === true;
    if (extra.cursor !== undefined && (!Number.isSafeInteger(extra.cursor) || extra.cursor < 0)) throw new RangeError(`a pane's cursor is a whole number from 0: ${extra.cursor}`);
    this.fixedCursor = extra.cursor;
    this.limit = Math.min(limit, MAX_TAIL);
  }

  /** The conversation id of this pane's history: the program's own, else the pane id once history is served, else null. */
  get sessionId(): string | null {
    if (this.session !== undefined) return this.session;
    return this.store.history === undefined ? null : this.id;
  }

  private append(e: SessionEvent) {
    this.total++;
    this.tail.push(e);
    while (this.tail.length > this.limit) this.tail.shift();
    if (e.type === "item") this.items.set(e.item.id, e.item);
    else if (e.type === "remove") this.items.delete(e.id);
    else if (e.type === "reset") this.items.clear();
  }

  /**
   * The events past a cursor (WIRE.md 7.2). A cursor inside the tail gets plain events, at most 1000 and
   * at most 8 MiB, with `more` when it stopped early. A stale epoch, a cursor older than the tail or a
   * cursor past the count gets `reset: true` and the whole current view of the pane. A pane with a host's
   * cursor ({@link PaneOptions.cursor}) answers nothing at that cursor and the reset view at any other.
   */
  eventsAfter(after: number, staleEpoch: boolean): Omit<EventsReply, "epoch"> {
    if (this.fixedCursor !== undefined) {
      // A host's cursor names a whole view, not a place in a tail: the same cursor is nothing new, any other one a reset.
      if (!staleEpoch && after === this.fixedCursor) return { events: [], next: this.fixedCursor };
      return { ...this.resetView(), next: this.fixedCursor };
    }
    const start = this.total - this.tail.length;
    if (!staleEpoch && after >= start && after <= this.total) {
      const events: SessionEvent[] = [];
      let size = 0;
      for (let i = after - start; i < this.tail.length && events.length < LIMITS.eventsPerReply; i++) {
        const n = bytes(JSON.stringify(this.tail[i]));
        if (events.length > 0 && size + n > LIMITS.replyBytes) break;
        events.push(this.tail[i]!);
        size += n;
      }
      const next = after + events.length;
      const reply: Omit<EventsReply, "epoch"> = { events, next };
      if (next < this.total) reply.more = true;
      return reply;
    }
    return this.resetView();
  }

  /** The whole current view of the pane (WIRE.md 7.2): its items, its open asks, its state, with `next` at the count. */
  private resetView(): Omit<EventsReply, "epoch"> {
    // The newest items that fit: at most 2000, and inside the reply budget with room for the asks.
    const asks = this.openAsks;
    let budget = LIMITS.replyBytes - asks.reduce((n, a) => n + bytes(JSON.stringify(a)), 0) - 1024;
    const kept: Item[] = [];
    const all = [...this.items.values()];
    for (let i = all.length - 1; i >= 0 && kept.length < LIMITS.resetItems; i--) {
      const n = bytes(JSON.stringify(all[i]));
      if (kept.length > 0 && n > budget) break;
      kept.push(all[i]!);
      budget -= n;
    }
    kept.reverse();
    const events: SessionEvent[] = [{ type: "reset" }];
    for (const item of kept) events.push({ type: "item", item });
    for (const ask of asks) events.push({ type: "ask", ask });
    events.push({ type: "state", state: this.effective }, { type: "synced" });
    const trimmed = all.length - kept.length;
    const reply: Omit<EventsReply, "epoch"> = { events, next: this.total, reset: true };
    if (trimmed > 0) reply.trimmed = trimmed;
    return reply;
  }

  /** What the phone sees: waiting while any ask is open, else the program's own state. */
  get effective(): PaneState {
    return this.asks.size > 0 ? "waiting" : this.base;
  }

  /** Every open ask, oldest first, at most 50. A Map keeps insertion order, which holds when two asks share a millisecond. */
  get openAsks(): Ask[] {
    return [...this.asks.values()].slice(0, LIMITS.openAsksPerPane).map((o) => o.ask);
  }

  /** Every open ask id, for a `stale` reply. */
  get openAskIds(): string[] {
    return [...this.asks.keys()];
  }

  info(): PaneInfo {
    // Two parts of their own, so each field keeps its place in the snapshot: `actions` before `sessionId`, the rest after.
    const actions: Pick<PaneInfo, "actions"> = {};
    if (this.actionList.length > 0) actions.actions = this.actionList.map((a) => ({ ...a }));
    const rest: Pick<PaneInfo, "cwd" | "subtitle" | "badge" | "progress"> = {};
    if (this.cwd) rest.cwd = this.cwd;
    if (this.subtitleText !== undefined) rest.subtitle = this.subtitleText;
    if (this.badgeValue !== undefined) rest.badge = this.badgeValue;
    if (this.progressValue !== undefined) rest.progress = this.progressValue;
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      tabId: this.tabId,
      title: this.title,
      harness: this.harness,
      state: this.effective,
      lastActiveAt: this.lastActiveAt,
      turnId: this.turnId,
      openAsks: this.openAsks,
      ...actions,
      // The conversation id the program's history serves this pane under (WIRE.md 7.16), or null.
      sessionId: this.sessionId,
      ...rest,
    };
  }

  private touch() {
    this.lastActiveAt = Date.now();
    this.store.rev++;
  }

  private sync() {
    if (this.effective === this.shown) return;
    this.shown = this.effective;
    this.append({ type: "state", state: this.shown });
  }

  state(s: PaneState) {
    // A new turn starts when the pane goes from not working to working.
    if (s === "working" && this.base !== "working" && !this.turnFixed) this.turnId = mintId();
    this.base = s;
    this.sync();
    this.touch();
  }

  subtitle(text: string | null) {
    const next = text === null ? undefined : subtitleOf(text);
    if (next === this.subtitleText) return;
    this.subtitleText = next;
    this.store.rev++;
  }

  badge(value: Badge | null) {
    const next = value === null ? undefined : badgeOf(value);
    const same = next === undefined || this.badgeValue === undefined ? next === this.badgeValue : JSON.stringify(next) === JSON.stringify(this.badgeValue);
    if (same) return;
    this.badgeValue = next;
    this.store.rev++;
  }

  progress(value: Progress | null) {
    const next = value === null ? undefined : progressOf(value);
    const same = next === undefined || this.progressValue === undefined ? next === this.progressValue : JSON.stringify(next) === JSON.stringify(this.progressValue);
    if (same) return;
    this.progressValue = next;
    this.store.rev++;
  }

  event(e: ProgramEvent) {
    this.append(cleanEvent(e));
    this.touch();
  }

  ask(ask: PermissionAskInput, opts?: { signal?: AbortSignal }): Promise<PermissionAnswer>;
  ask(ask: ChoiceAskInput, opts?: { signal?: AbortSignal }): Promise<ChoiceAnswer>;
  ask(ask: TextAskInput, opts?: { signal?: AbortSignal }): Promise<TextAnswer>;
  ask(ask: FormAskInput, opts?: { signal?: AbortSignal }): Promise<FormAnswer>;
  ask(ask: AskInput, opts?: { signal?: AbortSignal }): Promise<Answer>;
  ask(input: AskInput, opts: { signal?: AbortSignal } = {}): Promise<Answer> {
    // Revision 1 on every raise: a tool call raised again after a restart has the same options by construction.
    const ask = cleanAsk({ ...input, id: input.id ?? askIdFor(this.id, input.toolCallId), revision: 1 });
    this.refuseAllowAlways(ask.options);
    if (this.asks.has(ask.id)) throw new TypeError(`ask id already open: ${ask.id}`);
    return new Promise<Answer>((resolve, reject) => {
      const open: OpenAsk = { ask, openedAt: Date.now(), resolve, reject };
      this.asks.set(ask.id, open);
      this.append({ type: "ask", ask });
      this.sync();
      this.touch();
      const stop = () => this.closeAsk(ask.id, "stopped", "program", new AskClosed("stopped", "program"));
      if (opts.signal?.aborted) stop();
      else opts.signal?.addEventListener("abort", stop, { once: true });
      if (ask.expiresAt !== undefined && this.asks.has(ask.id)) {
        open.timer = setTimeout(() => this.sweep(), Math.max(0, Date.parse(ask.expiresAt) - Date.now()));
      }
    });
  }

  seedAsk(record: SeededAsk, sink: AskSink): void {
    if (record.askId !== record.ask.id) throw new TypeError(`a seeded ask's record names ${record.askId} but its ask is ${record.ask.id}`);
    const ask = cleanAsk({ ...record.ask, expiresAt: record.expiresAt ?? record.ask.expiresAt });
    this.refuseAllowAlways(ask.options);
    if (this.asks.has(ask.id)) throw new TypeError(`ask id already open: ${ask.id}`);
    const openedAt = Date.parse(record.openedAt);
    this.asks.set(ask.id, { ask, openedAt: Number.isNaN(openedAt) ? Date.now() : openedAt, sink });
    this.append({ type: "ask", ask });
    this.sync();
  }

  seedDecided(outcomes: ReadonlyMap<string, AskOutcome>): void {
    for (const [askId, o] of outcomes) {
      const kept: AskOutcome = { decidedBy: o.decidedBy, decidedAt: o.decidedAt };
      if (o.optionId !== undefined) kept.optionId = o.optionId;
      if (o.effect !== undefined) kept.effect = o.effect;
      this.decided.delete(askId);
      this.decided.set(askId, kept);
    }
    while (this.decided.size > DECIDED_KEPT) this.decided.delete(this.decided.keys().next().value!);
  }

  /**
   * Close every open ask whose `expiresAt` has passed, as decided by `timeout` (WIRE.md 7.3). The timer of each ask
   * calls it, and so does every snapshot and every answer, so an ask reads as timed out on the next read even on a
   * host that put its timers to sleep.
   */
  sweep(now = Date.now()) {
    // A Map walk survives `closeAsk` deleting the entry it stands on.
    for (const [id, open] of this.asks) {
      if (open.ask.expiresAt !== undefined && Date.parse(open.ask.expiresAt) <= now) {
        // A seeded ask closes AT its expiry, not at the read, so the instances of a host with no process say the same thing.
        this.closeAsk(id, "stopped", "timeout", new AskClosed("stopped", "timeout"), undefined, open.sink === undefined ? undefined : open.ask.expiresAt);
      }
    }
  }

  /** The first decision of an ask this pane closed, or undefined for one it never raised or no longer remembers. */
  outcomeOf(askId: string): AskOutcome | undefined {
    return this.decided.get(askId);
  }

  /** A core made with `allowAlways: false` takes no `allow-always` option: over TLS the token is the only gate. */
  private refuseAllowAlways(options: readonly { effect?: string }[]): void {
    if (this.store.allowAlways || !options.some((o) => o.effect === "allow-always")) return;
    throw new TypeError(
      "an ask option with effect allow-always is refused: this durable agent is reached over TLS with a token (WIRE.md 1B), so it offers Allow and Deny only",
    );
  }

  updateAsk(askId: string, patch: AskPatch): boolean {
    const open = this.asks.get(askId);
    if (!open) return false;
    const { ask } = open;
    const next = cleanAsk({ ...ask, ...patch, revision: ask.revision + 1 });
    this.refuseAllowAlways(next.options);
    open.ask = next;
    this.append({ type: "ask", ask: open.ask });
    this.touch();
    return true;
  }

  decideAsk(askId: string, answer?: Answer): boolean {
    const open = this.asks.get(askId);
    if (!open) return false;
    if (answer === undefined) {
      this.closeAsk(askId, "stopped", "program", new AskClosed("stopped", "program"));
      return true;
    }
    checkAnswer(open.ask, answer);
    open.resolve?.(answer);
    this.closeAsk(askId, "stopped", "program", undefined, answer);
    return true;
  }

  private closeAsk(askId: string, by: ClosedBy, decidedBy: DecidedBy, err?: Error, answer?: Answer, decidedAt = new Date().toISOString()) {
    const open = this.asks.get(askId);
    if (!open) return;
    // The receipt of the decision: who and when, and for a permission the option and its effect.
    const outcome: AskOutcome = { decidedBy, decidedAt };
    if (answer !== undefined && "optionId" in answer) {
      outcome.optionId = answer.optionId;
      const effect = open.ask.options.find((o) => o.id === answer.optionId)?.effect;
      if (effect !== undefined) outcome.effect = effect;
    }
    this.settle(askId, open, by, outcome, err);
  }

  /** Take an ask out of the open ones with its outcome: the receipt, the event, the state. */
  private settle(askId: string, open: OpenAsk, by: ClosedBy, outcome: AskOutcome, err?: Error) {
    this.asks.delete(askId);
    if (open.timer !== undefined) clearTimeout(open.timer);
    this.decided.set(askId, outcome);
    if (this.decided.size > DECIDED_KEPT) this.decided.delete(this.decided.keys().next().value!);
    this.append({ type: "ask-closed", askId, by, waitedMs: Date.now() - open.openedAt, decidedBy: outcome.decidedBy, decidedAt: outcome.decidedAt });
    this.sync();
    this.touch();
    if (err) open.reject?.(err);
  }

  /**
   * The phone answers (WIRE.md 7.3). The caller has checked the revision. A closed or unknown ask is
   * `too-late`; an option that is not offered throws `BadAnswer` (400 `bad-option`), and an answer of the wrong
   * shape for the ask's kind throws `BadAnswerBody` (400 `bad-body`, WIRE.md 7.14). An ask raised again after a restart has its
   * old id, so an answer to the id the phone saw before the wake lands here.
   */
  answer(askId: string, answer: Answer, requestId = ""): AnswerResult | Promise<AnswerResult> {
    const open = this.asks.get(askId);
    if (!open) return "too-late";
    checkAnswer(open.ask, answer);
    if (open.sink !== undefined) return this.answerThrough(open, open.sink, answer, requestId);
    open.resolve?.(answer);
    this.closeAsk(askId, "phone", "phone", undefined, answer);
    return "taken";
  }

  /**
   * An answer to a seeded ask goes to its sink, and the pane believes the sink: `taken` closes the ask as the phone's,
   * `decided` closes it with the first outcome and throws {@link AnswerDecided}, and `too-late` changes nothing.
   */
  private async answerThrough(open: OpenAsk, sink: AskSink, answer: Answer, requestId: string): Promise<AnswerResult> {
    const askId = open.ask.id;
    const reply = await sink.answer(askId, open.ask.revision, answer, requestId);
    if (reply.taken) {
      if (this.asks.get(askId) === open) this.closeAsk(askId, "phone", "phone", undefined, answer, reply.at);
      return "taken";
    }
    if ("decided" in reply) {
      if (this.asks.get(askId) === open) this.settle(askId, open, reply.decided.decidedBy === "phone" ? "phone" : "stopped", reply.decided);
      throw new AnswerDecided(reply.decided);
    }
    return "too-late";
  }

  onSend(fn: (text: string, o: SendContext) => void | Promise<void>) {
    this.sendFn = fn;
  }
  onAbort(fn: (o: { requestId: string }) => void | Promise<void>) {
    this.abortFn = fn;
  }
  actions(list: PaneAction[] | null) {
    const seen = new Set<string>();
    const next: PaneAction[] = [];
    for (const given of list ?? []) {
      if (next.length >= LIMITS.actions) break;
      const id = assertId(given.id, "action id");
      const label = actionLabelOf(given.label);
      if (label === "" || seen.has(id)) continue;
      seen.add(id);
      const action: PaneAction = { id, label };
      if (given.icon !== undefined && ICON_NAMES.has(given.icon)) action.icon = given.icon;
      if (given.busy === true) action.busy = true;
      if (given.disabled === true) action.disabled = true;
      next.push(action);
    }
    if (JSON.stringify(next) === JSON.stringify(this.actionList)) return;
    this.actionList = next;
    this.store.rev++;
  }
  onAction(fn: (o: ActionContext) => boolean | void | Promise<boolean | void>) {
    this.actionFn = fn;
  }
  /** The actions the phone may tap now: listed, and neither busy nor disabled. */
  get actionRows(): readonly PaneAction[] {
    return this.actionList;
  }
  /** A pane runs an action when it has its own handler or the program has an `onAction` hook (the fallback). */
  get canAct() {
    return this.actionFn !== undefined || this.store.hooks.onAction !== undefined;
  }
  /** The pane's own handler wins; the program's `onAction` hook runs for a pane that has none. False: the program refused. */
  async act(o: ActionContext): Promise<boolean> {
    const said = this.actionFn ? await this.actionFn(o) : await this.store.hooks.onAction?.(this.ref, o);
    this.touch();
    return said !== false;
  }

  /** A pane takes text when it has its own handler or the program has an `onSend` hook (the fallback). */
  get canSend() {
    if (this.sendWhenIdleOnly && this.effective !== "idle") return false;
    return this.sendFn !== undefined || this.store.hooks.onSend !== undefined;
  }
  get canAbort() {
    return this.abortFn !== undefined || this.store.hooks.onAbort !== undefined;
  }

  /** This pane as a hook sees it. */
  get ref(): PaneRef {
    // A part of its own, so `cwd` keeps its place before `turnId`.
    const cwd: Pick<PaneRef, "cwd"> = {};
    if (this.cwd) cwd.cwd = this.cwd;
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      tabId: this.tabId,
      title: this.title,
      harness: this.harness,
      ...cwd,
      turnId: this.turnId,
    };
  }

  /** The pane's own handler wins; the program's `onSend` hook runs for a pane that has none. */
  async send(text: string, o: SendContext) {
    if (this.sendFn) await this.sendFn(text, o);
    else await this.store.hooks.onSend?.(this.ref, { text, steer: o.steer, turnId: this.turnId, requestId: o.requestId });
    this.touch();
  }
  async abort(o: { requestId: string }) {
    if (this.abortFn) await this.abortFn(o);
    else await this.store.hooks.onAbort?.(this.ref, { turnId: this.turnId, requestId: o.requestId });
    this.touch();
  }

  close() {
    this.closed = true;
    // A Map walk survives `closeAsk` deleting the entry it stands on.
    for (const id of this.asks.keys()) this.closeAsk(id, "stopped", "program", new AskClosed("stopped", "program"));
    this.store.panes.delete(this.id);
    this.store.rememberClosed(this);
    this.store.rev++;
  }
}

interface TabRec {
  id: string;
  workspaceId: string;
  title: string;
}
interface WsRec {
  id: string;
  title: string;
  cwd?: string;
}

/** What a host with no process of its own may fix in a store. Left out, the store is the memory store: a random epoch and its own counter. */
export interface StoreSeams {
  /** Used as is, and checked against the id rule. */
  epoch?: string;
  /** The snapshot's `rev`, read at every snapshot, instead of the store's counter. The counter still runs. A whole number from 1. */
  rev?: () => number;
}

export class Store {
  /** New and random on every start, 128 bits, unless the host names one ({@link StoreSeams.epoch}). */
  readonly epoch: string;
  private readonly revOf: (() => number) | undefined;
  readonly receipts: Receipts;
  /** `receipts`: where finished request ids are kept. Default: in memory, gone with the process. */
  readonly tailLimit: number;
  /** False: an ask option with effect `allow-always` is a TypeError (a program behind TLS, WIRE.md 1B). */
  readonly allowAlways: boolean;
  constructor(tailLimit = DEFAULT_TAIL, receipts?: ReceiptStore, allowAlways = true, seams: StoreSeams = {}) {
    this.epoch = seams.epoch === undefined ? mintId() : assertId(seams.epoch, "epoch");
    this.revOf = seams.rev;
    this.tailLimit = tailLimit;
    this.allowAlways = allowAlways;
    this.receipts = new Receipts(receipts);
  }
  /** The program's hooks (`createCore` sets them once). */
  hooks: ProgramHooks = {};
  /** Where the program's history comes from (WIRE.md 7.16). Unset: `caps.history` is false. */
  history: HistoryProvider | undefined;
  /**
   * The panes closed in this process, by conversation id, newest last, so a reopen without a hook can put the same
   * pane back. At most {@link LIMITS.panes}. A restart forgets them: the program's own hook reopens those.
   */
  readonly closedPanes = new Map<string, Pane>();
  rev = 1;
  /** False until the program says its layout is complete. A restarting program must not show a half-empty one. */
  ready = false;
  readonly workspaces = new Map<string, WsRec>();
  readonly tabs = new Map<string, TabRec>();
  readonly panes = new Map<string, Pane>();
  starters = new Map<string, Starter>();

  workspace(id: string, o: { title: string; cwd?: string }): WorkspaceHandle {
    assertId(id, "workspace id");
    if (id.includes(":")) throw new TypeError(`a workspace id may not hold ":" (it joins tab ids): ${id}`);
    if (!this.workspaces.has(id)) {
      const cwd = cwdOf(o.cwd);
      const workspace: Workspace = { id, title: cut(o.title, CAPS.title) };
      if (cwd) workspace.cwd = cwd;
      this.workspaces.set(id, workspace);
      this.rev++;
    }
    return {
      id,
      tab: (tabId, t) => this.tab(id, tabId, t),
    };
  }

  private tab(workspaceId: string, id: string, o: { title: string }): TabHandle {
    assertId(id, "tab id");
    if (id.includes(":")) throw new TypeError(`a tab id may not hold ":" (it joins the workspace id): ${id}`);
    // Tab ids are scoped to their workspace on the program's side, global on the wire: `<workspace>:<tab>`.
    const key = assertId(`${workspaceId}:${id}`, "tab id on the wire");
    if (!this.tabs.has(key)) {
      this.tabs.set(key, { id: key, workspaceId, title: cut(o.title, CAPS.title) });
      this.rev++;
    }
    return {
      id: key,
      pane: (paneId, p) => this.pane(workspaceId, key, paneId, p),
    };
  }

  /** Idempotent: the same id returns the live pane, so a restarted program can re-attach. */
  private pane(workspaceId: string, tabId: string, id: string, o: PaneOptions & { title: string; harness: string }): Pane {
    assertId(id, "pane id");
    if (o.sessionId !== undefined && o.sessionId !== null) assertId(o.sessionId, "pane sessionId");
    const have = this.panes.get(id);
    if (have) return have;
    const host: Pick<PaneOptions, "turnId" | "sendWhenIdleOnly" | "cursor"> = {};
    if (o.turnId !== undefined) host.turnId = o.turnId;
    if (o.sendWhenIdleOnly !== undefined) host.sendWhenIdleOnly = o.sendWhenIdleOnly;
    if (o.cursor !== undefined) host.cursor = o.cursor;
    const pane = new Pane(this, id, tabId, workspaceId, cut(o.title, CAPS.title), cut(o.harness, CAPS.harness), cwdOf(o.cwd), this.tailLimit, o.sessionId, host);
    // A pane shown again is open: it is no longer one a reopen could put back.
    for (const [key, closed] of this.closedPanes) if (closed.id === id) this.closedPanes.delete(key);
    this.panes.set(id, pane);
    this.rev++;
    return pane;
  }

  /**
   * What a close of this workspace, tab or pane takes with it (WIRE.md 7.9), or undefined when there is no such
   * target. The panes are listed in layout order.
   */
  closeTarget(kind: "pane" | "tab" | "workspace", id: string): CloseTarget | undefined {
    if (kind === "pane") return this.panes.has(id) ? { kind, id, paneIds: [id] } : undefined;
    if (kind === "tab") return this.tabs.has(id) ? { kind, id, paneIds: this.paneIdsIn((p) => p.tabId === id) } : undefined;
    return this.workspaces.has(id) ? { kind, id, paneIds: this.paneIdsIn((p) => p.workspaceId === id) } : undefined;
  }

  private paneIdsIn(inside: (pane: Pane) => boolean): string[] {
    return [...this.panes.values()].filter(inside).map((p) => p.id);
  }

  /**
   * Take a workspace, a tab or a pane out of the layout, with everything inside it (WIRE.md 7.9). Every open ask
   * on those panes closes as `stopped`, so nothing is left waiting for an answer that cannot come, and `rev`
   * rises once the target is gone. False when there is no such target.
   */
  close(kind: "pane" | "tab" | "workspace", id: string): boolean {
    const target = this.closeTarget(kind, id);
    if (target === undefined) return false;
    for (const paneId of target.paneIds) this.panes.get(paneId)?.close();
    if (kind === "tab") this.tabs.delete(id);
    if (kind === "workspace") {
      for (const [tabId, tab] of this.tabs) if (tab.workspaceId === id) this.tabs.delete(tabId);
      this.workspaces.delete(id);
    }
    this.rev++;
    return true;
  }

  /**
   * Give a workspace or a tab a new title (WIRE.md 7.8). False when there is no such target. The id of a tab is
   * the wire's `<workspace>:<tab>`. The title is cleaned and cut like every other, and `rev` rises only when
   * what a reader sees changes.
   */
  rename(kind: "workspace" | "tab", id: string, title: string): boolean {
    const rec = kind === "workspace" ? this.workspaces.get(id) : this.tabs.get(id);
    if (rec === undefined) return false;
    const next = cut(title, CAPS.title);
    if (rec.title !== next) {
      rec.title = next;
      this.rev++;
    }
    return true;
  }

  /** Keep a closed pane, so a reopen in this process can put it back (WIRE.md 7.16). */
  rememberClosed(pane: Pane) {
    const key = pane.sessionId ?? pane.id;
    this.closedPanes.delete(key);
    this.closedPanes.set(key, pane);
    while (this.closedPanes.size > LIMITS.panes) this.closedPanes.delete(this.closedPanes.keys().next().value!);
  }

  /** The pane id of a conversation: the open pane that shows it, or the one this process closed for it. */
  paneOfConversation(id: string): { paneId: string; open: boolean } | undefined {
    for (const pane of this.panes.values()) if ((pane.sessionId ?? pane.id) === id) return { paneId: pane.id, open: true };
    const closed = this.closedPanes.get(id);
    return closed === undefined ? undefined : { paneId: closed.id, open: false };
  }

  /**
   * Put back the pane this process closed for a conversation (WIRE.md 7.16): the same pane id, its tail and its
   * items, in its tab, and `rev` rises. False when there is no such pane, or its tab is gone.
   */
  reopen(id: string): boolean {
    const pane = this.closedPanes.get(id);
    if (pane === undefined || !this.tabs.has(pane.tabId) || this.panes.has(pane.id)) return false;
    this.closedPanes.delete(id);
    pane.closed = false;
    this.panes.set(pane.id, pane);
    this.rev++;
    return true;
  }

  setStarters(list: Starter[]) {
    const rows = list.map((s) => ({ ...s, id: assertId(s.id, "starter id"), label: cut(s.label, CAPS.starterLabel) }));
    this.starters = new Map(rows.slice(0, LIMITS.starters).map((s) => [s.id, s]));
    this.rev++;
  }

  private currentRev(): number {
    if (this.revOf === undefined) return this.rev;
    const rev = this.revOf();
    if (!Number.isSafeInteger(rev) || rev < 1) throw new RangeError(`the host's rev is a whole number from 1: ${rev}`);
    return rev;
  }

  snapshot(): Snapshot {
    // An ask past its `expiresAt` reads as decided by `timeout` from this read on (WIRE.md 7.3).
    for (const pane of this.panes.values()) pane.sweep();
    return {
      rev: this.currentRev(),
      epoch: this.epoch,
      workspaces: [...this.workspaces.values()].slice(0, LIMITS.workspaces),
      tabs: [...this.tabs.values()].slice(0, LIMITS.tabs),
      panes: [...this.panes.values()].slice(0, LIMITS.panes).map((p) => p.info()),
      starters: [...this.starters.values()].map(({ id, label }) => ({ id, label })),
    };
  }
}
