// The layout store and the handles a program holds: workspace, tab, pane.
// No Pi Durable import here, and no runtime import: it runs in Bun and in a Cloudflare Worker. A program (or an adapter) calls these methods; the server reads the store.
// Every id a program passes in is checked against the id rule, and every string is cleaned and cut to
// its byte cap (WIRE.md section 6) before it is stored, so the wire never carries a string over a cap.

import { randomHex, sha256Hex } from "./hash.ts";
import { type ReceiptStore, Receipts } from "./receipts.ts";
import { assertId, bytes, CAPS, cut, cwdOf, LIMITS, tsOf } from "./rules.ts";
import type {
  Answer,
  AnswerResult,
  Ask,
  AskInput,
  ClosedBy,
  Item,
  PaneInfo,
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
/** The phone sent an answer that is not one of the options. The server maps it to 400. */
export class BadAnswer extends Error {}

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
  return { ...head, kind: item.kind, text: cut(item.text, CAPS.text, true) };
}

function cleanAsk(input: AskInput & { id: string; revision: number }): Ask {
  if (input.kind !== "permission") throw new TypeError("an ask has kind permission in version 1");
  assertId(input.id, "ask id");
  assertId(input.toolCallId, "ask toolCallId");
  assertId(input.itemId, "ask itemId");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new RangeError("an ask revision starts at 1");
  if (!Array.isArray(input.options) || input.options.length === 0) throw new TypeError("an ask needs at least one option");
  const seen = new Set<string>();
  const options = input.options.slice(0, LIMITS.options).map((o) => {
    assertId(o.id, "option id");
    if (seen.has(o.id)) throw new TypeError(`option id used twice: ${o.id}`);
    seen.add(o.id);
    if (!["allow", "allow-always", "deny", "cancel"].includes(o.effect)) throw new TypeError(`bad option effect: ${o.effect}`);
    return { id: o.id, label: cut(o.label, CAPS.optionLabel), effect: o.effect };
  });
  const title = cut(input.title, CAPS.askTitle);
  const ask: Ask = {
    id: input.id,
    kind: "permission",
    toolCallId: input.toolCallId,
    revision: input.revision,
    title,
    itemId: input.itemId,
    options,
  };
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
  state(s: PaneState): void;
  event(e: ProgramEvent): void;
  /**
   * Sets the pane to `waiting`, emits `ask`, resolves with the phone's answer. Without an `id`, the ask id comes
   * from the pane and the tool call ({@link askIdFor}), so it is the same after a restart.
   */
  ask(ask: AskInput, opts?: { signal?: AbortSignal }): Promise<Answer>;
  /** Change an open ask in place. Its revision rises by one. False when the ask is not open. */
  updateAsk(askId: string, patch: Partial<Pick<AskInput, "title" | "reason" | "tool" | "options">>): boolean;
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

  event(e: ProgramEvent) {
    this.append(cleanEvent(e));
    this.touch();
  }

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
  private refuseAllowAlways(options: readonly { effect: string }[]): void {
    if (this.store.allowAlways || !options.some((o) => o.effect === "allow-always")) return;
    throw new TypeError(
      "an ask option with effect allow-always is refused: this program is reached over TLS with a token (WIRE.md 1B), so it offers Allow and Deny only",
    );
  }

  updateAsk(askId: string, patch: Partial<Pick<AskInput, "title" | "reason" | "tool" | "options">>): boolean {
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
   * `too-late`; an option that is not offered throws `BadAnswer`. An ask raised again after a restart has its
   * old id, so an answer to the id the phone saw before the wake lands here.
   */
  answer(askId: string, answer: Answer): AnswerResult {
    const open = this.asks.get(askId);
    if (!open) return "too-late";
    if (!open.ask.options.some((o) => o.id === answer.optionId)) throw new BadAnswer("unknown option");
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
