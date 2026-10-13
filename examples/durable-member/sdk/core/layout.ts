// The layout store and the handles a program holds: workspace, tab, pane.
// No Pi Durable import here, and no runtime import: it runs in Bun and in a Cloudflare Worker. A program (or an adapter) calls these methods; the server reads the store.
// Every id a program passes in is checked against the id rule, and every string is cleaned and cut to
// its byte cap (WIRE.md section 6) before it is stored, so the wire never carries a string over a cap.

import { randomHex, sha256Hex } from "./hash.ts";
import { type ReceiptStore, Receipts } from "./receipts.ts";
import {
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
  shortLine,
  subtitleOf,
  tsOf,
} from "./rules.ts";
import type {
  Answer,
  AnswerResult,
  Ask,
  AskInput,
  Badge,
  ChoiceAnswer,
  ChoiceAskInput,
  ClosedBy,
  Field,
  FormAnswer,
  FormAskInput,
  Item,
  Option,
  PermissionAnswer,
  PermissionAskInput,
  TextAnswer,
  TextAskInput,
  PaneInfo,
  Progress,
  PaneState,
  ProgramEvent,
  SessionEvent,
  Snapshot,
  Starter,
  ToolCall,
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

export class AskClosed extends Error {
  constructor(readonly by: ClosedBy) {
    super(`ask closed: ${by}`);
  }
}
/** The phone sent an answer that picks an id the ask does not offer. The server maps it to 400 `bad-option`. */
export class BadAnswer extends Error {
  readonly code: "bad-option" | "bad-body" = "bad-option";
}
/** The phone sent an answer of the wrong shape for the ask: a text over its `maxLength`, a missing required field. 400 `bad-body`. */
export class BadAnswerBody extends BadAnswer {
  override readonly code = "bad-body";
}

// ── cleaning ──────────────────────────────────────────────────────────────────

function cleanTool(t: ToolCall): ToolCall {
  const out: ToolCall = { kind: "other", name: cut(t.name, CAPS.toolName), summary: cut(t.summary, CAPS.summary, true) };
  if (t.output !== undefined && t.output !== null) out.output = cut(t.output, CAPS.output, true);
  return out;
}

export function cleanItem(item: Item): Item {
  assertId(item.id, "item id");
  const ts = tsOf(item.ts);
  const head = { id: item.id, ...(ts ? { ts } : {}) };
  if (item.kind === "tool") return { ...head, kind: "tool", tool: cleanTool(item.tool), status: item.status };
  if (item.kind === "markdown") return { ...head, kind: "markdown", text: cut(item.text, CAPS.richText, true), ...partialOf(item) };
  if (item.kind === "code") {
    const lang = item.lang === undefined ? undefined : langOf(item.lang);
    return { ...head, kind: "code", ...(lang === undefined ? {} : { lang }), text: cut(item.text, CAPS.richText, true) };
  }
  if (item.kind === "link") {
    const label = item.label === undefined ? undefined : shortLine(item.label, LINK_LABEL_MAX);
    return { ...head, kind: "link", href: hrefOf(item.href), ...(label === undefined ? {} : { label }) };
  }
  if (item.kind === "user") {
    if (item.requestId !== undefined) assertId(item.requestId, "item requestId");
    return { ...head, kind: "user", text: cut(item.text, CAPS.text, true), ...(item.requestId === undefined ? {} : { requestId: item.requestId }) };
  }
  return { ...head, kind: item.kind, text: cut(item.text, CAPS.text, true), ...partialOf(item) };
}

/** `partial: true` only when the program set exactly that. Anything else reads as a finished text (WIRE.md 7.13). */
const partialOf = (item: { partial?: true }): { partial?: true } => (item.partial === true ? { partial: true } : {});

/** An ask as `cleanAsk` takes it: an input with its id and revision set, or an open ask patched. */
type AskDraft = Pick<Ask, "id" | "revision" | "toolCallId" | "title" | "itemId" | "reason" | "tool" | "cleaned" | "multiple" | "placeholder" | "maxLength" | "fields"> & {
  kind: string;
  options?: Option[];
};

/** Ids of a list are unique and pass the id rule. `what` names them in the error. */
function checkIds(list: readonly { id: string }[], what: string): void {
  const seen = new Set<string>();
  for (const entry of list) {
    assertId(entry.id, `${what} id`);
    if (seen.has(entry.id)) throw new TypeError(`${what} id used twice: ${entry.id}`);
    seen.add(entry.id);
  }
}

/** The options of a `choice` ask or of a choice field: 1 to 8, no effect (WIRE.md 7.12). */
function cleanPlainOptions(raw: readonly Option[] | undefined, what: string): Option[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new TypeError(`${what} needs at least one option (WIRE.md 7.12)`);
  if (raw.length > LIMITS.choiceOptions) throw new RangeError(`${what} has at most ${LIMITS.choiceOptions} options (WIRE.md 7.12)`);
  checkIds(raw, "option");
  return raw.map((o) => {
    if (o.effect !== undefined) throw new TypeError(`${what} option has no effect: only a permission option does (WIRE.md 7.12)`);
    return { id: o.id, label: cut(o.label, CAPS.optionLabel) };
  });
}

function cleanField(raw: Field): Field {
  assertId(raw.id, "field id");
  if (raw.kind !== "text" && raw.kind !== "choice" && raw.kind !== "toggle") throw new TypeError(`a field has kind text, choice or toggle (WIRE.md 7.12): ${String(raw.kind)}`);
  const field: Field = { id: raw.id, label: cut(raw.label, CAPS.optionLabel), kind: raw.kind };
  if (raw.required === true) field.required = true;
  if (raw.kind === "text") {
    if (raw.options !== undefined) throw new TypeError("a text field has no options (WIRE.md 7.12)");
    if (raw.maxLength !== undefined) field.maxLength = maxLengthOf(raw.maxLength);
  } else if (raw.kind === "toggle") {
    if (raw.options !== undefined || raw.maxLength !== undefined) throw new TypeError("a toggle field has no options and no maxLength (WIRE.md 7.12)");
  } else {
    if (raw.maxLength !== undefined) throw new TypeError("a choice field has no maxLength (WIRE.md 7.12)");
    field.options = cleanPlainOptions(raw.options, "a choice field");
  }
  return field;
}

function cleanAsk(input: AskDraft): Ask {
  const kind = input.kind;
  if (kind !== "permission" && kind !== "choice" && kind !== "text" && kind !== "form") {
    throw new TypeError(`an ask has kind permission, choice, text or form (WIRE.md 7.12): ${String(kind)}`);
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
    if (input.options !== undefined && input.options.length > 0) throw new TypeError("a text ask has no options (WIRE.md 7.12)");
    if (input.placeholder !== undefined) {
      const hint = shortLine(input.placeholder, PLACEHOLDER_MAX);
      if (hint !== undefined) extra.placeholder = hint;
    }
    if (input.maxLength !== undefined) extra.maxLength = maxLengthOf(input.maxLength);
  } else {
    if (input.options !== undefined && input.options.length > 0) throw new TypeError("a form ask has fields, not options (WIRE.md 7.12)");
    if (!Array.isArray(input.fields) || input.fields.length === 0) throw new TypeError("a form ask needs at least one field (WIRE.md 7.12)");
    if (input.fields.length > LIMITS.formFields) throw new RangeError(`a form ask has at most ${LIMITS.formFields} fields (WIRE.md 7.12)`);
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
  return ask;
}

/** What a program may change in an open ask (WIRE.md 7.12). Its kind and its ids stay. */
export interface AskPatch {
  title?: string;
  reason?: string;
  tool?: ToolCall;
  options?: Option[];
  placeholder?: string;
  maxLength?: number;
  fields?: Field[];
}

const has = <K extends string>(answer: Answer, key: K): answer is Extract<Answer, Record<K, unknown>> => key in answer;

/** The characters of a string, counted as the wire counts them (code points). */
const lengthOf = (text: string): number => [...text].length;

/**
 * Whether the phone's answer fits the ask (WIRE.md 7.3 and 7.12): an id the ask does not offer is `BadAnswer`; the wrong
 * shape for the kind, a text over its `maxLength`, a missing required field, or a pick count the ask does not take
 * is `BadAnswerBody`.
 */
function checkAnswer(ask: Ask, answer: Answer): void {
  if (ask.kind === "choice") {
    if (!has(answer, "optionIds")) throw new BadAnswerBody("a choice ask takes optionIds");
    const ids = answer.optionIds;
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw new BadAnswerBody("optionIds are one or more distinct ids");
    if (ids.some((id) => !ask.options.some((o) => o.id === id))) throw new BadAnswer("unknown option");
    if (ids.length > 1 && ask.multiple !== true) throw new BadAnswerBody("this choice takes one option");
    return;
  }
  if (ask.kind === "text") {
    if (!has(answer, "text")) throw new BadAnswerBody("a text ask takes text");
    const size = lengthOf(answer.text);
    if (size < 1 || size > (ask.maxLength ?? ANSWER_TEXT_DEFAULT)) throw new BadAnswerBody("the text is empty or over the ask's maxLength");
    return;
  }
  if (ask.kind === "form") {
    if (!has(answer, "values")) throw new BadAnswerBody("a form ask takes values");
    checkForm(ask.fields ?? [], answer.values);
    return;
  }
  if (!has(answer, "optionId")) throw new BadAnswerBody("a permission takes an optionId");
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
      throw new TypeError(`a program may not append a ${(e as { type: string }).type} event`);
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
  /** The newest turn: the running one, or the last one that ran. */
  readonly turnId: string;
  /** Every open ask, oldest first, at most 50. */
  readonly openAsks: Ask[];
  state(s: PaneState): void;
  /**
   * One line under the conversation's title (WIRE.md 7.9), cut to 120 characters. `null` clears it. The revision
   * rises only when what the phone reads changes.
   */
  subtitle(text: string | null): void;
  /**
   * A small mark next to the title (WIRE.md 7.9): `{ count }` with an integer from 0 to 9999, or `{ text }` of at
   * most 12 characters. `null` clears it. A bad count is a RangeError. The revision rises only on a change.
   */
  badge(value: Badge | null): void;
  /**
   * How far a working conversation is (WIRE.md 7.10): `{ kind: "steps", steps }` with 1 to 12 steps (more are left
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
  /** A `choice` ask (WIRE.md 7.12): resolves with `{ optionIds }`, one id unless the ask is `multiple`. */
  ask(ask: ChoiceAskInput, opts?: { signal?: AbortSignal }): Promise<ChoiceAnswer>;
  /** A `text` ask: resolves with `{ text }`. */
  ask(ask: TextAskInput, opts?: { signal?: AbortSignal }): Promise<TextAnswer>;
  /** A `form` ask: resolves with `{ values }`, keyed by field id. */
  ask(ask: FormAskInput, opts?: { signal?: AbortSignal }): Promise<FormAnswer>;
  ask(ask: AskInput, opts?: { signal?: AbortSignal }): Promise<Answer>;
  /** Change an open ask in place. Its revision rises by one. False when the ask is not open. */
  updateAsk(askId: string, patch: AskPatch): boolean;
  onSend(fn: (text: string, o: SendContext) => void | Promise<void>): void;
  onAbort(fn: (o: { requestId: string }) => void | Promise<void>): void;
  close(): void;
}
export interface TabHandle {
  readonly id: string;
  pane(id: string, o: { title: string; harness: string; cwd?: string }): PaneHandle;
}
export interface WorkspaceHandle {
  readonly id: string;
  tab(id: string, o: { title: string }): TabHandle;
}

interface OpenAsk {
  ask: Ask;
  openedAt: number;
  resolve: (a: Answer) => void;
  reject: (e: Error) => void;
}

export class Pane implements PaneHandle {
  base: PaneState = "idle";
  lastActiveAt = Date.now();
  turnId = mintId();
  /** The raw tail: the newest `limit` events. `total` counts every event ever, so a cursor is `total` at read time. */
  readonly tail: SessionEvent[] = [];
  private total = 0;
  /** The compacted history: the latest version of each item, in order of first appearance. */
  private readonly items = new Map<string, Item>();
  readonly asks = new Map<string, OpenAsk>();
  closed = false;
  private subtitleText: string | undefined;
  private badgeValue: Badge | undefined;
  private progressValue: Progress | undefined;
  sendFn?: (text: string, o: SendContext) => void | Promise<void>;
  abortFn?: (o: { requestId: string }) => void | Promise<void>;
  /** The state last put in the log. Unset until the first sync, so the log always starts with one. */
  private shown?: PaneState;
  private readonly limit: number;

  constructor(
    private store: Store,
    readonly id: string,
    readonly tabId: string,
    readonly workspaceId: string,
    public title: string,
    readonly harness: string,
    readonly cwd: string | undefined,
    limit = DEFAULT_TAIL,
  ) {
    this.limit = Math.min(limit, MAX_TAIL);
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
   * cursor past the count gets `reset: true` and the whole current view of the pane.
   */
  eventsAfter(after: number, staleEpoch: boolean): { events: SessionEvent[]; next: number; reset?: true; more?: true; trimmed?: number } {
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
      return { events, next, ...(next < this.total ? { more: true as const } : {}) };
    }
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
    return { events, next: this.total, reset: true, ...(trimmed > 0 ? { trimmed } : {}) };
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
      // Reserved for the machine-scoped session id (WIRE.md section 3). Null until a later version defines it.
      sessionId: null,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(this.subtitleText === undefined ? {} : { subtitle: this.subtitleText }),
      ...(this.badgeValue === undefined ? {} : { badge: this.badgeValue }),
      ...(this.progressValue === undefined ? {} : { progress: this.progressValue }),
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
    if (s === "working" && this.base !== "working") this.turnId = mintId();
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
      const stop = () => this.closeAsk(ask.id, "stopped", new AskClosed("stopped"));
      if (opts.signal?.aborted) stop();
      else opts.signal?.addEventListener("abort", stop, { once: true });
    });
  }

  /** A core made with `allowAlways: false` takes no `allow-always` option: over TLS the token is the only gate. */
  private refuseAllowAlways(options: readonly { effect?: string }[]): void {
    if (this.store.allowAlways || !options.some((o) => o.effect === "allow-always")) return;
    throw new TypeError(
      "an ask option with effect allow-always is refused: this program is reached over TLS with a token (WIRE.md 1B), so it offers Allow and Deny only",
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

  private closeAsk(askId: string, by: ClosedBy, err?: Error) {
    const open = this.asks.get(askId);
    if (!open) return;
    this.asks.delete(askId);
    this.append({ type: "ask-closed", askId, by, waitedMs: Date.now() - open.openedAt });
    this.sync();
    this.touch();
    if (err) open.reject(err);
  }

  /**
   * The phone answers (WIRE.md 7.3). The caller has checked the revision. A closed or unknown ask is
   * `too-late`; an option that is not offered throws `BadAnswer` (400 `bad-option`), and an answer of the wrong
   * shape for the ask's kind throws `BadAnswerBody` (400 `bad-body`, WIRE.md 7.12). An ask raised again after a restart has its
   * old id, so an answer to the id the phone saw before the wake lands here.
   */
  answer(askId: string, answer: Answer): AnswerResult {
    const open = this.asks.get(askId);
    if (!open) return "too-late";
    checkAnswer(open.ask, answer);
    open.resolve(answer);
    this.closeAsk(askId, "phone");
    return "taken";
  }

  onSend(fn: (text: string, o: SendContext) => void | Promise<void>) {
    this.sendFn = fn;
  }
  onAbort(fn: (o: { requestId: string }) => void | Promise<void>) {
    this.abortFn = fn;
  }
  get canSend() {
    return this.sendFn !== undefined;
  }
  get canAbort() {
    return this.abortFn !== undefined;
  }
  async send(text: string, o: SendContext) {
    await this.sendFn?.(text, o);
    this.touch();
  }
  async abort(o: { requestId: string }) {
    await this.abortFn?.(o);
    this.touch();
  }

  close() {
    this.closed = true;
    for (const id of [...this.asks.keys()]) this.closeAsk(id, "stopped", new AskClosed("stopped"));
    this.store.panes.delete(this.id);
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

export class Store {
  /** New and random on every start. 128 bits. */
  readonly epoch = mintId();
  readonly receipts: Receipts;
  /** `receipts`: where finished request ids are kept. Default: in memory, gone with the process. */
  constructor(
    readonly tailLimit = DEFAULT_TAIL,
    receipts?: ReceiptStore,
    /** False: an ask option with effect `allow-always` is a TypeError (a program behind TLS, WIRE.md 1B). */
    readonly allowAlways = true,
  ) {
    this.receipts = new Receipts(receipts);
  }
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
      this.workspaces.set(id, { id, title: cut(o.title, CAPS.title), ...(cwd ? { cwd } : {}) });
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
  private pane(workspaceId: string, tabId: string, id: string, o: { title: string; harness: string; cwd?: string }): Pane {
    assertId(id, "pane id");
    const have = this.panes.get(id);
    if (have) return have;
    const pane = new Pane(this, id, tabId, workspaceId, cut(o.title, CAPS.title), cut(o.harness, CAPS.harness), cwdOf(o.cwd), this.tailLimit);
    this.panes.set(id, pane);
    this.rev++;
    return pane;
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

  setStarters(list: Starter[]) {
    const rows = list.map((s) => ({ ...s, id: assertId(s.id, "starter id"), label: cut(s.label, CAPS.starterLabel) }));
    this.starters = new Map(rows.slice(0, LIMITS.starters).map((s) => [s.id, s]));
    this.rev++;
  }

  snapshot(): Snapshot {
    return {
      rev: this.rev,
      epoch: this.epoch,
      workspaces: [...this.workspaces.values()].slice(0, LIMITS.workspaces),
      tabs: [...this.tabs.values()].slice(0, LIMITS.tabs),
      panes: [...this.panes.values()].slice(0, LIMITS.panes).map((p) => p.info()),
      starters: [...this.starters.values()].map(({ id, label }) => ({ id, label })),
    };
  }
}
