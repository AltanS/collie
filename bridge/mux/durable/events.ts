// THE DURABLE EVENTS READER: a pane's history, read off the program and handed to the bridge's log
// (WIRE.md sections 7.2 and 8). It is not on the snapshot poll's path. The watch starts a pass after
// each census and does not wait for it, so a slow pane never delays the layout.
//
// WHEN IT READS. A pane's events are read when `rev` (or the epoch) moved since that pane was last
// read completely (section 7.1). A snapshot that answered 304 is the same `epoch-rev`, so a quiet
// program costs no events request at all.
//
// THE CURSOR. Each pane has `{ epoch, after }` in memory. It is not saved: after a bridge restart the
// first read is `after=0` on the current epoch, the program answers a plain tail or a reset, and the
// log (bridge/durable/log.ts) writes nothing it already holds. A pane read for the first time is
// `after=0` and the current epoch; a pane whose cursor holds an OLD epoch is read with that old epoch
// and its old cursor, and the program answers a reset reply (section 8.7).
//
//   `more`    ask again at once, from `next`;
//   `reset`   the reply is the program's whole current view, applied by the log as an upsert;
//   `trimmed` how many older items the reset view left out. The log keeps what it already holds, and
//             it is handed the count, so it can mark a gap it has no rows for.
//
// WHAT STOPS A PASS. A program that does not answer, answers 503 or 409, or answers an unreadable
// body ends the pass: the adapter's own snapshot poll reports the cause. A 404 means the pane left
// the layout, and its log stays. A 400 means the cursor was bad, so it is forgotten and the pane is
// read again from the start on the next pass.

import { REPLY_CAPS } from "./clean.ts";
import { DurableUnreachable, type DurableTransport } from "./client.ts";
import { parseEvents, type DurableEvent, type DurableSnapshot } from "./protocol.ts";

/**
 * The budget for one events read over the socket (WIRE.md section 7.6). The adapter passes the
 * transport's own read budget, so an events read over HTTPS waits as long as a snapshot read there.
 */
export const EVENTS_TIMEOUT_MS = 1000;

/** Most `more` rounds one pane takes in one pass. A program that never stops saying `more` does not hold the pass. */
export const MAX_ROUNDS_PER_PANE = 20;

/** Where the events go. The bridge's pane log is one; a test supplies its own. */
export interface DurableEventSink {
  /**
   * Record these events of one pane. Resolves with how many were new. `trimmed` is how many older
   * items a reset reply left out (0 otherwise), so the log can mark the gap.
   */
  apply(paneId: string, events: readonly DurableEvent[], trimmed?: number): Promise<number>;
}

/** What the reader needs of the adapter: the version spoken, and the layout last read. */
export interface DurableEventView {
  readonly session: { readonly version: number };
  readonly snapshot: DurableSnapshot;
}

interface Cursor {
  readonly epoch: string;
  readonly after: number;
}

export class DurableEventReader {
  private readonly cursors = new Map<string, Cursor>();
  /** The `epoch-rev` each pane was last read completely at. */
  private readonly readAt = new Map<string, string>();
  private running: Promise<readonly string[]> | null = null;
  private again = false;

  constructor(
    private readonly transport: DurableTransport,
    private readonly sink: DurableEventSink,
    private readonly view: () => DurableEventView | null,
    private readonly timeoutMs: number = EVENTS_TIMEOUT_MS,
  ) {}

  /**
   * Read every pane whose `rev` moved. At most one pass runs at a time: a call during a pass asks for
   * one more after it, and both calls resolve with the panes whose log gained rows in either.
   */
  sync(): Promise<readonly string[]> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    const run = this.drain().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async drain(): Promise<readonly string[]> {
    const changed = new Set<string>();
    do {
      this.again = false;
      for (const paneId of await this.pass()) changed.add(paneId);
    } while (this.again);
    return [...changed];
  }

  private async pass(): Promise<string[]> {
    const view = this.view();
    if (view === null) return [];
    const { snapshot, session } = view;
    const stamp = `${snapshot.epoch}-${String(snapshot.rev)}`;
    const here = new Set(snapshot.panes.map((pane) => pane.id));
    for (const paneId of this.cursors.keys()) {
      if (!here.has(paneId)) this.cursors.delete(paneId);
    }
    for (const paneId of this.readAt.keys()) {
      if (!here.has(paneId)) this.readAt.delete(paneId);
    }

    const changed: string[] = [];
    for (const pane of snapshot.panes) {
      if (this.readAt.get(pane.id) === stamp) continue;
      try {
        const read = await this.readPane(pane.id, session.version, snapshot.epoch);
        if (read.wrote > 0) changed.push(pane.id);
        if (read.complete) this.readAt.set(pane.id, stamp);
      } catch (err) {
        // The program cannot be asked: its snapshot poll names why. Stop here.
        if (err instanceof DurableUnreachable) return changed;
        // The log could not be written (a full disk). The pane is read again on the next pass.
        console.warn(`[durable] pane ${pane.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return changed;
  }

  private async readPane(
    paneId: string,
    version: number,
    currentEpoch: string,
  ): Promise<{ wrote: number; complete: boolean }> {
    let cursor = this.cursors.get(paneId) ?? { epoch: currentEpoch, after: 0 };
    let wrote = 0;
    for (let round = 0; round < MAX_ROUNDS_PER_PANE; round += 1) {
      const query = `after=${String(cursor.after)}&epoch=${encodeURIComponent(cursor.epoch)}`;
      const reply = await this.transport.get({
        path: `/pane/${encodeURIComponent(paneId)}/events?${query}`,
        version,
        ifNoneMatch: null,
        timeoutMs: this.timeoutMs,
        maxBytes: REPLY_CAPS.events,
      });
      if (reply.status === 404) {
        // The pane left the layout. Its log stays; there is nothing more to read.
        this.cursors.delete(paneId);
        return { wrote, complete: true };
      }
      if (reply.status === 400) {
        this.cursors.delete(paneId);
        return { wrote, complete: false };
      }
      if (reply.status !== 200) throw new DurableUnreachable(`program answered ${String(reply.status)}`);

      const parsed = parseEvents(reply.text);
      if (!parsed.ok) throw new DurableUnreachable(`unreadable events: ${parsed.detail}`);
      const events = parsed.value;
      wrote += await this.sink.apply(paneId, events.events, events.reset ? events.trimmed : 0);
      // The cursor moves only after the sink took the events, so a failed write is read again.
      cursor = { epoch: events.epoch, after: events.next };
      this.cursors.set(paneId, cursor);
      if (!events.more) return { wrote, complete: true };
    }
    return { wrote, complete: false };
  }
}
