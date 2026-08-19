import type { MuxAdapter, MuxSubscription } from "./mux/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Event-poked polling. A long-lived watch on the multiplexer whose ONLY job is to
// trigger immediate (debounced) re-polls. While the watch is healthy the engine
// relaxes to a safety-net cadence; when it's down the engine falls back to fast
// polling. Events are never state here — a missed one costs one interval, never
// correctness — so the snapshot poll stays the single source of truth. See index.ts.
//
// This file owns the LIFECYCLE (debounce, backoff, health) and nothing else: which
// events exist, and whether they arrive as a push or a poll, is the adapter's — a
// multiplexer with no event stream keeps the same promise by polling, and the poker
// cannot tell (mux/types.ts → MuxWatchOptions). Both of the contract's callbacks land
// on the same debounced poke, because "something changed, re-read" is the whole
// signal this class carries.
// ─────────────────────────────────────────────────────────────────────────────

/** Order-insensitive, duplicate-insensitive comparison — the subscription set only cares which ids. */
export function sameIdSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

interface EventPokerOpts {
  /** Trailing-debounce window (ms) that coalesces a burst of events into one poke. */
  debounceMs?: number;
  /** Reconnect backoff schedule (ms); the last entry repeats indefinitely. */
  backoffMs?: number[];
}

export class EventPoker {
  private readonly debounceMs: number;
  private readonly backoff: number[];
  private agentPanes: string[] = [];
  private started = false;
  private healthy = false;
  private backoffIdx = 0;
  // The active watch handle; identity-compared in callbacks so a superseded watch's late `onDown`
  // (from a deliberate close during reconnect/stop) is ignored instead of flapping health.
  private stream: MuxSubscription | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pokeListeners = new Set<() => void>();
  private readonly healthListeners = new Set<(healthy: boolean) => void>();

  constructor(
    private readonly mux: MuxAdapter,
    opts: EventPokerOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 200;
    this.backoff = opts.backoffMs ?? [1000, 2000, 5000, 15000];
  }

  onPoke(cb: () => void): () => void {
    this.pokeListeners.add(cb);
    return () => this.pokeListeners.delete(cb);
  }

  onHealth(cb: (healthy: boolean) => void): () => void {
    this.healthListeners.add(cb);
    return () => this.healthListeners.delete(cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Detach BEFORE closing so the close's `onDown` is seen as stale (no health flip, no reconnect).
    const s = this.stream;
    this.stream = null;
    if (s) s.close();
  }

  /** The fresh snapshot after any pane lifecycle event feeds this; a changed set means re-watch. */
  setAgentPanes(ids: string[]): void {
    if (sameIdSet(ids, this.agentPanes)) return;
    this.agentPanes = [...ids];
    if (this.started) this.reconnect();
  }

  private connect(): void {
    const watched = this.agentPanes.length;
    const changed = () => {
      if (this.stream !== handle) return;
      this.schedulePoke();
    };
    const handle: MuxSubscription = this.mux.watch({
      panes: this.agentPanes,
      onUp: () => {
        if (this.stream !== handle) return;
        this.backoffIdx = 0;
        // A re-watch acks while already healthy, so setHealthy dedupes it silently — but it's the
        // only journal evidence that the per-pane watch followed the herd. Log it.
        if (this.healthy) console.log(`[events] resubscribed (${watched} panes watched)`);
        this.setHealthy(true, watched);
      },
      onTopologyChange: changed,
      onPaneChange: changed,
      onDown: (reason) => {
        if (this.stream !== handle) return;
        this.stream = null;
        this.setHealthy(false, watched, reason);
        if (this.started) this.scheduleReconnect();
      },
    });
    this.stream = handle;
  }

  private reconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.stream;
    this.stream = null;
    if (old) old.close();
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoff[Math.min(this.backoffIdx, this.backoff.length - 1)] ?? 1000;
    this.backoffIdx++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started) this.connect();
    }, delay);
  }

  private schedulePoke(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      for (const cb of this.pokeListeners) cb();
    }, this.debounceMs);
  }

  private setHealthy(healthy: boolean, watched: number, reason?: string): void {
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    if (healthy) console.log(`[events] stream up (${watched} panes watched)`);
    else console.log(`[events] stream down: ${reason ?? "unknown"} — fast polling until it recovers`);
    for (const cb of this.healthListeners) cb(healthy);
  }
}
