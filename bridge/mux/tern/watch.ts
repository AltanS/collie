// Tern watch: streams lifecycle events from `tern events` and polls a periodic census backstop.

import type { MuxSubscription, MuxWatchOptions } from "../types.ts";
import type { TernExec, TernStreamClient } from "./exec.ts";
import { parseEvent, parseListing, type TernLsResult } from "./protocol.ts";

export const RESYNC_MS = 5000;

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
  private timer: Timer | null = null;
  private closed = false;
  private up = false;
  private down = false;
  private lastCensusSig: string | null = null;

  constructor(
    private readonly exec: TernExec,
    private readonly options: MuxWatchOptions,
  ) {
    this.start();
  }

  private start(): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.closed || this.up) return;
      this.up = true;
      this.options.onUp();
    });

    this.client = this.exec.events({
      onLine: (line) => this.handleLine(line),
      onExit: (reason) => this.handleExit(reason),
    });

    this.timer = setInterval(() => void this.census(), RESYNC_MS);
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

  private async census(): Promise<void> {
    if (this.closed) return;
    try {
      const res = await this.exec.run(["ls", "--json"]);
      if (res.code !== 0) return;
      const ls = parseListing(res.stdout);
      const sig = censusSignature(ls);
      if (this.lastCensusSig !== null && this.lastCensusSig !== sig) {
        this.options.onTopologyChange();
      }
      this.lastCensusSig = sig;
    } catch {
      // transient failure
    }
  }

  private handleExit(reason: string): void {
    if (this.closed || this.down) return;
    this.down = true;
    this.options.onDown(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.client) {
      this.client.kill();
      this.client = null;
    }
    if (!this.down) {
      this.down = true;
      this.options.onDown("closed");
    }
  }
}
