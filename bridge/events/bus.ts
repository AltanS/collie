// THE EVENT BUS (M105 spec 03, decisions 3 to 8). One per bridge. Its sources (bridge/events/sources.ts)
// publish what happened to an agent session; its listeners (the local API, the trick runner) read it.
// It imports nothing from the API or the tricks code, and they do not import each other
// (bridge/events/seam.test.ts holds that). Each listener builds its own wire shape from a bus event,
// so the API's `events` answer and a trick's `trigger` can change apart.
//
// THE EVENT. `{ v: 1, id, cursor, ts, type, machine, session, data }`. Types: `session.status`
// (`data.state`, the agent status), `turn.end` and `ask.open` (`data: {}`), and the two markers a
// pull reader can get, `gap` and `reset`. `session` is the opaque session id (session-id.ts); a marker
// names no session (`null`). `cursor` is opaque text, `<boot id>.<sequence>`; the boot id is new each
// time a bus is built, so a cursor from an earlier bridge start is known as one.
//
// NO TEXT IN AN EVENT (decision 4). Ids and states only: no screen text, no question, no options, no
// folder path, no title. `publish` takes a typed shape and copies only the fields it knows, so an extra
// field a caller passes does not reach the event; the ids are checked against a narrow character set.
// A listener that wants content asks for it with a read.
//
// DELIVERY (decision 6): AT LEAST ONCE, PER MACHINE, WITH NO ORDER ACROSS SESSIONS. A listener must be
// safe against a repeated event (a pull reader that resumes from an older cursor sees events again).
// A crew's lead does not merge its members' buses. Within one session the bus keeps publish order, with
// one exception a push listener sees: a coalesced `session.status` moves to the place of the newest one.
//
// PULL (`since`, `waitFor`). A ring buffer, bounded by count (2048) and by age (one hour). `since`
// with no cursor answers no events and the head, so a new reader starts at now. A cursor of this boot
// inside the buffer answers the events after it. A cursor of this boot older than the buffer answers
// ONE `gap` and then every buffered event; a cursor of another boot, or text that is no cursor, answers
// ONE `reset` and then every buffered event. Never a silent hole. A marker's own cursor sits just before
// the oldest buffered event, so a reader that resumes from it loses nothing more.
//
// PUSH (`subscribe`, decision 7). The bus never blocks and never waits on a listener. Each listener
// has ONE bounded queue (256 by default). `session.status` is coalesced per session: a new one REMOVES
// the queued one of that session and is APPENDED, so the newest state is the one delivered and a
// session's order stays the order of publish (a `turn.end` is never overtaken by the status before it).
// Every other type is first in, first out; when the queue is full the OLDEST event that is not a
// `session.status` goes (the oldest status only when the queue holds nothing else), and the listener's
// `dropped` count grows. The delivery is a pull: `take()` hands over the queued batch and the count of
// events dropped since the last take, and clears both. `onReady` is a notice, called once when the queue
// goes from empty to holding something; it must only schedule work, and a notice that throws is caught,
// so a listener can never break a publish. `unsubscribe` frees the queue.

/** The agent states a `session.status` carries: the bridge's AgentStatus, spelled here so the bus stays pure. */
export type SessionState = "idle" | "working" | "blocked" | "done" | "unknown";

const STATES: ReadonlySet<string> = new Set<SessionState>(["idle", "working", "blocked", "done", "unknown"]);

/** No fields at all. */
export type EmptyData = Readonly<Record<string, never>>;

interface EventBase {
  readonly v: 1;
  readonly id: string;
  readonly cursor: string;
  readonly ts: string;
  readonly machine: string;
}

export interface SessionStatusEvent extends EventBase {
  readonly type: "session.status";
  readonly session: string;
  readonly data: { readonly state: SessionState };
}

export interface TurnEndEvent extends EventBase {
  readonly type: "turn.end";
  readonly session: string;
  readonly data: EmptyData;
}

export interface AskOpenEvent extends EventBase {
  readonly type: "ask.open";
  readonly session: string;
  readonly data: EmptyData;
}

/** A pull reader's cursor was older than the buffer: events were lost between it and the buffer. */
export interface GapEvent extends EventBase {
  readonly type: "gap";
  readonly session: null;
  readonly data: { readonly reason: "evicted" };
}

/** A pull reader's cursor was of another bridge start, or no cursor at all. */
export interface ResetEvent extends EventBase {
  readonly type: "reset";
  readonly session: null;
  readonly data: { readonly reason: "other-boot" | "unreadable" };
}

/** What a source publishes and a listener receives. */
export type LiveEvent = SessionStatusEvent | TurnEndEvent | AskOpenEvent;
/** Every event a reader can get, the markers included. */
export type BusEvent = LiveEvent | GapEvent | ResetEvent;

/** What a source hands to {@link EventBus.publish}. Only these fields are read. */
export type PublishInput =
  | { readonly type: "session.status"; readonly session: string; readonly data: { readonly state: SessionState } }
  | { readonly type: "turn.end"; readonly session: string }
  | { readonly type: "ask.open"; readonly session: string };

/** What a pull answers: the events, and the cursor to resume from. */
export interface SinceAnswer {
  readonly events: readonly BusEvent[];
  readonly next: string;
}

/** Why a wait ended. */
export type WaitOutcome = "event" | "timeout" | "aborted";

/** What one `take` hands over. */
export interface Batch {
  readonly events: readonly LiveEvent[];
  /** Events this queue dropped since the last take. */
  readonly dropped: number;
}

/** How many push listeners and waits are open. */
export interface ListenerCount {
  readonly subscriptions: number;
  readonly waits: number;
}

export interface SubscribeOptions {
  /** The queue's bound. Default {@link DEFAULT_QUEUE}. */
  readonly capacity?: number;
  /** Called once when the queue goes from empty to holding something. Must only schedule work. */
  readonly onReady?: () => void;
}

export interface Subscription {
  /** The queued events and the dropped count since the last take; both are cleared. */
  take(): Batch;
  /** Stop listening; the queue is freed and `take` answers nothing from now on. */
  unsubscribe(): void;
}

export interface EventBusOptions {
  /** This bridge's stable id, stamped on every event. Read at each publish. */
  readonly machine: () => string;
  /** The boot id inside every cursor. Default: eight random characters of `[a-z0-9]`. */
  readonly bootId?: string;
  /** The buffer's count bound. Default {@link DEFAULT_RING_COUNT}. */
  readonly maxCount?: number;
  /** The buffer's age bound in ms. Default {@link DEFAULT_RING_AGE_MS}. */
  readonly maxAgeMs?: number;
  /** Epoch ms. Default `Date.now`. */
  readonly now?: () => number;
}

export const DEFAULT_RING_COUNT = 2048;
export const DEFAULT_RING_AGE_MS = 60 * 60 * 1000;
export const DEFAULT_QUEUE = 256;

// An id the bus stamps or copies: a machine id, a session id. No space, no slash, no text.
const ID_TEXT = /^[A-Za-z0-9_.:-]{1,512}$/u;
const BOOT_ID = /^[a-z0-9]{1,32}$/u;
const CURSOR = /^([a-z0-9]{1,32})\.(0|[1-9][0-9]{0,14})$/u;
const BOOT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomBootId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) {
    if (b >= 252) continue;
    out += BOOT_CHARS[b % 36];
    if (out.length === 8) break;
  }
  // Sixteen draws with a 1.6% skip each: eight characters short is not a case that happens, but stays safe.
  return out === "" ? "b" : out;
}

interface Stored {
  readonly seq: number;
  readonly at: number;
  readonly event: LiveEvent;
}

interface Waiter {
  readonly after: string | undefined;
  readonly resolve: (outcome: WaitOutcome) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

class Queue implements Subscription {
  private events: LiveEvent[] = [];
  private dropped = 0;
  private open = true;

  constructor(
    private readonly capacity: number,
    private readonly onReady: (() => void) | undefined,
    private readonly leave: (queue: Queue) => void,
  ) {}

  push(event: LiveEvent): void {
    if (!this.open) return;
    const wasEmpty = this.events.length === 0 && this.dropped === 0;
    if (event.type === "session.status") {
      const at = this.events.findIndex((held) => held.type === "session.status" && held.session === event.session);
      if (at >= 0) this.events.splice(at, 1);
    }
    if (this.events.length >= this.capacity) this.dropOne();
    this.events.push(event);
    if (wasEmpty) this.notify();
  }

  private dropOne(): void {
    const fifo = this.events.findIndex((held) => held.type !== "session.status");
    this.events.splice(fifo >= 0 ? fifo : 0, 1);
    this.dropped += 1;
  }

  private notify(): void {
    if (this.onReady === undefined) return;
    try {
      this.onReady();
    } catch {
      // A listener's notice never breaks a publish (decision 7).
    }
  }

  take(): Batch {
    const batch: Batch = { events: this.events, dropped: this.dropped };
    this.events = [];
    this.dropped = 0;
    return batch;
  }

  unsubscribe(): void {
    if (!this.open) return;
    this.open = false;
    this.events = [];
    this.dropped = 0;
    this.leave(this);
  }
}

export class EventBus {
  readonly bootId: string;
  private readonly machine: () => string;
  private readonly maxCount: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly ring: Stored[] = [];
  private seq = 0;
  private markers = 0;
  private readonly queues = new Set<Queue>();
  private readonly waiters = new Set<Waiter>();

  constructor(opts: EventBusOptions) {
    const bootId = opts.bootId ?? randomBootId();
    if (!BOOT_ID.test(bootId)) throw new TypeError("event bus: a boot id is 1 to 32 of [a-z0-9]");
    this.bootId = bootId;
    this.machine = opts.machine;
    this.maxCount = Math.max(1, opts.maxCount ?? DEFAULT_RING_COUNT);
    this.maxAgeMs = Math.max(1, opts.maxAgeMs ?? DEFAULT_RING_AGE_MS);
    this.now = opts.now ?? Date.now;
  }

  /** The cursor of the newest event (or of the start, before any). */
  head(): string {
    return this.cursorOf(this.seq);
  }

  /**
   * Record one event and hand it to every listener. Never waits on a listener, and never throws because
   * of one. Throws only on input that is the caller's bug: an id outside the narrow set, an unknown state.
   */
  publish(input: PublishInput): LiveEvent {
    const machine = this.machine();
    if (!ID_TEXT.test(machine)) throw new TypeError("event bus: the machine id is not an id");
    if (!ID_TEXT.test(input.session)) throw new TypeError("event bus: the session is not an id");
    const at = this.now();
    this.seq += 1;
    const base = { v: 1 as const, id: `evt_${this.cursorOf(this.seq)}`, cursor: this.cursorOf(this.seq), ts: new Date(at).toISOString(), machine };
    const event = Object.freeze(this.liveOf(input, base));
    this.ring.push({ seq: this.seq, at, event });
    this.evict(at);
    for (const queue of this.queues) queue.push(event);
    this.wakeAll();
    return event;
  }

  private liveOf(input: PublishInput, base: EventBase): LiveEvent {
    switch (input.type) {
      case "session.status": {
        const state = input.data.state;
        if (!STATES.has(state)) throw new TypeError("event bus: an unknown session state");
        return { ...base, type: "session.status", session: input.session, data: Object.freeze({ state }) };
      }
      case "turn.end":
        return { ...base, type: "turn.end", session: input.session, data: Object.freeze({}) };
      case "ask.open":
        return { ...base, type: "ask.open", session: input.session, data: Object.freeze({}) };
      default: {
        const never: never = input;
        throw new TypeError(`event bus: an unknown event type ${String(never)}`);
      }
    }
  }

  /** The events after `cursor` (see the header for the four cases), and the cursor to resume from. */
  since(cursor: string | undefined): SinceAnswer {
    this.evict(this.now());
    const next = this.head();
    if (cursor === undefined) return { events: [], next };
    const parsed = CURSOR.exec(cursor);
    if (parsed === null) return { events: [this.reset("unreadable"), ...this.buffered()], next };
    const seq = Number(parsed[2]);
    if (parsed[1] !== this.bootId || seq > this.seq) return { events: [this.reset("other-boot"), ...this.buffered()], next };
    if (seq < this.oldestSeq() - 1) return { events: [this.gap(), ...this.buffered()], next };
    return { events: this.ring.filter((stored) => stored.seq > seq).map((stored) => stored.event), next };
  }

  /**
   * Resolve once `since(after)` would answer an event, after `ms`, or when `signal` aborts, whichever
   * comes first. At once when there is something to answer already. Leaves no timer and no listener.
   */
  waitFor(after: string | undefined, ms: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (signal?.aborted === true) return Promise.resolve("aborted");
    if (after !== undefined && this.since(after).events.length > 0) return Promise.resolve("event");
    return new Promise<WaitOutcome>((resolve) => {
      const waiter: Waiter = { after, resolve, signal, timer: undefined, onAbort: () => this.wake(waiter, "aborted") };
      this.waiters.add(waiter);
      waiter.timer = setTimeout(() => this.wake(waiter, "timeout"), Math.max(0, ms));
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  /** End one wait, once: only a waiter still in the set is resolved, and its timer and abort listener go. */
  private wake(waiter: Waiter, outcome: WaitOutcome): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(outcome);
  }

  /** Open a push listener with its own bounded queue (see the header). */
  subscribe(opts: SubscribeOptions = {}): Subscription {
    const capacity = Math.max(1, opts.capacity ?? DEFAULT_QUEUE);
    const queue = new Queue(capacity, opts.onReady, (gone) => this.queues.delete(gone));
    this.queues.add(queue);
    return queue;
  }

  /** How many push listeners and waits are open: for a test and a status line. */
  listeners(): ListenerCount {
    return { subscriptions: this.queues.size, waits: this.waiters.size };
  }

  private wakeAll(): void {
    // A waiter with no cursor waits for the next event; one with a cursor wakes when it has one to read.
    for (const waiter of this.waiters) {
      if (waiter.after === undefined || this.since(waiter.after).events.length > 0) this.wake(waiter, "event");
    }
  }

  private evict(at: number): void {
    const floor = at - this.maxAgeMs;
    let drop = Math.max(0, this.ring.length - this.maxCount);
    while (drop < this.ring.length && this.ring[drop]!.at < floor) drop += 1;
    if (drop > 0) this.ring.splice(0, drop);
  }

  private oldestSeq(): number {
    return this.ring[0]?.seq ?? this.seq + 1;
  }

  private buffered(): LiveEvent[] {
    return this.ring.map((stored) => stored.event);
  }

  private markerBase(): EventBase & { readonly session: null } {
    this.markers += 1;
    return {
      v: 1,
      id: `evt_${this.bootId}.m${String(this.markers)}`,
      // Just before the oldest buffered event: resuming from here loses nothing more.
      cursor: this.cursorOf(this.oldestSeq() - 1),
      ts: new Date(this.now()).toISOString(),
      machine: this.machine(),
      session: null,
    };
  }

  private gap(): GapEvent {
    return Object.freeze({ ...this.markerBase(), type: "gap", data: Object.freeze({ reason: "evicted" }) });
  }

  private reset(reason: ResetEvent["data"]["reason"]): ResetEvent {
    return Object.freeze({ ...this.markerBase(), type: "reset", data: Object.freeze({ reason }) });
  }

  private cursorOf(seq: number): string {
    return `${this.bootId}.${String(seq)}`;
  }
}
