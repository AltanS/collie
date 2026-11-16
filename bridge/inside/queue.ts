// The command queue of the inside wire (M99 spec 01): what the bridge waits to hand each pane's part.
//
// ONE REQUEST ID, ONE PATH, NEVER TWICE (M99 README, decision 5). A command has one life:
//
//   queued ──take──▶ taken ──part's word──▶ sent | failed
//     │
//     └──withdraw──▶ withdrawn          (the caller may then use the screen path, once)
//     └──expiry────▶ withdrawn          (nobody took it in QUEUED_TTL_MS)
//
// TAKE IS THE HANDOFF, NOT THE ACK. A command is `taken` the moment the bridge writes it into a
// part's `next` answer. From then on the part may act on it, so the bridge never withdraws it, never
// hands it out again and never lets the screen path send it. A part that took it and never says `sent`
// or `failed` leaves it `taken`: the caller's receipt then says it may have arrived, and nothing is sent
// again. A part's `taken` event only confirms the handoff; it changes no state.
//
// Pure apart from timers: no socket, no file. The clock and the scheduler are injected.

import type { WireCommand } from "./wire.ts";

/** Where a command goes: one pane of one session. */
export interface PaneAddress {
  readonly session: string;
  readonly paneId: string;
}

export type CommandState = "queued" | "taken" | "sent" | "failed" | "withdrawn";

/** One command and what became of it. */
export interface QueuedCommand {
  readonly command: WireCommand;
  readonly address: PaneAddress;
  readonly queuedAt: number;
  state: CommandState;
  takenAt: number | null;
  endedAt: number | null;
  /** The part's reason for `failed`, or `expired` for a withdrawal by age. */
  reason: string | null;
  /** The part's own words with a `failed` (an error's class and message), or null. Never a command's text. */
  detail: string | null;
}

/** How long a queued command waits for a part before it is withdrawn by age. */
export const QUEUED_TTL_MS = 60_000;
/** The most commands waiting for one pane. */
export const QUEUE_PER_PANE_MAX = 16;
/** How long a taken command with no word from its part stays in memory. Its state stays `taken`. */
export const TAKEN_KEEP_MS = 10 * 60_000;
/** The most finished commands remembered, so a state can be read after the end and an id is never reused. */
export const HISTORY_MAX = 1024;

export type EnqueueResult = { readonly ok: true } | { readonly ok: false; readonly reason: "duplicate" | "full" };

/** A change of one command's state, for the hub's listeners. */
export type QueueChange = Readonly<QueuedCommand>;

export interface CommandQueueOptions {
  readonly now?: () => number;
  /** Runs `run` after `ms`; returns a cancel. Defaults to an unref'd timer. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
  readonly ttlMs?: number;
}

const timerSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** A waiting `next`: one per part, the newest replaces the older (which then answers nothing). */
interface Waiter {
  readonly key: string;
  readonly ask: string | null;
  readonly resolve: (entry: QueuedCommand | null) => void;
  readonly cancel: () => void;
}

const keyOf = (address: PaneAddress): string => `${address.session}\u0000${address.paneId}`;

/** Whether a waiter with this ask filter may take this command. */
function fits(command: WireCommand, ask: string | null): boolean {
  // A permission hook's poll takes only the answer to its own ask; the main poll takes everything but answers.
  if (ask !== null) return command.kind === "answer" && command.ask === ask;
  return command.kind !== "answer";
}

export class CommandQueue {
  private readonly byId = new Map<string, QueuedCommand>();
  /** Queued ids per pane, oldest first. */
  private readonly pending = new Map<string, string[]>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly finished: string[] = [];
  private readonly listeners: ((change: QueueChange) => void)[] = [];
  private readonly now: () => number;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private readonly ttlMs: number;

  constructor(options: CommandQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? timerSchedule;
    this.ttlMs = options.ttlMs ?? QUEUED_TTL_MS;
  }

  /** Listen to every state change. Never throws to the queue. */
  onChange(listener: (change: QueueChange) => void): void {
    this.listeners.push(listener);
  }

  /** Queue a command for a pane. An id the queue has seen before, in any state, is refused. */
  enqueue(address: PaneAddress, command: WireCommand): EnqueueResult {
    if (this.byId.has(command.id)) return { ok: false, reason: "duplicate" };
    const key = keyOf(address);
    const list = this.pending.get(key) ?? [];
    if (list.length >= QUEUE_PER_PANE_MAX) return { ok: false, reason: "full" };
    const entry: QueuedCommand = { command, address, queuedAt: this.now(), state: "queued", takenAt: null, endedAt: null, reason: null, detail: null };
    this.byId.set(command.id, entry);
    list.push(command.id);
    this.pending.set(key, list);
    this.schedule(() => this.expire(command.id), this.ttlMs);
    this.emit(entry);
    this.feed(key);
    return { ok: true };
  }

  /** Take the oldest command for the pane that fits the filter, now. Marks it taken. */
  take(address: PaneAddress, ask: string | null = null): QueuedCommand | null {
    return this.takeKey(keyOf(address), ask);
  }

  /**
   * Wait up to `ms` for a command for the pane, the long poll behind `next`. A newer wait of the same
   * pane and filter replaces this one, which then resolves null. `signal` ends the wait early with null.
   */
  wait(address: PaneAddress, ask: string | null, ms: number, signal?: AbortSignal): Promise<QueuedCommand | null> {
    const key = keyOf(address);
    const now = this.takeKey(key, ask);
    if (now !== null) return Promise.resolve(now);
    const waiterKey = `${key}\u0000${ask ?? ""}`;
    this.waiters.get(waiterKey)?.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (entry: QueuedCommand | null): void => {
        if (done) return;
        done = true;
        cancelTimer();
        signal?.removeEventListener("abort", onAbort);
        if (this.waiters.get(waiterKey)?.resolve === finish) this.waiters.delete(waiterKey);
        resolve(entry);
      };
      const onAbort = (): void => finish(null);
      const cancelTimer = this.schedule(() => finish(null), ms);
      if (signal?.aborted === true) {
        finish(null);
        return;
      }
      signal?.addEventListener("abort", onAbort);
      this.waiters.set(waiterKey, { key, ask, resolve: finish, cancel: cancelTimer });
    });
  }

  /** Withdraw a command that no part took yet. False once it was taken, or when it ended already. */
  withdraw(id: string, reason: string | null = null): boolean {
    const entry = this.byId.get(id);
    if (entry === undefined || entry.state !== "queued") return false;
    this.unqueue(entry);
    this.end(entry, "withdrawn", reason);
    return true;
  }

  /**
   * The part's word on a taken command: `sent` or `failed`. Only from `taken`, only once, and only from
   * the pane the command was for. False otherwise, and nothing changes.
   */
  settle(id: string, address: PaneAddress, outcome: "sent" | "failed", reason: string | null = null, detail: string | null = null): boolean {
    const entry = this.byId.get(id);
    if (entry === undefined || entry.state !== "taken" || keyOf(entry.address) !== keyOf(address)) return false;
    entry.detail = outcome === "failed" ? detail : null;
    this.end(entry, outcome, reason);
    return true;
  }

  /** Whether a command id belongs to this pane, in any state. */
  isFor(id: string, address: PaneAddress): boolean {
    const entry = this.byId.get(id);
    return entry !== undefined && keyOf(entry.address) === keyOf(address);
  }

  /** The command's state, or null for an id the queue does not know (never queued, or forgotten). */
  stateOf(id: string): CommandState | null {
    return this.byId.get(id)?.state ?? null;
  }

  /** The command and its state, or null. */
  get(id: string): Readonly<QueuedCommand> | null {
    return this.byId.get(id) ?? null;
  }

  /** The ids still queued for a pane, oldest first. */
  queued(address: PaneAddress): readonly string[] {
    return [...(this.pending.get(keyOf(address)) ?? [])];
  }

  /** End every wait of the pane: its part is gone. Queued commands stay for a part that comes back. */
  release(address: PaneAddress): void {
    const key = keyOf(address);
    for (const waiter of Array.from(this.waiters.values())) if (waiter.key === key) waiter.resolve(null);
  }

  private takeKey(key: string, ask: string | null): QueuedCommand | null {
    const list = this.pending.get(key);
    if (list === undefined) return null;
    const index = list.findIndex((id) => {
      const entry = this.byId.get(id);
      return entry !== undefined && fits(entry.command, ask);
    });
    if (index < 0) return null;
    const [id] = list.splice(index, 1);
    if (list.length === 0) this.pending.delete(key);
    const entry = this.byId.get(id!)!;
    entry.state = "taken";
    entry.takenAt = this.now();
    // A part that never gives its word leaves the command taken for good; it joins the history so the
    // memory stays bounded, and a late word still settles it while it is remembered.
    this.schedule(() => {
      if (entry.state === "taken") this.remember(entry.command.id);
    }, TAKEN_KEEP_MS);
    this.emit(entry);
    return entry;
  }

  /** Hand the pane's oldest fitting command to a waiting `next`, if one waits. */
  private feed(key: string): void {
    for (const waiter of Array.from(this.waiters.values())) {
      if (waiter.key !== key) continue;
      const entry = this.takeKey(key, waiter.ask);
      if (entry !== null) waiter.resolve(entry);
    }
  }

  private expire(id: string): void {
    const entry = this.byId.get(id);
    if (entry === undefined || entry.state !== "queued") return;
    this.unqueue(entry);
    this.end(entry, "withdrawn", "expired");
  }

  private unqueue(entry: QueuedCommand): void {
    const key = keyOf(entry.address);
    const list = this.pending.get(key);
    if (list === undefined) return;
    const next = list.filter((id) => id !== entry.command.id);
    if (next.length === 0) this.pending.delete(key);
    else this.pending.set(key, next);
  }

  private end(entry: QueuedCommand, state: "sent" | "failed" | "withdrawn", reason: string | null): void {
    entry.state = state;
    entry.endedAt = this.now();
    entry.reason = reason;
    this.remember(entry.command.id);
    this.emit(entry);
  }

  /** Put an id in the bounded history. The oldest past the cap is forgotten: it reads as unknown, never as queued. */
  private remember(id: string): void {
    if (this.finished.includes(id)) return;
    this.finished.push(id);
    while (this.finished.length > HISTORY_MAX) {
      const old = this.finished.shift();
      if (old !== undefined) this.byId.delete(old);
    }
  }

  private emit(entry: QueuedCommand): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A listener's fault is its own; the queue goes on.
      }
    }
  }
}
