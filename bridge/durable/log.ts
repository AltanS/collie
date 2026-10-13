// THE BRIDGE-OWNED PANE LOG: what a durable program said, kept on this machine (ADR 0099 point 8).
//
// A durable program owns its conversations, but it keeps only a tail of them (WIRE.md 7.2), it can
// close a pane, and it can restart. Chat and History must outlive all three. So the bridge writes
// what the adapter reads off the socket into one append-only file per pane under the state dir, and
// the `durable` journal adapter (bridge/journal/durable.ts) reads that file through the journal path
// every other harness uses. There is no second reader.
//
// ONE FILE PER PANE: `<stateDir>/durable/<base64url(paneId)>.jsonl`. The pane id is the program's
// conversation id, so it is the same across a restart of the program. Base64url is a name that no
// id can turn into a path: the file name holds no `/`, no `..` and no case folding.
//
// ROWS, NOT A SNAPSHOT. Every row is one JSON line, written once, never edited. The first line is
// a header, `{"k":"gen","at":ISO,"id":RANDOM}`, new with the file and new again after a rewrite. It is
// the log's generation: a reader holding a byte position from before a rewrite sees another
// generation and starts over, instead of reading the new file from a position that means nothing in it.
//   {"k":"item","at":ISO,"item":{...}}              an item in a version (a later row replaces it by id)
//   {"k":"ask","at":ISO,"ask":{...}}                an open ask, or a higher revision of one
//   {"k":"ask-closed","at":ISO,"askId":...,"by":...} an ask no longer open
//   {"k":"state","at":ISO,"state":"working"}        the pane's state changed
//   {"k":"settled","at":ISO,"inputId":...,...}      an input reached its end
// `at` is when the bridge wrote the row. An item keeps its own `ts` when the program sent one.
//
// IDEMPOTENT ON THE ITEM. The adapter re-reads after a bridge restart, a reset, or an epoch change,
// and a reset replays the whole view. The log therefore remembers the latest version of every item
// (and the revision of every ask) and writes a row only when something is new. The same event twice
// writes once.
//
// WHAT A RESET DOES NOT DO. WIRE.md 7.2 leaves open whether an item the program's view no longer
// lists stays in the bridge's log. It stays: the log is the history, and a program that trims its
// view must not erase what the phone already showed. A `remove` event is treated the same way, for
// the same reason: it is recorded nowhere and removes nothing. The one thing a reset does close is
// an ask the program no longer lists, because that ask can no longer be answered (`by: "reset"`).
//
// BOUNDED. When a file passes {@link LOG_MAX_BYTES} it is rewritten with the newest
// {@link LOG_KEEP_ITEMS} items (each in its latest version, in order of first appearance), the
// settled lines after the oldest of them, the asks still open, and the last state. A rewrite also
// stops at three quarters of the cap, so one that keeps huge items cannot trigger the next rewrite
// at once.
// The rewrite goes to a temporary file and is renamed over the log, so a crash leaves one whole file.
//
// PRIVATE. The folder is 0700 and every log 0600, set when a log is opened even if the folder or
// the file was there before with a wider mode: a conversation holds what the agent read and wrote.
//
// A GAP IS SAID. A reset reply that left out older items (`trimmed`) and whose first item the log has
// never seen means the log is missing what came before it. The log writes one notice item there,
// "Older messages were left out", so Chat does not read as if the conversation began mid-way. Its
// id is derived from the first item's, so the same reset twice writes one marker.
//
// ONE CAP FOR THE MACHINE. All the logs together stay under {@link HOST_MAX_BYTES} (256 MiB): past
// it, the conversation logs written longest ago are deleted first, never the one just written.

import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseLogRow, type DurableEvent, type LogRow } from "../mux/durable/protocol.ts";

/** The row kind of the header line. It carries no content. */
export const GENERATION_ROW = "gen";

/** The folder under the state dir. Written only for a `durable` peer. */
export const LOG_DIR_NAME = "durable";

/** A log past this many bytes is rewritten. */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;

/** How many items a rewrite keeps, the newest. */
export const LOG_KEEP_ITEMS = 2000;

/** All the pane logs of one machine together stay under this many bytes. */
export const HOST_MAX_BYTES = 256 * 1024 * 1024;

/** The words of the notice a gap leaves in the log. */
export const GAP_NOTICE = "Older messages were left out: the program no longer keeps them.";

/** The id of the gap notice in front of `firstItemId`. A valid wire id whatever the first id is. */
export function gapItemId(firstItemId: string): string {
  return `gap-${createHash("sha256").update(firstItemId, "utf8").digest("hex").slice(0, 32)}`;
}

/** The folder the logs live in, for a state dir. */
export function durableLogDir(stateDir: string): string {
  return join(stateDir, LOG_DIR_NAME);
}

/** The file name of one pane's log. Injective, and a plain name whatever the id holds. */
export function logFileName(paneId: string): string {
  return `${Buffer.from(paneId, "utf8").toString("base64url")}.jsonl`;
}

/** What the adapter's events reader hands the log. */
export interface PaneEventSink {
  /**
   * Record these events of one pane. Resolves with how many rows were written. `trimmed` is the
   * reset reply's count of older items it left out, 0 for a plain reply.
   */
  apply(paneId: string, events: readonly DurableEvent[], trimmed?: number): Promise<number>;
}

interface Limits {
  readonly maxBytes: number;
  readonly keepItems: number;
}

const DEFAULT_LIMITS: Limits = { maxBytes: LOG_MAX_BYTES, keepItems: LOG_KEEP_ITEMS };

interface AskNote {
  revision: number;
  open: boolean;
}

/** What the log remembers of its own file, so a repeat can be skipped without reading it. */
interface Index {
  /** Latest version of each item, as JSON, and when its first row was written. */
  readonly items: Map<string, { json: string; at: string }>;
  readonly asks: Map<string, AskNote>;
  readonly settled: Set<string>;
  state: string | null;
  bytes: number;
  /** The file does not end on a newline (a torn last write), so the next append starts one. */
  torn: boolean;
}

/** The header line of a log with a new generation. */
function headerLine(at: string): string {
  return `${JSON.stringify({ k: GENERATION_ROW, at, id: crypto.randomUUID() })}\n`;
}

function rowsOf(text: string): LogRow[] {
  const rows: LogRow[] = [];
  for (const line of text.split("\n")) {
    const row = parseLogRow(line);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function indexOf(text: string): Index {
  const index: Index = {
    items: new Map(),
    asks: new Map(),
    settled: new Set(),
    state: null,
    bytes: Buffer.byteLength(text, "utf8"),
    torn: text !== "" && !text.endsWith("\n"),
  };
  for (const row of rowsOf(text)) {
    switch (row.k) {
      case "item": {
        const known = index.items.get(row.item.id);
        index.items.set(row.item.id, { json: JSON.stringify(row.item), at: known?.at ?? row.at });
        break;
      }
      case "ask":
        index.asks.set(row.ask.id, { revision: row.ask.revision, open: true });
        break;
      case "ask-closed": {
        const known = index.asks.get(row.askId);
        if (known !== undefined) known.open = false;
        break;
      }
      case "state":
        index.state = row.state;
        break;
      case "settled":
        index.settled.add(row.inputId);
        break;
    }
  }
  return index;
}

/** The log of one pane. A single instance per file: it serializes its own writes. */
export class PaneLog {
  private index: Index | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly now: () => number = () => Date.now(),
    private readonly limits: Limits = DEFAULT_LIMITS,
  ) {}

  /** Make sure the file exists, so a pane with no events yet still reads as an empty log. */
  ensure(): Promise<void> {
    return this.apply([]).then(() => undefined);
  }

  /** The file's size as this log last knew it, in bytes. 0 before it was opened. */
  size(): number {
    return this.index?.bytes ?? 0;
  }

  /** Forget what this log knew of its file: the file was deleted under it. */
  forget(): void {
    this.index = null;
  }

  /** Record events in order. Resolves with the rows written. `trimmed`: see {@link PaneEventSink}. */
  apply(events: readonly DurableEvent[], trimmed = 0): Promise<number> {
    const run = this.chain.then(() => this.write(events, trimmed));
    // A failed write must not poison the next one: the chain continues from the failure.
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Index> {
    if (this.index !== null) return this.index;
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // `mode` only holds for a folder mkdir made. One that was there keeps its mode unless set here.
    await chmod(dir, 0o700);
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
      text = "";
    }
    if (text === "") {
      // A new file starts with its generation, so no reader ever holds a position in it without one.
      text = headerLine(new Date(this.now()).toISOString());
      await appendFile(this.path, text, { mode: 0o600 });
    }
    await chmod(this.path, 0o600);
    this.index = indexOf(text);
    return this.index;
  }

  private async write(events: readonly DurableEvent[], trimmed: number): Promise<number> {
    const index = await this.load();
    try {
      return await this.append(index, events, trimmed);
    } catch (err) {
      // The index may be ahead of the disk now. Drop it, and the next call reads the file again.
      this.index = null;
      throw err;
    }
  }

  private async append(index: Index, events: readonly DurableEvent[], trimmed: number): Promise<number> {
    const at = new Date(this.now()).toISOString();
    const lines: string[] = [];
    const put = (row: LogRow): void => {
      lines.push(JSON.stringify(row));
    };
    let resetting = false;
    // The first item of a trimmed reset view decides whether the log has a gap in front of it.
    let gapCheck = false;
    const listed = new Set<string>();

    for (const event of events) {
      switch (event.type) {
        case "item": {
          if (gapCheck) {
            gapCheck = false;
            const gapId = gapItemId(event.item.id);
            if (!index.items.has(event.item.id) && !index.items.has(gapId)) {
              const notice = { id: gapId, kind: "notice" as const, text: GAP_NOTICE };
              put({ k: "item", at, item: notice });
              index.items.set(gapId, { json: JSON.stringify(notice), at });
            }
          }
          const json = JSON.stringify(event.item);
          const known = index.items.get(event.item.id);
          if (known?.json === json) break;
          put({ k: "item", at, item: event.item });
          index.items.set(event.item.id, { json, at: known?.at ?? at });
          break;
        }
        case "ask": {
          if (resetting) listed.add(event.ask.id);
          const known = index.asks.get(event.ask.id);
          // A lower or equal revision is ignored (WIRE.md 7.2), and so is any word about a closed ask.
          if (known !== undefined && (!known.open || event.ask.revision <= known.revision)) break;
          put({ k: "ask", at, ask: event.ask });
          index.asks.set(event.ask.id, { revision: event.ask.revision, open: true });
          break;
        }
        case "ask-closed": {
          const known = index.asks.get(event.askId);
          if (known === undefined || !known.open) break;
          put({ k: "ask-closed", at, askId: event.askId, by: event.by, waitedMs: event.waitedMs });
          known.open = false;
          break;
        }
        case "state":
          if (event.state === index.state) break;
          put({ k: "state", at, state: event.state });
          index.state = event.state;
          break;
        case "settled":
          if (index.settled.has(event.inputId)) break;
          put({
            k: "settled",
            at,
            inputId: event.inputId,
            requestId: event.requestId,
            status: event.status,
            reason: event.reason,
          });
          index.settled.add(event.inputId);
          break;
        case "reset":
          resetting = true;
          gapCheck = trimmed > 0;
          listed.clear();
          break;
        case "synced":
          if (resetting) {
            // The reset view is whole now. An ask it did not list can no longer be answered.
            for (const [askId, known] of index.asks) {
              if (!known.open || listed.has(askId)) continue;
              put({ k: "ask-closed", at, askId, by: "reset" });
              known.open = false;
            }
          }
          resetting = false;
          break;
        case "remove":
          // Not applied: the log is the history (see the header).
          break;
      }
    }
    if (lines.length === 0) return 0;

    const text = `${index.torn ? "\n" : ""}${lines.join("\n")}\n`;
    await appendFile(this.path, text, { mode: 0o600 });
    index.bytes += Buffer.byteLength(text, "utf8");
    index.torn = false;
    if (index.bytes > this.limits.maxBytes) await this.rewrite();
    return lines.length;
  }

  /** Rewrite the file bounded: the newest items, the lines after them, the open asks, the state. */
  private async rewrite(): Promise<void> {
    const text = await readFile(this.path, "utf8");
    const rows = rowsOf(text);

    type Slot = { readonly id: string } | { readonly settled: LogRow };
    const slots: Slot[] = [];
    const latest = new Map<string, LogRow>();
    const firstAt = new Map<string, string>();
    const asks = new Map<string, LogRow>();
    const closed = new Set<string>();
    let state: LogRow | null = null;
    for (const row of rows) {
      if (row.k === "item") {
        if (!latest.has(row.item.id)) {
          slots.push({ id: row.item.id });
          firstAt.set(row.item.id, row.at);
        }
        latest.set(row.item.id, row);
      } else if (row.k === "settled") {
        slots.push({ settled: row });
      } else if (row.k === "ask") {
        asks.set(row.ask.id, row);
      } else if (row.k === "ask-closed") {
        closed.add(row.askId);
      } else {
        state = row;
      }
    }

    // The newest `keepItems` items, and everything after the oldest of them.
    let kept = slots.length;
    let items = 0;
    while (kept > 0 && items < this.limits.keepItems) {
      kept -= 1;
      if ("id" in slots[kept]!) items += 1;
    }
    const tail = slots.slice(kept);

    const lineOf = (slot: Slot): string => {
      if ("settled" in slot) return JSON.stringify(slot.settled);
      const row = latest.get(slot.id);
      if (row === undefined || row.k !== "item") return "";
      // The first row's time, so an item without a `ts` keeps the moment it first appeared.
      return JSON.stringify({ ...row, at: firstAt.get(slot.id) ?? row.at });
    };
    const trailer: string[] = [];
    for (const [id, row] of asks) if (!closed.has(id)) trailer.push(JSON.stringify(row));
    if (state !== null) trailer.push(JSON.stringify(state));

    // Three quarters of the cap is the ceiling for what a rewrite leaves, so the next rewrite is a
    // quarter of the cap of new rows away, however large the kept items are.
    const ceiling = Math.floor((this.limits.maxBytes * 3) / 4);
    let lines = tail.map(lineOf).filter((line) => line !== "");
    let size = lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);
    let from = 0;
    while (size > ceiling && lines.length - from > 1) {
      size -= Buffer.byteLength(lines[from]!, "utf8") + 1;
      from += 1;
    }
    lines = lines.slice(from);

    const body = [...lines, ...trailer].join("\n");
    const out = headerLine(new Date(this.now()).toISOString()) + (body === "" ? "" : `${body}\n`);
    // A fresh name each time, created exclusively, so its 0600 is the mode it is born with.
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, out, { mode: 0o600, flag: "wx" });
    await rename(temp, this.path);
    this.index = indexOf(out);
  }
}

/** Every pane's log under one folder. The sink the adapter's events reader writes to. */
export class DurableLogs implements PaneEventSink {
  private readonly logs = new Map<string, PaneLog>();
  /** The folder's total bytes as last counted plus what was written since; null until first counted. */
  private total: number | null = null;

  constructor(
    readonly dir: string,
    private readonly now: () => number = () => Date.now(),
    private readonly limits: Limits = DEFAULT_LIMITS,
    private readonly hostMaxBytes: number = HOST_MAX_BYTES,
  ) {}

  /** The log of one pane. The same instance every time, so its writes stay in order. */
  forPane(paneId: string): PaneLog {
    let log = this.logs.get(paneId);
    if (log === undefined) {
      log = new PaneLog(join(this.dir, logFileName(paneId)), this.now, this.limits);
      this.logs.set(paneId, log);
    }
    return log;
  }

  async apply(paneId: string, events: readonly DurableEvent[], trimmed = 0): Promise<number> {
    const log = this.forPane(paneId);
    const before = log.size();
    const wrote = await log.apply(events, trimmed);
    if (wrote > 0) await this.hold(log, log.size() - before);
    return wrote;
  }

  /** Keep the folder under the machine's cap, oldest conversation first, never `writing`. */
  private async hold(writing: PaneLog, grew: number): Promise<void> {
    this.total = this.total === null ? await this.count() : this.total + grew;
    if (this.total <= this.hostMaxBytes) return;
    const files = await this.files();
    this.total = files.reduce((sum, file) => sum + file.bytes, 0);
    for (const file of files.toSorted((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (this.total <= this.hostMaxBytes) break;
      if (file.path === writing.path) continue;
      await unlink(file.path).catch(() => undefined);
      this.total -= file.bytes;
      for (const [paneId, log] of this.logs) {
        if (log.path !== file.path) continue;
        log.forget();
        this.logs.delete(paneId);
      }
    }
  }

  private async count(): Promise<number> {
    return (await this.files()).reduce((sum, file) => sum + file.bytes, 0);
  }

  /** Every pane log in the folder, with its size and when it was last written. */
  private async files(): Promise<{ path: string; bytes: number; mtimeMs: number }[]> {
    const names = await readdir(this.dir).catch((): string[] => []);
    const out: { path: string; bytes: number; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(this.dir, name);
      const facts = await stat(path).catch(() => null);
      if (facts !== null && facts.isFile()) out.push({ path, bytes: facts.size, mtimeMs: facts.mtimeMs });
    }
    return out;
  }
}
