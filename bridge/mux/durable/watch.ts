// THE DURABLE WATCH: A CENSUS, NOT A STREAM (WIRE.md section 7.1, ADR 0073).
//
// The program pushes nothing. This watch keeps the mux contract's small promise by polling: it reads
// the snapshot on a timer, and fires a callback when what it read differs from the read before. The
// read goes through the adapter, so the 250 ms floor between two snapshot reads, the ETag and the
// 304 are the adapter's, and a poll that finds nothing new costs the program next to nothing.
//
// LIFECYCLE IS THIS FILE'S, and it is the Tern watch's shape: `end()` is the one way out. It clears
// the timer and fires `onDown` exactly once, whether the caller closed the watch or the program
// stopped answering. A program that is down, not ready, or not speaking our version ends the watch
// at once, and the caller reconnects on its own backoff (event-poker.ts).
//
// THE PANE LOG. After each census the watch asks the adapter to read the events of every pane whose
// `rev` moved (`syncEvents`, events.ts). It does NOT wait for that read: the next census is armed
// when the snapshot read ends, so a slow or stuck events read never delays the layout. A pane whose
// log gained rows fires `onPaneChange` when it is watched, as does a change in the pane's own facts
// (status, turn, open asks).

import type { MuxAttention, MuxOutcome, MuxSnapshot, MuxSubscription, MuxWatchOptions } from "../types.ts";
import type { DurableSnapshot } from "./protocol.ts";

/**
 * How often a census runs. The adapter answers it from its transport's row of `DURABLE_BUDGETS`
 * (adapter.ts), where each cadence sits beside what one poll costs: 1 s and 3 s on the socket, 2 s and
 * 10 s over HTTPS, where every poll is a billed request.
 */
export interface PollCadence {
  /** While a phone is plainly reading this collie. */
  readonly watchedMs: number;
  /** Otherwise. This is the slowest it ever runs: the adapter's `topologyLatency` ceiling. */
  readonly idleMs: number;
}

/** A pending timer, as the platform hands one back. */
export type WatchTimer = ReturnType<typeof setTimeout>;

/** The one timer the watch owns, injectable so a test never waits on a real clock. */
export interface WatchClock {
  setTimeout(fn: () => void, ms: number): WatchTimer;
  clearTimeout(handle: WatchTimer): void;
}

/** The platform's clock, with the timer unref'd so it never holds the bridge open. */
export const REAL_WATCH_CLOCK: WatchClock = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
};

/** What the watch needs from the adapter: one throttled read, and the clean layout it left behind. */
export interface DurablePoller {
  poll(): Promise<MuxOutcome<MuxSnapshot>>;
  /**
   * The watch's own read, told the delay the watch arms after it. Over HTTPS the adapter serves that read
   * to every other caller for that long, so the watch is the only dialer (adapter.ts). Absent: `poll()`.
   */
  census?(cadenceMs: number): Promise<MuxOutcome<MuxSnapshot>>;
  /** The two cadences of the poller's transport. */
  pollCadence(): PollCadence;
  held(): DurableSnapshot | null;
  /** Read the events of the panes that moved. Absent on a poller that keeps no log. */
  syncEvents?(): Promise<readonly string[]>;
}

/** The layout as one string: any added, removed or renamed workspace, tab or pane, or a status change. */
function layoutOf(snapshot: MuxSnapshot): string {
  const spaces = snapshot.spaces.map((space) => `${space.spaceId}=${space.label}`).join("|");
  const tabs = snapshot.tabs.map((tab) => `${tab.tabId}=${tab.label}`).join("|");
  const panes = snapshot.panes.map((pane) => `${pane.paneId}=${pane.status}:${pane.terminalTitle ?? ""}`).join("|");
  return `${spaces}//${tabs}//${panes}`;
}

/** What a pane's own state, turn and asks look like, per pane id. */
function factsOf(held: DurableSnapshot | null): Map<string, string> {
  const facts = new Map<string, string>();
  for (const pane of held?.panes ?? []) {
    const asks = pane.openAsks.map((ask) => `${ask.id}@${String(ask.revision)}`).join(",");
    facts.set(pane.id, `${pane.state}|${pane.turnId}|${asks}`);
  }
  return facts;
}

export class DurableWatch implements MuxSubscription {
  private timer: WatchTimer | null = null;
  private closed = false;
  private up = false;
  private running = false;
  private lastLayout: string | null = null;
  private lastFacts = new Map<string, string>();

  constructor(
    private readonly poller: DurablePoller,
    private readonly options: MuxWatchOptions,
    private readonly clock: WatchClock = REAL_WATCH_CLOCK,
  ) {
    void this.census();
  }

  /** The delay to the next census, asked each time so attention can arrive or leave under a running watch. */
  private delay(): number {
    const attention: MuxAttention | undefined = this.options.attention?.();
    const cadence = this.poller.pollCadence();
    return attention === "watched" ? cadence.watchedMs : cadence.idleMs;
  }

  private arm(delay: number): void {
    if (this.closed) return;
    this.timer = this.clock.setTimeout(() => void this.census(), delay);
  }

  /**
   * One census. The watch reports itself up only after the first read succeeds, so a program that
   * is down does not flip health up and straight back down on every retry. Re-entrancy is guarded:
   * the next timer is armed after this read ends, so a slow read never piles up. The delay is read
   * once, before the read, so the adapter is told the same delay the watch then arms.
   */
  private async census(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    const delay = this.delay();
    try {
      const outcome = await (this.poller.census?.(delay) ?? this.poller.poll());
      if (this.closed) return;
      if (!outcome.ok) {
        this.end(outcome.detail);
        return;
      }
      this.compare(outcome.value);
    } finally {
      this.running = false;
      this.arm(delay);
    }
  }

  private compare(snapshot: MuxSnapshot): void {
    const layout = layoutOf(snapshot);
    const facts = factsOf(this.poller.held());
    const first = this.lastLayout === null;
    const layoutMoved = !first && layout !== this.lastLayout;
    const moved = first
      ? []
      : this.options.panes.filter((paneId) => facts.get(paneId) !== this.lastFacts.get(paneId));
    this.lastLayout = layout;
    this.lastFacts = facts;

    if (!this.up) {
      this.up = true;
      this.options.onUp();
    }
    if (layoutMoved) this.options.onTopologyChange();
    for (const paneId of moved) this.options.onPaneChange(paneId);
    this.startEvents();
  }

  /** Start an events read and go on. Its answer pokes the watched panes whose log gained rows. */
  private startEvents(): void {
    const sync = this.poller.syncEvents?.();
    if (sync !== undefined) void this.poke(sync);
  }

  private async poke(sync: Promise<readonly string[]>): Promise<void> {
    let paneIds: readonly string[];
    try {
      paneIds = await sync;
    } catch {
      // A failed events read is not the watch's failure: the layout is still being read.
      return;
    }
    if (this.closed) return;
    for (const paneId of paneIds) {
      if (this.options.panes.includes(paneId)) this.options.onPaneChange(paneId);
    }
  }

  /** Tear everything down and fire the contract's single `onDown`. Idempotent, by the `closed` gate. */
  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.options.onDown(reason);
  }

  close(): void {
    this.end("closed");
  }
}
