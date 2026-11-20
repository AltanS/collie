// Rex watch: one `rex events --all --json` stream, and a periodic census as the backstop.
//
// LIFECYCLE IS THIS FILE'S, ENTIRELY, and it is the tmux and Tern watches' (../tmux/watch.ts,
// ../tern/watch.ts): `end()` is the one way out. It clears the census timer, kills the stream child
// and fires `onDown` exactly once, whether the caller closed the watch or rex stopped answering. The
// poker never calls `close()` on a watch that reported `onDown` (event-poker.ts connects a NEW one),
// so a timer left running after its stream died would leak a census every 5 s for the bridge's life.
//
// The stream is the push: probed, `--all` carries `session_created` / `session_destroyed`, every
// session's window and block lifecycle and label changes, and every block's custom events, among
// them `program_status_changed`. The census is the backstop and the liveness proof — the watch says
// it is up only after a census succeeds.

import type { MuxSubscription, MuxWatchOptions } from "../types.ts";
import type { RexExec, RexStreamClient } from "./exec.ts";
import { parseEvent, parseSessions, parseView, saysUnreachable } from "./protocol.ts";

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

/** A census's answer: a signature of the herd's shape and names, or why rex did not answer. */
type Census = { readonly ok: true; readonly signature: string } | { readonly ok: false; readonly code: number; readonly stderr: string };

/** The herd's shape and names: sessions, windows, blocks, active window, focused block. */
export async function rexCensus(exec: RexExec): Promise<Census> {
  const listed = await exec.run(["ls", "--json", "--short=false"]);
  if (listed.code !== 0) return { ok: false, code: listed.code, stderr: listed.stderr };
  const parts: string[] = [];
  for (const session of parseSessions(listed.stdout)) {
    parts.push(`s:${session.sessionId}:${session.label}`);
    const viewed = await exec.run(["window", "ls", "-s", session.sessionId, "--json"]);
    // A session closed between the two calls: its absence is the change, the next census sees it.
    if (viewed.code !== 0) continue;
    const view = parseView(viewed.stdout);
    parts.push(`a:${view.activeWindowId ?? ""}`);
    for (const window of view.windows) {
      parts.push(`w:${window.windowId}:${window.label}:${window.focusedBlockId ?? ""}`);
      for (const block of window.blocks) parts.push(`b:${block.blockId}`);
    }
  }
  return { ok: true, signature: parts.join(";") };
}

export class RexWatch implements MuxSubscription {
  private client: RexStreamClient | null = null;
  private timer: WatchTimer | null = null;
  private closed = false;
  private up = false;
  private syncing = false;
  private lastSignature: string | null = null;

  constructor(
    private readonly exec: RexExec,
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
    // `onExit` may already have run (no binary): then `end()` has closed us, and arming a timer now
    // would be the leak the header describes. `end()` ran before the handle existed, so kill it here.
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
    const event = parseEvent(line);
    if (event === null) return;
    if (event.kind === "topology") this.options.onTopologyChange();
    if (event.kind === "pane") this.options.onPaneChange(event.blockId);
  }

  /**
   * One census: the backstop for a change the stream did not announce, and the proof rex answers.
   * Re-entrancy is guarded, not queued: a census slower than the interval must not pile up children.
   */
  private async census(): Promise<void> {
    if (this.closed || this.syncing) return;
    this.syncing = true;
    try {
      const census = await rexCensus(this.exec);
      if (this.closed) return;
      if (!census.ok) {
        // Before the first answer, or when rex itself is gone, that IS the watch ending: the caller
        // reconnects on its own backoff. A refusal from a server that answered before is transient.
        if (!this.up || saysUnreachable(census.code, census.stderr)) this.end(census.stderr.trim() || `rex exited ${String(census.code)}`);
        return;
      }
      if (!this.up) {
        this.up = true;
        this.options.onUp();
      }
      if (this.lastSignature !== null && this.lastSignature !== census.signature) this.options.onTopologyChange();
      this.lastSignature = census.signature;
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
