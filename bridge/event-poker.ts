import type { HerdrClient } from "./herdr-client.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Event-poked polling. A long-lived events.subscribe stream whose ONLY job is to
// trigger immediate (debounced) re-polls. While the stream is healthy the engine
// relaxes to a safety-net cadence; when it's down the engine falls back to fast
// polling. Events are never state here — a missed event costs one interval, never
// correctness — so the snapshot poll stays the single source of truth. See index.ts.
//
// Some transports (the Windows CLI) have NO event stream: subscribeEvents returns
// null. That's a steady state, not a transient drop — so it gets its own poll mode
// (`no-events`) with a dedicated cadence and NO reconnect loop, rather than being
// treated as a stream that keeps failing.
// ─────────────────────────────────────────────────────────────────────────────

/** A subscription request entry: global (just `type`) or pane-scoped (needs `pane_id`). */
export type Subscription = { type: string; pane_id?: string };

/**
 * How the engine should be polling, derived from the event stream's state:
 *   • `streaming`  — stream healthy; events poke re-polls, so relax to the safety-net cadence.
 *   • `fast`       — stream is (transiently) down and reconnecting; poll fast until it recovers.
 *   • `no-events`  — transport can't stream at all; poll on the dedicated no-events cadence forever.
 */
export type PollMode = "streaming" | "fast" | "no-events";

// Global events that change what Collie's snapshot renders. We deliberately DROP layout.*,
// worktree.*, pane.scroll_changed and pane.output_matched — none of them alter the herd view we
// poll for, so subscribing would only add pokes that re-fetch identical state. Also NO
// workspace.moved / tab.moved: they're new in herdr 0.7.2, and one unknown subscription type
// rejects the whole subscribe — which would keep the stream permanently down on exactly the older
// servers the session.snapshot fallback supports. Moves are rare and the safety-net poll covers
// them within one COLLIE_POLL_IDLE_MS.
const GLOBAL_SUBSCRIPTIONS: readonly string[] = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
];

/**
 * The full subscription list for the current set of agent panes: every global above, plus one
 * pane-scoped `pane.agent_status_changed` per agent pane (the status flips that drive triage).
 */
export function buildSubscriptions(agentPaneIds: string[]): Subscription[] {
  const subs: Subscription[] = GLOBAL_SUBSCRIPTIONS.map((type) => ({ type }));
  for (const id of agentPaneIds) subs.push({ type: "pane.agent_status_changed", pane_id: id });
  return subs;
}

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
  private mode: PollMode = "fast";
  private backoffIdx = 0;
  // The active stream handle; identity-compared in callbacks so a superseded stream's late `onDown`
  // (from a deliberate close during reconnect/stop) is ignored instead of flapping the mode.
  private stream: { close(): void } | null = null;
  // Set once a connect() attempt returns null: this transport has no event stream, so stop trying.
  private streamUnsupported = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pokeListeners = new Set<() => void>();
  private readonly modeListeners = new Set<(mode: PollMode) => void>();

  constructor(
    private readonly client: HerdrClient,
    opts: EventPokerOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 200;
    this.backoff = opts.backoffMs ?? [1000, 2000, 5000, 15000];
  }

  onPoke(cb: () => void): () => void {
    this.pokeListeners.add(cb);
    return () => this.pokeListeners.delete(cb);
  }

  /** Notified whenever the poll mode changes (drives StateEngine's cadence). Fires once per change. */
  onPollMode(cb: (mode: PollMode) => void): () => void {
    this.modeListeners.add(cb);
    return () => this.modeListeners.delete(cb);
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

  /** The fresh snapshot after any pane lifecycle event feeds this; a changed set means re-subscribe. */
  setAgentPanes(ids: string[]): void {
    if (sameIdSet(ids, this.agentPanes)) return;
    this.agentPanes = [...ids];
    // No stream to re-scope on a poll-only transport — the snapshot poll already covers every pane.
    if (this.started && !this.streamUnsupported) this.reconnect();
  }

  private connect(): void {
    const subs = buildSubscriptions(this.agentPanes);
    const handle = this.client.subscribeEvents({
      subscriptions: subs,
      onUp: () => {
        if (this.stream !== handle) return;
        this.backoffIdx = 0;
        // A resubscribe acks while already streaming, so setMode dedupes it silently — but it's the
        // only journal evidence that the per-pane subscriptions followed the herd. Log it.
        if (this.mode === "streaming") console.log(`[events] resubscribed (${subs.length} subscriptions)`);
        this.setMode("streaming", subs.length);
      },
      onEvent: () => {
        if (this.stream !== handle) return;
        this.schedulePoke();
      },
      onDown: (reason) => {
        if (this.stream !== handle) return;
        this.stream = null;
        this.setMode("fast", subs.length, reason);
        if (this.started) this.scheduleReconnect();
      },
    });
    // A null handle means this transport can't stream at all (Windows CLI). Latch it: no stream to
    // track, no reconnect loop, and poll on the dedicated no-events cadence. Correctness is
    // unaffected — events were only ever a poke; the snapshot poll is the source of truth.
    if (handle == null) {
      this.streamUnsupported = true;
      this.stream = null;
      this.setMode("no-events", subs.length);
      return;
    }
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

  private setMode(mode: PollMode, subCount: number, reason?: string): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === "streaming") console.log(`[events] stream up (${subCount} subscriptions)`);
    else if (mode === "fast") console.log(`[events] stream down: ${reason ?? "unknown"} — fast polling until it recovers`);
    else console.log("[events] no event stream on this transport — polling on the no-events cadence");
    for (const cb of this.modeListeners) cb(mode);
  }
}
