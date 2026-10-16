// THE DURABLE EVENTS READER: a pane's history, read off the program and handed to the bridge's log
// (WIRE.md sections 7.2 and 8). It is not on the snapshot poll's path. The watch starts a pass after
// each census and does not wait for it, so a slow pane never delays the layout.
//
// WHEN IT READS. A pane's events are read when `rev` (or the epoch) moved since that pane was last
// read completely (section 7.1). A snapshot that answered 304 is the same `epoch-rev`, so a quiet
// program costs no events request at all.
//
// THE CURSOR. Each pane has `{ epoch, after }`, in memory and, when the sink keeps it, on disk beside the
// pane's log (WIRE.md 7.16). After a bridge restart the first read of a pane loads the saved cursor and goes
// on from it, so nothing is read twice. A pane with no saved cursor is read from `after=0` on the current
// epoch, the program answers a plain tail or a reset, and the log (bridge/durable/log.ts) writes nothing it
// already holds. A cursor that holds an OLD epoch is read with that old epoch and its old cursor, and the
// program answers a reset reply (section 8.7).
//
// THE LOG KEY. A pane's events go to the log of its session id (`sessionId`, the program's conversation id),
// or of its pane id when the program sends none. It is the key the journal reads the log by
// (`agentSession`), so Chat finds the log under the same name.
//
//   `more`    ask again at once, from `next`;
//   `reset`   the reply is the program's whole current view, applied by the log as an upsert;
//   `trimmed` how many older items the reset view left out. The log keeps what it already holds, and
//             it is handed the count, so it can mark a gap it has no rows for.
//
// WHAT STOPS A PASS. A program that does not answer, answers 503 or 409, or answers an unreadable
// body ends the pass: the adapter's own snapshot poll reports the cause. A 404 means the pane left
// the layout, and its log stays. A 400 means the cursor was bad, so it is forgotten and the pane is
// read again from the start on the next pass. Both forget the saved cursor too.

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
   * Record these events of one pane, under its log key. Resolves with how many were new. `trimmed` is how
   * many older items a reset reply left out (0 otherwise), so the log can mark the gap.
   */
  apply(key: string, events: readonly DurableEvent[], trimmed?: number): Promise<number>;
  /**
   * The file a log key is kept in (M55). When the sink has one, a pane's session ref names that file,
   * so two programs that share a conversation id never share a log. Absent: the ref is the key.
   */
  pathOf?(key: string): string;
  /** The cursor saved for a log key, or null. A sink without it starts every pane at 0 after a restart. */
  loadCursor?(key: string): Promise<DurableCursor | null>;
  /** Save the cursor for a log key, or forget it with null. Called after `apply` took the events. */
  saveCursor?(key: string, cursor: DurableCursor | null): Promise<void>;
}

/**
 * A sink that tells `took` about every `user` item that names a request id, after `sink` recorded the
 * events (M56 spec 14). The program writes the request id of the send that made the item (WIRE.md
 * 7.15), so the item is the program's own word that the text reached the conversation. A replay of
 * events already recorded tells again; the listener must take the same id twice. A listener that
 * throws never stops the log.
 */
export function tapUserItems(sink: DurableEventSink, took: (key: string, requestId: string) => void): DurableEventSink {
  const tapped: DurableEventSink = {
    async apply(key, events, trimmed) {
      const wrote = await sink.apply(key, events, trimmed);
      for (const event of events) {
        if (event.type !== "item" || event.item.kind !== "user" || event.item.requestId === undefined) continue;
        try {
          took(key, event.item.requestId);
        } catch (err) {
          console.warn(`[durable] a user item listener failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return wrote;
    },
  };
  if (sink.pathOf !== undefined) tapped.pathOf = sink.pathOf.bind(sink);
  if (sink.loadCursor !== undefined) tapped.loadCursor = sink.loadCursor.bind(sink);
  if (sink.saveCursor !== undefined) tapped.saveCursor = sink.saveCursor.bind(sink);
  return tapped;
}

/** Where a pane's events were read up to: the epoch the program was in, and the position in it. */
export interface DurableCursor {
  readonly epoch: string;
  readonly after: number;
}

/** The key a pane's log and saved cursor live under: its session id, else its pane id. */
export function logKeyOf(pane: Pick<DurableSnapshot["panes"][number], "id" | "sessionId">): string {
  return pane.sessionId ?? pane.id;
}

/** What the reader needs of the adapter: the version spoken, and the layout last read. */
export interface DurableEventView {
  readonly session: { readonly version: number };
  readonly snapshot: DurableSnapshot;
}

type Cursor = DurableCursor;

export class DurableEventReader {
  private readonly cursors = new Map<string, Cursor>();
  /** The log key each pane id was last read under, so a pane that leaves can forget its saved cursor. */
  private readonly keys = new Map<string, string>();
  /** The `epoch-rev` each pane was last read completely at. */
  private readonly readAt = new Map<string, string>();
  /** The panes whose dropped items were already said in this epoch, as `epoch/paneId`. One log line each (WIRE.md 7.13). */
  private readonly dropSaid = new Set<string>();
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
      if (here.has(paneId)) continue;
      this.cursors.delete(paneId);
      // The pane left the layout: a pane shown again under the same id starts over (a reopen, WIRE.md 7.16).
      const key = this.keys.get(paneId);
      this.keys.delete(paneId);
      if (key !== undefined) await this.forgetSaved(key);
    }
    for (const paneId of this.readAt.keys()) {
      if (!here.has(paneId)) this.readAt.delete(paneId);
    }

    const changed: string[] = [];
    for (const pane of snapshot.panes) {
      if (this.readAt.get(pane.id) === stamp) continue;
      try {
        const read = await this.readPane(pane.id, logKeyOf(pane), session.version, snapshot.epoch);
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

  /** One line per pane per epoch for items the reader dropped, so a program that sends a bad one is found without a flood. */
  private sayDropped(paneId: string, epoch: string, dropped: number): void {
    if (dropped === 0) return;
    const key = `${epoch}/${paneId}`;
    if (this.dropSaid.has(key)) return;
    this.dropSaid.add(key);
    console.warn(`[durable] pane ${paneId}: dropped ${String(dropped)} item(s) that break a rule or have a kind this build does not know (WIRE.md 7.13)`);
  }

  /** Forget a saved cursor. A sink that cannot is only logged: the next read starts at 0, and the log skips repeats. */
  private async forgetSaved(key: string): Promise<void> {
    try {
      await this.sink.saveCursor?.(key, null);
    } catch (err) {
      console.warn(`[durable] cursor of ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The cursor of a pane: the one in memory, else the one saved beside its log, else 0 on the current epoch. */
  private async cursorOf(paneId: string, key: string, currentEpoch: string): Promise<Cursor> {
    const held = this.cursors.get(paneId);
    if (held !== undefined && this.keys.get(paneId) === key) return held;
    this.keys.set(paneId, key);
    const saved = (await this.sink.loadCursor?.(key).catch(() => null)) ?? null;
    return saved ?? { epoch: currentEpoch, after: 0 };
  }

  private async readPane(
    paneId: string,
    key: string,
    version: number,
    currentEpoch: string,
  ): Promise<{ wrote: number; complete: boolean }> {
    let cursor = await this.cursorOf(paneId, key, currentEpoch);
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
        await this.forgetSaved(key);
        return { wrote, complete: true };
      }
      if (reply.status === 400) {
        this.cursors.delete(paneId);
        await this.forgetSaved(key);
        return { wrote, complete: false };
      }
      if (reply.status !== 200) throw new DurableUnreachable(`the durable agent answered ${String(reply.status)}`);

      const parsed = parseEvents(reply.text);
      if (!parsed.ok) throw new DurableUnreachable(`unreadable events: ${parsed.detail}`);
      const events = parsed.value;
      this.sayDropped(paneId, events.epoch, events.droppedItems);
      wrote += await this.sink.apply(key, events.events, events.reset ? events.trimmed : 0);
      // The cursor moves only after the sink took the events, so a failed write is read again. It is saved the
      // same way: a crash between the two reads the last batch again, and the log skips what it holds.
      const moved = cursor.epoch !== events.epoch || cursor.after !== events.next;
      cursor = { epoch: events.epoch, after: events.next };
      this.cursors.set(paneId, cursor);
      if (moved) await this.sink.saveCursor?.(key, cursor);
      if (!events.more) return { wrote, complete: true };
    }
    return { wrote, complete: false };
  }
}
