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

/**
 * How long a part's "running" or "draft present" word is believed (M100 spec 05). Past it the word reads
 * as unknown, and unknown takes the screen road, which reads the turn and the box itself. Every post of a
 * part can fail (a time-out, a 429 past the burst, a bridge that was busy), and a lost `turn.end` or a lost
 * "no draft" would otherwise hold every send and every WalkyTalky message to the pane until its hold
 * expires. "Idle" and "no draft" do not age: they never hold anything, and a send they let through still
 * meets the part's own box check (a mail) or the screen's. The reason for the length is in ADR 0140.
 */
export const WORD_FRESH_MS = 60_000;

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
  /** The bridge's clock, for the age of a part's word. `Date.now` by default. */
  readonly now?: () => number;
}

/** A part's last word on one state: the value, when the bridge took it, and the part's count on it. */
interface Word<T> {
  readonly value: T;
  readonly at: number;
  readonly seq: number | null;
}

/** Whether a word with `seq` is older than the one kept: then it is dropped. A word with no count is never older. */
function older(seq: number | null, kept: Word<unknown> | undefined): boolean {
  return seq !== null && kept !== undefined && kept.seq !== null && seq < kept.seq;
}

export class InsideHub {
  private readonly listeners: InsideListener[] = [];
  /** The asks each part holds open, by part id: ask id → kind. */
  private readonly asks = new Map<string, Map<string, AskKind>>();
  /** The turn each part last reported (`turn.start`, `turn.end`), by part id. Only parts that declared `wake`. */
  private readonly turns = new Map<string, Word<"running" | "idle">>();
  /** Whether the box holds a draft, as each part last said (`draft.state`). Only parts that declared `draft.state`. */
  private readonly drafts = new Map<string, Word<boolean>>();
  /**
   * Parts whose pane carries the hook edges of ANOTHER live agent process, not the pane's foreground
   * ({@link noteForeignEdge}), by part id: that process's pid. Such a part may not be the process that
   * runs the agent, so the data road leaves its pane ({@link shadowed}).
   */
  private readonly shadows = new Map<string, number>();
  private readonly now: () => number;
  private readonly registry: PartRegistry;
  private readonly queue: CommandQueue;
  private readonly place: Placer;
  private readonly log: (line: string) => void;

  constructor(options: InsideHubOptions) {
    this.log = options.log ?? ((line) => console.log(line));
    this.registry = options.registry;
    this.queue = options.queue;
    this.place = options.place;
    this.now = options.now ?? Date.now;
    this.registry.onChange((change) => {
      if (change.kind === "bound") this.each((listener) => listener.bound?.(change.part, change.replaced));
      if (change.kind !== "gone") return;
      this.asks.delete(change.part.partId);
      this.turns.delete(change.part.partId);
      this.drafts.delete(change.part.partId);
      this.shadows.delete(change.part.partId);
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
      case "failed": {
        const reason = event.kind === "failed" ? event.reason : null;
        const detail = event.kind === "failed" ? event.detail : null;
        if (!this.queue.settle(event.cmd, part.address, event.kind, reason, detail)) return empty(204);
        // The part's word, never a body text: the reason is a word, the detail the part's own one line
        // (an error's class and message), quoted so it stays one field of the line.
        const why = event.kind === "failed" ? ` reason=${reason ?? "-"}${detail === null ? "" : ` detail=${JSON.stringify(detail)}`}` : "";
        this.log(`[inside] ${event.kind} part=${part.partId.slice(0, 6)} cmd=${event.cmd}${why}`);
        this.tell(part, event);
        return empty(204);
      }
      case "draft":
        // The draft answers a `draft` question this pane's part took; anything else is dropped unread.
        if (this.queue.get(event.cmd)?.command.kind === "draft" && this.queue.settle(event.cmd, part.address, "sent")) this.tell(part, event);
        return empty(204);
      case "ask.open":
        return json(200, this.openAsk(part, event));
      case "ask.close":
        this.asks.get(part.partId)?.delete(event.ask);
        // An answer still queued for the closed ask would wait in the pane's queue for nobody.
        for (const id of this.queue.queued(part.address)) {
          const command = this.queue.get(id)?.command;
          if (command?.kind === "answer" && command.ask === event.ask) this.queue.withdraw(id, "ask-closed");
        }
        this.tell(part, event);
        return empty(204);
      case "draft.state":
        // A boolean, never the text. From a part that did not declare it, dropped unread.
        if (!part.capabilities.has("draft.state")) return empty(204);
        // An older word than the one kept (a late retry) changes nothing and tells nobody.
        if (older(event.seq, this.drafts.get(part.partId))) return empty(204);
        this.drafts.set(part.partId, { value: event.present, at: this.now(), seq: event.seq });
        this.tell(part, event);
        return empty(204);
      case "turn.start":
      case "turn.end":
        if (!part.capabilities.has("wake")) return empty(204);
        if (older(event.seq, this.turns.get(part.partId))) return empty(204);
        this.turns.set(part.partId, { value: event.kind === "turn.start" ? "running" : "idle", at: this.now(), seq: event.seq });
        this.tell(part, event);
        return empty(204);
      case "row": {
        if (!part.capabilities.has("wake")) return empty(204);
        // A stored row is the turn at work: it keeps a "running" word fresh, its count unchanged.
        const turn = this.turns.get(part.partId);
        if (turn?.value === "running") this.turns.set(part.partId, { ...turn, at: this.now() });
        this.tell(part, event);
        return empty(204);
      }
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

  /**
   * The turn the pane's part last reported: `running` after `turn.start`, `idle` after `turn.end`, and
   * null when no part is bound or it reported no turn yet (it bound between turns, or declared no `wake`).
   * A `running` older than {@link WORD_FRESH_MS} (no turn word and no row since) is null too: its
   * `turn.end` may have been lost, and unknown takes the screen road. `anyAge` reads the word whatever
   * its age, for a caller that never sends on it.
   */
  turnOf(address: PaneAddress, options: { readonly anyAge?: boolean } = {}): "running" | "idle" | null {
    const part = this.registry.partOf(address);
    const word = part === null ? undefined : this.turns.get(part.partId);
    if (word === undefined) return null;
    if (word.value === "running" && options.anyAge !== true && this.now() - word.at > WORD_FRESH_MS) return null;
    return word.value;
  }

  /**
   * Whether the pane's box holds a draft, as its part last said: true or false, and null when no part is
   * bound, it did not declare `draft.state`, or it has not said yet since it bound. Null is "unknown":
   * a caller never takes it for "no draft" (M99 spec 05, decision of 2026-11-13). A "draft present"
   * older than {@link WORD_FRESH_MS} is null too: its "no draft" may have been lost (M100 spec 05).
   */
  draftOf(address: PaneAddress): boolean | null {
    const part = this.registry.partOf(address);
    if (part === null || !part.capabilities.has("draft.state")) return null;
    const word = this.drafts.get(part.partId);
    if (word === undefined) return null;
    if (word.value && this.now() - word.at > WORD_FRESH_MS) return null;
    return word.value;
  }

  /**
   * Whether the pane's part holds a question open (`ask.open` with no `ask.close` yet): a dialog stands
   * in the session. A Deliver now never goes then (spec 05). False with no part.
   */
  askOpen(address: PaneAddress): boolean {
    const part = this.registry.partOf(address);
    return part !== null && (this.asks.get(part.partId)?.size ?? 0) > 0;
  }

  /**
   * A hook edge for this pane came from a live agent process that is not the pane's foreground (the edge
   * router drops it `not-foreground`), with that process's pid and whether the edge was its end.
   *
   * The field case (2026-11-16): a Claude Code session moved to a background job. The job's agent runs
   * in a process of its own, under the job host, and writes the session's hooks; the process that stays
   * in the pane is the viewer, still the pane's foreground, and its mod keeps the part it bound before.
   * That part saw none of the job's turns and its submits did not reach the session, so every phone send
   * by data ended "may have arrived" and never arrived. From the first such edge the pane's part is
   * shadowed: its sends and WalkyTalky messages take the screen road, which types into the pane the
   * person sees. An edge of the part's own pid changes nothing; the other process's end edge clears
   * the shadow; a new hello is a new part id, with none.
   */
  noteForeignEdge(address: PaneAddress, pid: number, ended: boolean): void {
    const part = this.registry.partOf(address);
    if (part === null || part.pid === pid) return;
    const known = this.shadows.get(part.partId);
    if (ended) {
      if (known === pid) {
        this.shadows.delete(part.partId);
        this.log(`[inside] unshadowed part=${part.partId.slice(0, 6)} pane=${address.paneId}: pid=${String(pid)} ended`);
      }
      return;
    }
    if (known === pid) return;
    this.shadows.set(part.partId, pid);
    this.log(`[inside] shadowed part=${part.partId.slice(0, 6)} pane=${address.paneId} part-pid=${String(part.pid)} agent-pid=${String(pid)}: sends take the screen road`);
  }

  /** Whether the pane's part is shadowed by another agent process ({@link noteForeignEdge}). False with no part. */
  shadowed(address: PaneAddress): boolean {
    const part = this.registry.partOf(address);
    return part !== null && this.shadows.has(part.partId);
  }

  /** The reason a part gave with `failed`, or null. */
  failReasonOf(id: string): string | null {
    const entry = this.queue.get(id);
    return entry?.state === "failed" ? entry.reason : null;
  }

  /** The part's own words with its `failed` (`detail`, one line, never a text), or null. */
  failDetailOf(id: string): string | null {
    const entry = this.queue.get(id);
    return entry?.state === "failed" ? entry.detail : null;
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
