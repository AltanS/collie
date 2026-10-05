// Tern watch: streams lifecycle events from `tern events` and polls a periodic census backstop.
//
// LIFECYCLE IS THIS FILE'S, ENTIRELY, and it is the tmux watch's (../tmux/watch.ts): `end()` is the one
// way out. It clears the census timer, kills the stream child and fires `onDown` exactly once, whether
// the caller closed the watch or tern stopped answering. The poker never calls `close()` on a watch
// that reported `onDown` (event-poker.ts connects a NEW one), so a watch that left its timer running
// after its stream died leaked one `tern ls` every 5 s for as long as the bridge lived.

import type { MuxSubscription, MuxWatchOptions } from "../types.ts";
import type { TernExec, TernStreamClient } from "./exec.ts";
import { parseEvent, parseListing, saysUnreachable, type TernLsResult } from "./protocol.ts";

export const RESYNC_MS = 5000;

/** A pending timer, as the platform hands one back. */
export type WatchTimer = ReturnType<typeof setTimeout>;

/** The one timer the watch owns, injectable so a test never waits on a real clock. */
export interface WatchClock {
  setInterval(fn: () => void, ms: number): WatchTimer;
  clearInterval(handle: WatchTimer): void;
}

/** The platform's clock, with the timer unref'd so it never holds the bridge open. */
export const REAL_CLOCK: WatchClock = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle),
};

function censusSignature(ls: TernLsResult): string {
  const parts: string[] = [];
  for (const s of ls.sessions) {
    parts.push(`s:${String(s.id)}:${s.name}:${String(s.shown)}`);
    for (const t of s.tabs) {
      parts.push(`t:${String(t.id)}:${t.name ?? ""}:${String(t.shown)}`);
      for (const b of t.blocks) {
        parts.push(`b:${String(b.id)}:${b.title ?? ""}:${String(b.focused)}:${String(b.live)}:${String(b.exited)}`);
      }
    }
  }
  return parts.join(";");
}

export class TernWatch implements MuxSubscription {
  private client: TernStreamClient | null = null;
  private timer: WatchTimer | null = null;
  private closed = false;
  private up = false;
  private syncing = false;
  private lastCensusSig: string | null = null;

  constructor(
    private readonly exec: TernExec,
    private readonly options: MuxWatchOptions,
    private readonly clock: WatchClock = REAL_CLOCK,
  ) {
    this.start();
  }

  private start(): void {
    this.client = this.exec.events({
      onLine: (line) => this.handleLine(line),
      onExit: (reason) => this.end(reason),
    });
    // `onExit` may already have run (no binary, or tern refused at once): then `end()` has closed us,
    // and arming a timer now would be the leak this file's header describes. `end()` ran before the
    // handle existed, so kill it here.
    if (this.closed) {
      this.client.kill();
      this.client = null;
      return;
    }
    this.timer = this.clock.setInterval(() => void this.census(), RESYNC_MS);
    void this.census();
  }

  private handleLine(line: string): void {
    if (this.closed) return;
    const ev = parseEvent(line);
    if (!ev) return;

    // The kinds tern 0.4.5 emits (`tern events --filter` refuses any other name). Measured live:
    // `new session` / `new tab` arrive as `pane_spawned` + `layout_changed`, `close` and `kill
    // session` as `layout_changed` + `pane_closed`, and a tab or session RENAME as a bare
    // `layout_changed` — there is no session event to listen for. `client_connected` /
    // `client_left` are CLI connections, not topology, and are ignored.
    switch (ev.event) {
      case "pane_created":
      case "pane_spawned":
      case "pane_closed":
      case "pane_exited":
      case "tab_created":
      case "tab_closed":
      case "layout_changed":
      case "title_changed":
      case "cwd_changed":
        this.options.onTopologyChange();
        if (ev.pane != null) this.options.onPaneChange(String(ev.pane));
        break;
      case "pane_resized":
        if (ev.pane != null) this.options.onPaneChange(String(ev.pane));
        break;
    }
  }

  /**
   * One census: the backstop for a change the stream did not announce, and the proof that tern answers.
   *
   * The watch reports itself up only after the first listing succeeds. Reporting it from the
   * constructor made a tern that was down flip health up and straight back down on every retry.
   * Re-entrancy is guarded, not queued: a listing slower than the interval must not pile up children.
   */
  private async census(): Promise<void> {
    if (this.closed || this.syncing) return;
    this.syncing = true;
    try {
      const res = await this.exec.run(["ls", "--json"]);
      if (this.closed) return;
      if (res.code !== 0) {
        // Before the first answer, or when tern itself is gone, that IS the watch ending: the
        // caller reconnects on its own backoff. A refusal from a tern that answered before is transient.
        if (!this.up || saysUnreachable(res.code, res.stderr)) this.end(res.stderr.trim() || `tern exited ${String(res.code)}`);
        return;
      }
      const sig = censusSignature(parseListing(res.stdout));
      if (!this.up) {
        this.up = true;
        this.options.onUp();
      }
      if (this.lastCensusSig !== null && this.lastCensusSig !== sig) this.options.onTopologyChange();
      this.lastCensusSig = sig;
    } catch {
      // A listing that did not parse is transient; the next census asks again.
    } finally {
      this.syncing = false;
    }
  }

  /** Tear everything down and fire the contract's single `onDown`. Idempotent, by the `closed` gate. */
  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
    const client = this.client;
    this.client = null;
    client?.kill();
    this.options.onDown(reason);
  }

  close(): void {
    this.end("closed");
  }
}
