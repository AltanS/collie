// The inside hub (M99 spec 01): the registry and the queue behind one face, with no socket in it.
//
// The server (`server.ts`) turns HTTP into calls on this class; everything the bridge does with a part
// goes through it. It is the SEAM for the later specs of M99:
//
//  - spec 03 (send by data) and spec 05 (WalkyTalky by data) read `partOf`, `enqueue` a `prompt` or a
//    `mail` with the phone's request id, `withdraw` it while no part took it, and wait on `waitFor`.
//  - spec 04 (asks and wake) sets the `ask` listener, which decides whether a part's permission hook
//    waits for the phone, and enqueues the `answer`; it reads the `event` listener for turns and rows.
//
// Until those land, no listener is set: a part can bind and report, an ask is answered "do not wait",
// and nothing is queued. The screen path runs exactly as before for every session.
//
// Capabilities fail closed here, at the door: a command a part did not declare is not queued, a wake
// event of a part that did not declare `wake` reaches no listener, an answer to an ask kind the part
// did not declare is not queued.

import type { CommandQueue, CommandState, PaneAddress, QueuedCommand } from "./queue.ts";
import type { PartRegistry, PartView } from "./registry.ts";
import type { JsonValue } from "../../web/src/lib/json.ts";
import { checkCommand, commandBody, needOf, type AskKind, type Hello, type NextQuery, type WireCommand, type WireEvent } from "./wire.ts";

/** The longest an ask may wait for the phone, whatever a listener says. */
export const ASK_WAIT_MAX_MS = 15 * 60_000;
/** The most asks one part may hold open. */
export const ASKS_PER_PART_MAX = 16;

/** Where a hello lands: a pane of this bridge, or not one of ours (and why). */
export type PlaceResult =
  | { readonly kind: "placed"; readonly address: PaneAddress; readonly pidStartTime: number | null }
  | { readonly kind: "not-mine"; readonly reason: string };

/** Places a hello on a pane. In the bridge: the edge placement over the live sessions' targets. */
export type Placer = (hello: Hello) => Promise<PlaceResult>;

/** Whether a part's permission hook should wait for the phone, and how long. */
export type AskVerdict = {
  readonly wait: boolean;
  readonly waitMs?: number;
};

/** What the rest of the bridge hears from the hub. Every method is optional and must not throw. */
export interface InsideListener {
  bound?(part: PartView, replaced: PartView | null): void;
  gone?(part: PartView, reason: string): void;
  /** An accepted event of a bound part. Wake events (turns, rows) only from a part that declared `wake`. */
  event?(part: PartView, event: WireEvent): void;
  /** A command changed state (queued, taken, sent, failed, withdrawn). */
  command?(entry: Readonly<QueuedCommand>): void;
  /** An ask opened by a part that declared its kind. The first listener with an answer decides. */
  ask?(part: PartView, ask: { readonly id: string; readonly kind: AskKind; readonly tool: string | null; readonly input: JsonValue | null }): AskVerdict | undefined;
}

/** A hub answer, as the server writes it. */
export interface HubAnswer {
  readonly status: number;
  readonly body: string | null;
  /** The command a `next` handed over, so the server can log its kind and id. */
  readonly command?: WireCommand;
}

export type EnqueueOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "no-part" | "not-declared" | "no-ask" | "bad" | "duplicate" | "full" };

const json = (status: number, value: JsonValue): HubAnswer => ({ status, body: JSON.stringify(value) });
const empty = (status: number): HubAnswer => ({ status, body: null });
const GONE = json(410, { error: "unknown part: say hello again" });

/** The event kinds that only wake: they carry no command id and change no command. */
const WAKE_KINDS = new Set<WireEvent["kind"]>(["turn.start", "turn.end", "row"]);

export interface InsideHubOptions {
  readonly registry: PartRegistry;
  readonly queue: CommandQueue;
  readonly place: Placer;
  readonly log?: (line: string) => void;
}

export class InsideHub {
  private readonly listeners: InsideListener[] = [];
  /** The asks each part holds open, by part id: ask id → kind. */
  private readonly asks = new Map<string, Map<string, AskKind>>();
  private readonly registry: PartRegistry;
  private readonly queue: CommandQueue;
  private readonly place: Placer;

  constructor(options: InsideHubOptions) {
    this.registry = options.registry;
    this.queue = options.queue;
    this.place = options.place;
    this.registry.onChange((change) => {
      if (change.kind === "bound") this.each((listener) => listener.bound?.(change.part, change.replaced));
      if (change.kind !== "gone") return;
      this.asks.delete(change.part.partId);
      // The gone part's waits end at once, a replaced part's too: a command must never go to a dead part
      // id's open poll (a reloaded module's old fetch has nobody left to read it). Queued commands stay
      // for the pane's next part.
      this.queue.release(change.part.address);
      this.each((listener) => listener.gone?.(change.part, change.reason));
    });
    this.queue.onChange((entry) => this.each((listener) => listener.command?.(entry)));
  }

  /** Add a listener. */
  listen(listener: InsideListener): void {
    this.listeners.push(listener);
  }

  // ── What the server calls ─────────────────────────────────────────────────────────────────────

  /** A parsed hello: bind it, or say it is not ours. */
  async hello(hello: Hello): Promise<HubAnswer> {
    const placed = await this.place(hello).catch((): PlaceResult => ({ kind: "not-mine", reason: "error" }));
    if (placed.kind === "not-mine") return json(200, { wire: hello.wire, mine: false, reason: placed.reason });
    const part = this.registry.bind(hello, placed.address, placed.pidStartTime);
    return json(200, {
      wire: hello.wire,
      mine: true,
      part: part.partId,
      capabilities: [...part.capabilities],
      asks: [...part.asks],
    });
  }

  /** A parsed event of a part. */
  event(event: WireEvent): HubAnswer {
    const part = this.registry.touch(event.part);
    if (part === null) return GONE;
    switch (event.kind) {
      case "bye":
        this.registry.drop(part.partId);
        return empty(204);
      case "taken":
        // The handoff already marked it taken; the part's word only confirms. Another pane's id is ignored.
        if (this.queue.isFor(event.cmd, part.address)) this.tell(part, event);
        return empty(204);
      case "sent":
      case "failed":
        if (this.queue.settle(event.cmd, part.address, event.kind, event.kind === "failed" ? event.reason : null)) this.tell(part, event);
        return empty(204);
      case "draft":
        // The draft answers a `draft` question this pane's part took; anything else is dropped unread.
        if (this.queue.get(event.cmd)?.command.kind === "draft" && this.queue.settle(event.cmd, part.address, "sent")) this.tell(part, event);
        return empty(204);
      case "ask.open":
        return json(200, this.openAsk(part, event));
      case "ask.close":
        this.asks.get(part.partId)?.delete(event.ask);
        this.tell(part, event);
        return empty(204);
      case "turn.start":
      case "turn.end":
      case "row":
        if (part.capabilities.has("wake")) this.tell(part, event);
        return empty(204);
    }
  }

  /** A long poll for the part's next command. */
  async next(query: NextQuery, signal?: AbortSignal): Promise<HubAnswer> {
    const part = this.registry.touch(query.part);
    if (part === null) return GONE;
    if (query.ask !== null && !this.asks.get(part.partId)?.has(query.ask)) return json(404, { error: "no such ask open" });
    this.registry.pollStarted(part.partId);
    try {
      const entry = await this.queue.wait(part.address, query.ask, query.waitMs, signal);
      // A part replaced or gone while it waited had its wait released first, so no command reaches it.
      if (entry === null) return this.registry.get(part.partId) === null ? GONE : empty(204);
      return { status: 200, body: commandBody(entry.command), command: entry.command };
    } finally {
      this.registry.pollEnded(part.partId);
    }
  }

  /** Drop parts that stopped polling. The server runs this on a timer. */
  sweep(): void {
    this.registry.sweep();
  }

  // ── What the rest of the bridge calls (specs 03 to 05) ────────────────────────────────────────

  /** The part bound to a pane, or null. */
  partOf(address: PaneAddress): PartView | null {
    return this.registry.partOf(address);
  }

  /** Queue a command for a pane's part. Refused when no part is bound or it did not declare the need. */
  enqueue(address: PaneAddress, command: WireCommand): EnqueueOutcome {
    if (checkCommand(command) !== null) return { ok: false, reason: "bad" };
    const part = this.registry.partOf(address);
    if (part === null) return { ok: false, reason: "no-part" };
    const need = needOf(command);
    if ("capability" in need && !part.capabilities.has(need.capability)) return { ok: false, reason: "not-declared" };
    if ("ask" in need && command.kind === "answer") {
      const kind = this.asks.get(part.partId)?.get(command.ask);
      if (kind === undefined) return { ok: false, reason: "no-ask" };
      if (!part.asks.has(kind)) return { ok: false, reason: "not-declared" };
    }
    const queued = this.queue.enqueue(address, command);
    return queued.ok ? { ok: true } : { ok: false, reason: queued.reason };
  }

  /** Withdraw a command no part took yet. False once taken: then the part's word decides (decision 5). */
  withdraw(id: string): boolean {
    return this.queue.withdraw(id);
  }

  stateOf(id: string): CommandState | null {
    return this.queue.stateOf(id);
  }

  /**
   * Wait until the command reaches one of `states`, up to `ms`. Resolves the state it is in then (which
   * may be none of them, on the time limit), or null for an unknown id.
   */
  waitFor(id: string, states: readonly CommandState[], ms: number): Promise<CommandState | null> {
    const now = this.queue.stateOf(id);
    if (now === null || states.includes(now)) return Promise.resolve(now);
    const { promise, resolve } = Promise.withResolvers<CommandState | null>();
    const listener: InsideListener = {
      command: (entry) => {
        if (entry.command.id === id && states.includes(entry.state)) finish();
      },
    };
    const timer = setTimeout(() => finish(), ms);
    timer.unref?.();
    const finish = (): void => {
      clearTimeout(timer);
      const index = this.listeners.indexOf(listener);
      if (index < 0) return;
      this.listeners.splice(index, 1);
      resolve(this.queue.stateOf(id));
    };
    this.listeners.push(listener);
    return promise;
  }

  // ── Inside ────────────────────────────────────────────────────────────────────────────────────

  private openAsk(part: PartView, event: Extract<WireEvent, { kind: "ask.open" }>): AskVerdict {
    if (!part.asks.has(event.askKind)) return { wait: false };
    const open = this.asks.get(part.partId) ?? new Map<string, AskKind>();
    if (!open.has(event.ask) && open.size >= ASKS_PER_PART_MAX) return { wait: false };
    open.set(event.ask, event.askKind);
    this.asks.set(part.partId, open);
    this.tell(part, event);
    let verdict: AskVerdict | undefined;
    for (const listener of this.listeners) {
      try {
        verdict = listener.ask?.(part, { id: event.ask, kind: event.askKind, tool: event.tool, input: event.input });
      } catch {
        verdict = undefined;
      }
      if (verdict !== undefined) break;
    }
    if (verdict === undefined || !verdict.wait) return { wait: false };
    return { wait: true, waitMs: Math.max(0, Math.min(ASK_WAIT_MAX_MS, verdict.waitMs ?? ASK_WAIT_MAX_MS)) };
  }

  private tell(part: PartView, event: WireEvent): void {
    if (WAKE_KINDS.has(event.kind) && !part.capabilities.has("wake")) return;
    this.each((listener) => listener.event?.(part, event));
  }

  private each(run: (listener: InsideListener) => void): void {
    for (const listener of this.listeners.slice()) {
      try {
        run(listener);
      } catch {
        // A listener's fault is its own.
      }
    }
  }
}
