// THE ZELLIJ WATCH — a HYBRID, and the most load-bearing design decision in this adapter.
//
// The contract's promise is small and it is the whole of what this file owes: after something
// changes, a callback fires within the adapter's stated bound, and a notification is a hint to
// RE-READ rather than state (../types.ts § MuxWatchOptions). zellij can keep half of that promise
// with a real push and cannot keep the other half at all, so the watch does both:
//
//  • **Content — a real stream.** `zellij subscribe --ansi --format json --pane-id <id> …` follows
//    several panes at once and pushes newline-delimited JSON on every repaint (probed, M10/05:
//    `{"event":"pane_update","is_initial":true,"pane_id":"terminal_2","viewport":[…]}`). That is what
//    `pushPaneEvents` declares, and it is a stream, not a poll wearing a hat.
//
//  • **Topology — a bounded, adaptive census.** NOTHING in zellij's CLI announces a pane being
//    created or a tab being renamed. Searched and failed to find one: `zellij action --help` has no
//    watch/event verb, `zellij watch` is a read-only ATTACH (a whole TUI, not a feed), and `zellij
//    pipe` needs a WASM plugin on the other end — the plugin API is where such an event lives, and a
//    plugin is not a CLI surface. So the census below is the only source, `pushTopologyEvents` is
//    declared ABSENT, and the poll's cadence is part of the spec rather than an implementation
//    detail (M10/05).
//
// ── THE ONE TOPOLOGY FACT THE STREAM DOES CARRY ──────────────────────────────────────────────────
//
// `{"event":"pane_closed","pane_id":"terminal_3"}` — probed, followed by the stream exiting once
// nothing is left to follow. A pane the operator is LOOKING AT going away is the topology change
// they notice soonest, so it is reported immediately and the census is pulled back to its floor. It
// covers only followed panes, which is why it shortens the poll rather than replacing it.
//
// ── THE CADENCE, AND WHY IT IS THESE TWO NUMBERS ─────────────────────────────────────────────────
//
// Every census is a `zellij` process: a fork, an exec and a round trip to the session. A fixed fast
// poll spends that forever on a herd nobody is changing; a fixed slow one makes a new pane appear
// late. So it is adaptive in exactly the way the frontend's own poller already is
// (`web/src/hooks/use-polling.ts`, hot 1.5 s → cold 4 s): it runs at {@link ZELLIJ_CENSUS_MIN_MS}
// after any change and doubles up to {@link ZELLIJ_CENSUS_MAX_MS} while nothing moves.
//
// Both ends are chosen against something. The floor is 3 s rather than the frontend's 1.5 s because
// a census here costs a process rather than a fetch, and topology changes at human speed. The
// ceiling is 12 s because that is `COLLIE_POLL_IDLE_MS`, the bridge's own relaxed cadence — a caller
// that read `pushTopologyEvents: false` and relaxed to its idle floor is never worse off than the
// watch backing it.
//
// LIFECYCLE IS THIS FILE'S, ENTIRELY. `close()` kills the stream and drops every timer and is
// idempotent; `onDown` fires exactly once, on close or on a session that stopped answering. The
// stream ending is NOT the watch ending — it is re-established at the next census if the panes are
// still there, which is also how the watch recovers when the operator restarts their session.

import type { MuxSubscription, MuxWatchOptions } from "../types.ts";
import type { ZellijStreamClient } from "./exec.ts";
import { censusSignature, parsePaneList, parseStreamEvent, subscribeArgs, ZELLIJ_LIST_PANES_ARGS } from "./protocol.ts";
import type { ZellijSessionBinding } from "./session.ts";

/** The census floor: how soon after a change the next one runs. See the header for why 3 s. */
export const ZELLIJ_CENSUS_MIN_MS = 3000;

/** The census ceiling: the longest a quiet herd waits. The bridge's own idle cadence. */
export const ZELLIJ_CENSUS_MAX_MS = 12_000;

/** A pending timer, as the platform hands one back. */
export type WatchTimer = ReturnType<typeof setTimeout>;

/** Timers the watch owns, injectable so nothing here has to be a real clock in a test. */
export interface WatchClock {
  setTimeout(fn: () => void, ms: number): WatchTimer;
  clearTimeout(handle: WatchTimer): void;
}

/** The default clock: the platform's, unref'd so a pending census never holds the bridge open. */
export const REAL_CLOCK: WatchClock = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * One live watch over one zellij session.
 *
 * Constructed by the adapter's `watch()` and started immediately; the caller only ever holds the
 * {@link MuxSubscription} half of it.
 */
export class ZellijWatch implements MuxSubscription {
  private readonly watchedPanes: readonly string[];
  /** The panes the current stream follows, so a reconcile knows whether to restart it. */
  private streaming: readonly string[] = [];
  private stream: ZellijStreamClient | null = null;
  /** Last frame seen per pane. The first one is a baseline the caller has already read. */
  private readonly lastFrame = new Map<string, string>();
  private lastCensus: string | null = null;
  private interval = ZELLIJ_CENSUS_MIN_MS;
  private timer: WatchTimer | null = null;
  private up = false;
  private closed = false;
  private censusing = false;

  constructor(
    private readonly session: ZellijSessionBinding,
    private readonly options: MuxWatchOptions,
    private readonly clock: WatchClock = REAL_CLOCK,
  ) {
    // De-duplicated and frozen at construction: the set a watch follows is the caller's request for
    // the life of the subscription, and `subscribe` would open a second follower for a repeated id.
    this.watchedPanes = [...new Set(options.panes)];
  }

  /** Take the first census, open the stream it justifies, and arm the adaptive timer. */
  start(): void {
    void this.census();
  }

  /** Kill the stream, drop the timer, and report down exactly once. */
  close(): void {
    this.end("closed");
  }

  /**
   * One census: read the herd, report a change, and reconcile the stream against what still exists.
   *
   * Re-entrancy is guarded rather than queued — two overlapping censuses would report the same
   * change twice, and the contract permits coalescing but not duplication for its own sake.
   */
  private async census(): Promise<void> {
    if (this.closed || this.censusing) return;
    this.censusing = true;
    try {
      const call = await this.session.run(ZELLIJ_LIST_PANES_ARGS);
      if (this.closed) return;
      if (!call.ok) {
        // The session itself stopped answering. That IS the watch ending: the caller reconnects on
        // its own backoff (event-poker.ts), which is where reconnect policy belongs — and a fresh
        // watch re-discovers the session, which is how this recovers from a restart.
        this.end(call.detail);
        return;
      }
      const panes = parsePaneList(call.result.stdout);
      if (panes === null) {
        // zellij answered something that is not a listing. A malformed answer is not a dead session,
        // so the watch stays up and the next census gets another go.
        this.rearm(false);
        return;
      }
      if (!this.up) {
        this.up = true;
        this.options.onUp();
      }
      const signature = censusSignature(panes);
      // The FIRST census establishes the baseline; only a later difference is a change. Reporting
      // the first one would poke a re-read the caller has just done.
      const changed = this.lastCensus !== null && this.lastCensus !== signature;
      this.lastCensus = signature;
      if (changed) this.options.onTopologyChange();
      this.reconcileStream(panes.filter((pane) => !pane.exited).map((pane) => pane.paneId));
      this.rearm(changed);
    } finally {
      this.censusing = false;
    }
  }

  /** Schedule the next census: back to the floor after a change, doubling while nothing moves. */
  private rearm(changed: boolean): void {
    if (this.closed) return;
    this.interval = changed ? ZELLIJ_CENSUS_MIN_MS : Math.min(this.interval * 2, ZELLIJ_CENSUS_MAX_MS);
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => void this.census(), this.interval);
  }

  /**
   * Open, keep or replace the pane stream.
   *
   * The stream follows exactly the watched panes that still exist — a `subscribe` naming a pane that
   * has gone away refuses the whole invocation (probed: `Pane terminal_999 not found`, exit 2), so
   * one closed pane would otherwise take the stream down for every other pane with it. Restarting is
   * bounded to the census cadence by construction: nothing else calls this.
   */
  private reconcileStream(alive: readonly string[]): void {
    const live = new Set(alive);
    const wanted = this.watchedPanes.filter((paneId) => live.has(paneId));
    if (this.stream !== null && sameSet(wanted, this.streaming)) return;
    this.killStream();
    if (wanted.length === 0) return;
    this.streaming = wanted;
    void this.openStream(wanted);
  }

  private async openStream(paneIds: readonly string[]): Promise<void> {
    const bound = await this.session.argsFor(subscribeArgs(paneIds));
    // Everything may have moved on while the session name was being resolved.
    if (this.closed || !bound.ok || !sameSet(paneIds, this.streaming) || this.stream !== null) return;
    const client = this.session.spawnStream([...bound.args], {
      onLine: (line) => this.onStreamLine(line),
      onExit: () => {
        if (this.stream !== client) return;
        this.stream = null;
        this.streaming = [];
        // Deliberately no immediate restart. The stream ends when every followed pane has closed,
        // when the session went away, or when it was killed — and the next census tells the three
        // apart. Re-spawning here would be a restart loop against a session that is not answering.
      },
    });
    this.stream = client;
  }

  private onStreamLine(line: string): void {
    if (this.closed) return;
    const event = parseStreamEvent(line);
    if (event === null) return;
    if (event.kind === "closed") {
      this.lastFrame.delete(event.paneId);
      // A followed pane going away is a structure change AND the fastest one zellij will tell us
      // about. Pull the census back to its floor so the rest of the herd catches up straight away.
      this.options.onTopologyChange();
      this.rearm(true);
      return;
    }
    const previous = this.lastFrame.get(event.paneId);
    this.lastFrame.set(event.paneId, event.text);
    // The first frame is the screen the caller already has: `subscribe` opens with `is_initial` and
    // the caller's own read is what established this watch. Poking a re-read for it is work with no
    // reader. Every later frame that differs is the change the stream exists to report.
    if (previous !== undefined && previous !== event.text) this.options.onPaneChange(event.paneId);
  }

  private killStream(): void {
    const client = this.stream;
    this.stream = null;
    this.streaming = [];
    client?.kill();
  }

  /** Tear everything down and fire the contract's single `onDown`. Idempotent, by the `closed` gate. */
  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.killStream();
    this.lastFrame.clear();
    this.options.onDown(reason);
  }
}

/** Whether two id lists hold the same ids. Order is not meaningful — `subscribe` takes a set. */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(right);
  return left.every((id) => seen.has(id));
}
