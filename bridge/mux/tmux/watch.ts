// THE TMUX WATCH — how "tell me to look again" is kept over a multiplexer with no socket.
//
// The contract's promise is small and it is the whole of what this file owes: after something
// changes, a callback fires within the adapter's stated bound, and a notification is a hint to
// RE-READ rather than state (../types.ts § MuxWatchOptions). tmux can keep that promise two ways and
// this watch uses both, because neither alone covers the herd:
//
//  • **Control mode — the push.** `tmux -C attach-session -t $N` is tmux's documented control
//    protocol; it streams `%output %<pane> …` for that session's panes and `%window-add`,
//    `%window-renamed`, `%sessions-changed` and friends for structure (probed, M10/04). That is what
//    the two `push*Events` capabilities declare, and it is a real stream, not a poll wearing a hat.
//
//  • **A bounded census poll — the backstop, and the documented fallback.** Probed limitation: a
//    control client only reports `%output` for panes of the session it is ATTACHED to. Writing into
//    a pane of another session produced nothing. So one client is not a server-wide stream, and the
//    watch attaches one per session — capped, because a client is a real tmux client and an
//    unbounded fan-out over a busy server is a cost the operator never asked for. Above the cap, and
//    whenever no client is up at all, {@link RESYNC_MS} closes the gap: one cheap listing, compared
//    against the last, and a topology callback when it moved. That is also what makes `watch()` work
//    on a tmux too old for control mode — the adapter degrades to a poll rather than going dark.
//
// TWO CLIENT FLAGS ARE LOAD-BEARING and they live in protocol.ts `controlArgs`: `ignore-size` (a
// control client is a real client, and without it every window in the session is squeezed to the
// watcher's 80×24) and `read-only` (this connection can never type; writes go through `send-keys`,
// where the routes' gates already are).
//
// LIFECYCLE IS THIS FILE'S, ENTIRELY. `close()` kills every child and is idempotent; `onDown` fires
// exactly once, on close or on a tmux that stopped answering. A single session's client dying is not
// the watch dying — it is dropped and the next resync re-attaches it.

import type { MuxSubscription, MuxWatchOptions } from "../types.ts";
import type { TmuxControlClient, TmuxExec } from "./exec.ts";
import { classifyControlLine, controlArgs, SEP, saysNoServer } from "./protocol.ts";

/**
 * How often the census poll runs.
 *
 * The bound the adapter states, and the number that makes the fallback honest: a change tmux did not
 * push is seen within this. Deliberately faster than the bridge's own relaxed cadence
 * (`COLLIE_POLL_IDLE_MS`, 12 s) so a caller that relaxed on the strength of the push declaration is
 * still better off than one that did not.
 */
export const RESYNC_MS = 5000;

/** How many control clients one watch will attach. See the header — a client is a real tmux client. */
export const MAX_CONTROL_CLIENTS = 8;

/** Coalescing window for control-mode notifications that ask for a client resync. */
const RESYNC_DEBOUNCE_MS = 250;

/** The listing the census poll runs: enough to see any pane, tab or space appear, move or die. */
const CENSUS_ARGS: readonly string[] = [
  "list-panes",
  "-a",
  "-F",
  ["#{pane_id}", "#{window_id}", "#{session_id}", "#{pane_dead}", "#{window_name}", "#{session_name}"].join(SEP),
];

/** What one census poll learned: the herd as it stands, and which sessions exist to attach to. */
interface Census {
  readonly listing: string;
  readonly sessionIds: readonly string[];
}

/** A pending timer, as the platform hands one back. */
export type WatchTimer = ReturnType<typeof setTimeout>;

/** Timers the watch owns, injectable so nothing here has to be a real clock in a test. */
export interface WatchClock {
  setInterval(fn: () => void, ms: number): WatchTimer;
  clearInterval(handle: WatchTimer): void;
  setTimeout(fn: () => void, ms: number): WatchTimer;
  clearTimeout(handle: WatchTimer): void;
}

/** The default clock: the platform's, with both timers unref'd so neither holds the bridge open. */
export const REAL_CLOCK: WatchClock = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * One live watch over one tmux server.
 *
 * Constructed by the adapter's `watch()` and started immediately; the caller only ever holds the
 * {@link MuxSubscription} half of it.
 */
export class TmuxWatch implements MuxSubscription {
  private readonly clients = new Map<string, TmuxControlClient>();
  private readonly watchedPanes: ReadonlySet<string>;
  private lastListing: string | null = null;
  private ticker: WatchTimer | null = null;
  private debounce: WatchTimer | null = null;
  private up = false;
  private closed = false;
  private syncing = false;

  constructor(
    private readonly exec: TmuxExec,
    private readonly options: MuxWatchOptions,
    private readonly clock: WatchClock = REAL_CLOCK,
  ) {
    this.watchedPanes = new Set(options.panes);
  }

  /** Take the first census, attach the clients it names, and arm the backstop. */
  start(): void {
    this.ticker = this.clock.setInterval(() => void this.sync(), RESYNC_MS);
    void this.sync();
  }

  /** Kill every child, drop every timer, and report down exactly once. */
  close(): void {
    this.end("closed");
  }

  /** Whether this watch has already ended. Read by the adapter, which prunes what it holds. */
  get ended(): boolean {
    return this.closed;
  }

  /**
   * The port's `refresh()`, for this watch: one census NOW, and the backstop re-armed from zero.
   *
   * Re-arming matters as much as the census does. Without it a refresh landing 4.9 s into the cycle
   * would be followed by another listing 100 ms later — two round trips for one question — and the
   * operator's own tap would not have moved the schedule it was trying to move.
   */
  async refresh(): Promise<void> {
    if (this.closed) return;
    await this.sync();
    if (this.closed) return;
    if (this.ticker !== null) this.clock.clearInterval(this.ticker);
    this.ticker = this.clock.setInterval(() => void this.sync(), RESYNC_MS);
  }

  /**
   * One census poll: read the herd, report a change, and reconcile the control clients.
   *
   * Re-entrancy is guarded rather than queued — two overlapping polls would report the same change
   * twice, and the contract permits coalescing but not duplication for its own sake.
   */
  private async sync(): Promise<void> {
    if (this.closed || this.syncing) return;
    this.syncing = true;
    try {
      const census = await this.readCensus();
      if (this.closed) return;
      if (census === null) {
        // tmux itself stopped answering. That IS the watch ending: the caller reconnects on its own
        // backoff (event-poker.ts), which is where reconnect policy belongs.
        this.end("the tmux server is not answering");
        return;
      }
      if (!this.up) {
        this.up = true;
        this.options.onUp();
      }
      // The FIRST census establishes the baseline; only a later difference is a change. Reporting the
      // first one would poke a re-read the caller has just done.
      if (this.lastListing !== null && this.lastListing !== census.listing) this.options.onTopologyChange();
      this.lastListing = census.listing;
      this.attachClients(census.sessionIds);
    } finally {
      this.syncing = false;
    }
  }

  /** The herd as tmux lists it, or null when tmux did not answer at all. */
  private async readCensus(): Promise<Census | null> {
    const result = await this.exec.run(CENSUS_ARGS);
    if (result.code !== 0 && saysNoServer(result.stderr)) return null;
    // A non-zero exit that is NOT "no server" (an empty server answers `no current session`) still
    // tells the truth: no panes. An empty herd is a state, not a failure.
    const listing = result.code === 0 ? result.stdout : "";
    const sessionIds: string[] = [];
    for (const line of listing.split("\n")) {
      const sessionId = line.split(SEP).at(2);
      if (sessionId !== undefined && sessionId.startsWith("$") && !sessionIds.includes(sessionId)) {
        sessionIds.push(sessionId);
      }
    }
    return { listing, sessionIds };
  }

  /** Tear everything down and fire the contract's single `onDown`. Idempotent, by the `closed` gate. */
  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ticker !== null) this.clock.clearInterval(this.ticker);
    if (this.debounce !== null) this.clock.clearTimeout(this.debounce);
    this.ticker = null;
    this.debounce = null;
    for (const client of this.clients.values()) client.kill();
    this.clients.clear();
    this.options.onDown(reason);
  }

  /**
   * Reconcile the attached control clients against the sessions worth attaching to.
   *
   * ATTACHING IS NOT FREE, and that is what bounds this list. A control client receives `%output` for
   * every byte every pane of its session prints — the push this watch exists for, and a stream Collie
   * throws away for any pane nobody is watching. So a client is spent only on a session that owns a
   * pane the caller asked about; with no watched panes at all, exactly ONE client is kept, for the
   * structure notifications. Everything the remaining sessions do is caught by the census poll, which
   * is the same floor the whole watch already stands on.
   */
  private attachClients(sessionIds: readonly string[]): void {
    const wanted = this.worthAttaching(sessionIds).slice(0, MAX_CONTROL_CLIENTS);
    for (const [sessionId, client] of this.clients) {
      if (!wanted.includes(sessionId)) {
        client.kill();
        this.clients.delete(sessionId);
      }
    }
    for (const sessionId of wanted) {
      if (!this.clients.has(sessionId)) this.attach(sessionId);
    }
  }

  /** The sessions that own a watched pane — or, when nothing is watched, the first one alone. */
  private worthAttaching(sessionIds: readonly string[]): string[] {
    if (this.watchedPanes.size === 0) return sessionIds.slice(0, 1);
    const owning = new Set<string>();
    for (const line of (this.lastListing ?? "").split("\n")) {
      const parts = line.split(SEP);
      const paneId = parts.at(0);
      const sessionId = parts.at(2);
      if (paneId !== undefined && sessionId !== undefined && this.watchedPanes.has(paneId)) owning.add(sessionId);
    }
    // A watched pane that no longer exists leaves nothing to attach to; keeping one client means the
    // structure notifications survive a herd whose watched panes have all closed.
    const wanted = sessionIds.filter((sessionId) => owning.has(sessionId));
    return wanted.length > 0 ? wanted : sessionIds.slice(0, 1);
  }

  /** Start one control-mode client and route its lines at the contract's two callbacks. */
  private attach(sessionId: string): void {
    const client = this.exec.control(controlArgs(sessionId), {
      onLine: (line) => this.onControlLine(line),
      onExit: () => {
        // One session's stream ending is not the watch ending — drop it and let the next resync
        // decide whether that session still exists to re-attach to.
        if (this.clients.get(sessionId) === client) this.clients.delete(sessionId);
        this.scheduleResync();
      },
    });
    this.clients.set(sessionId, client);
  }

  private onControlLine(line: string): void {
    if (this.closed) return;
    const classified = classifyControlLine(line);
    if (classified.kind === "pane") {
      // Scoped to what the caller asked to watch: `%output` arrives for every pane of an attached
      // session, and poking a re-read of a pane nobody is looking at is work with no reader.
      if (this.watchedPanes.size === 0 || this.watchedPanes.has(classified.paneId)) {
        this.options.onPaneChange(classified.paneId);
      }
      return;
    }
    if (classified.kind === "topology") {
      this.options.onTopologyChange();
      this.scheduleResync();
      return;
    }
    if (classified.kind === "exit") this.scheduleResync();
  }

  /** Coalesce a burst of structure notifications into one client reconciliation. */
  private scheduleResync(): void {
    if (this.closed || this.debounce !== null) return;
    this.debounce = this.clock.setTimeout(() => {
      this.debounce = null;
      void this.sync();
    }, RESYNC_DEBOUNCE_MS);
  }
}
