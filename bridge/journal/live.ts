// The live window: what a screen watching a working session asks every poll, and the bounded thing
// the bridge holds so that asking costs the change rather than the session.
//
// ── THE SHAPE OF THE ANSWER, AND WHY IT IS THREE NUMBERS ─────────────────────
// A window answers `{ gen, rev, head, oldest, hasOlder, upserts }`. Three of those are positions and
// each does ONE job, which is why none of them can be merged into another:
//
//  - `gen`  — WHICH NUMBERING. It changes when the window rebuilt from a fresh tail read, which
//             renumbers everything. A client holding another `gen` must replace what it holds; there
//             is no way to merge two numberings, and pretending otherwise is how a thread ends up
//             with one turn drawn twice.
//  - `rev`  — WHEN. It moves once per tick that produced anything, and every entry carries the `rev`
//             it was last touched at. `upserts` is "every entry newer than the `rev` you hold".
//  - `seq`  — WHERE. A turn's place in the thread, assigned once and never reassigned. An entry that
//             changes in place is the same item at the same `seq`.
//
// **`rev` is the field spec 08 sketched as `seq`, and the sketch was wrong.** A tool result lands in a
// later row than its call and edits a turn that went out long ago, so "what is new" cannot be read off
// a position watermark: the turn that changed sits BELOW the watermark, and a `seq`-cursored answer
// would never mention it. One number cannot be both the place a turn sits and the moment it last
// moved. Splitting them is what makes `upserts` a single list keyed by `uuid` — the spec's own
// requirement — instead of a "replace" verb the wire does not have.
//
// ── WHAT IS BOUNDED, AND WHAT THAT COSTS ────────────────────────────────────
// The sessions measured on 2026-09-29 were 186.8 MB, 89.8 MB and 64.9 MB. A window holds at most
// {@link MAX_LIVE_BYTES} of composed turns and {@link MAX_LIVE_ENTRIES} of them, whichever bites
// first, and it trims from the OLD end. So a session of any size costs the same memory, and the turns
// that fall off the front are not lost: they are the History read's job (`store.ts`), reached through
// `?before=`, and `hasOlder` is how a client knows to offer it.
//
// ── NO READER MEANS NO WORK ──────────────────────────────────────────────────
// There is no timer in this file. A tick happens because somebody asked, with a floor of
// {@link TICK_FLOOR_MS} so several readers of one session share one read, and a window nobody has
// asked about for {@link WINDOW_IDLE_MS} is dropped whole. That is the rule `use-polling.ts` already
// follows on the other side of the wire, restated on this one.

import type { Cursor } from "./cursor.ts";
import { NO_CURSOR } from "./cursor.ts";
import type { RowReducer } from "./reduce.ts";
import type { TranscriptStore } from "./store.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry } from "./types.ts";

/**
 * How many bytes of composed turns one window holds. Roughly, and deliberately so — the weight of an
 * entry is the length of its JSON, which is what it costs on the wire and close to what it costs in
 * memory. Exact accounting would mean walking every part of every turn to no useful end.
 */
export const MAX_LIVE_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * How many turns one window holds, whatever they weigh.
 *
 * The byte bound alone is not enough: ten thousand one-word turns weigh nothing and still cost ten
 * thousand objects, a `Map` entry each, and a body the phone has to parse.
 */
export const MAX_LIVE_ENTRIES = 2000;

/**
 * The fewest turns a window keeps, whatever they weigh.
 *
 * A single turn CAN be bigger than {@link MAX_LIVE_BYTES} all by itself — a tool result holding a
 * whole file is the ordinary case — and a bound with no floor would trim the window empty trying to
 * get under it, leaving a live session showing nothing at all.
 */
export const MIN_LIVE_ENTRIES = 16;

/**
 * The shortest gap between two reads of one session.
 *
 * Ticks are request-driven, so this is what stops N readers of one pane from costing N reads: the
 * second asker inside the floor is served the window the first one's read filled. It is well under
 * the phone's own 1.5 s poll, so a single reader never waits on it.
 */
export const TICK_FLOOR_MS = 250;

/** How long a window survives with nobody asking about it. Then it is dropped whole. */
export const WINDOW_IDLE_MS = 120_000;

/**
 * How many sessions are held live at once. The oldest-asked goes first.
 *
 * Small on purpose: this is "how many conversations is somebody watching", not "how many panes
 * exist". A crew's worth of panes polls the SNAPSHOT; a Chat screen is open on one session at a time,
 * and a second device makes two.
 */
export const MAX_WINDOWS = 8;

/** Turns in a first answer, when the client holds no cursor. */
export const DEFAULT_CHAT_LIMIT = 40;

/** Ceiling for `?limit=`. Past this a first paint is not a first paint, it is a History page. */
export const MAX_CHAT_LIMIT = 200;

/**
 * Where `seq` numbering starts.
 *
 * NOT zero, and not one. A thread grows at BOTH ends: forward as the agent writes, and backward as
 * the reader taps "older", which numbers turns DOWN from the window's own oldest. Starting in the
 * middle of the space leaves a million turns of room behind the first one we ever saw, so a backward
 * page never needs a negative position and the wire never needs a sign.
 */
export const SEQ_BASE = 1_000_000;

/**
 * One turn as the wire carries it: the entry, plus where it sits.
 *
 * `seq` is assigned once. A turn that changes in place keeps it, which is what lets a client hold one
 * list and merge an answer into it by `uuid` without ever asking where a changed turn moved to.
 */
export interface ChatEntry extends TranscriptEntry {
  seq: number;
}

/** What one window answers. See this file's header for what each position means. */
export interface ChatWindowBody {
  /** Which of the two answers this is. The client asked, so it knows; a type still has to be told. */
  page: "live";
  /** Which numbering. A different one from the one you hold means replace, never merge. */
  gen: number;
  /** When. Send it back as `?after=<gen>:<rev>` and the next answer is what moved since. */
  rev: number;
  /** The newest `seq` held. Below `oldest` when the window is empty, which is the honest reading. */
  head: number;
  /** The oldest `seq` the LIVE window still holds. Older turns come off disk, through `?before=`. */
  oldest: number;
  /** Turns exist before `oldest`. What drives "load older". */
  hasOlder: boolean;
  /**
   * Added and changed turns together, oldest first, keyed by `uuid` and positioned by `seq`.
   *
   * ONE list, because there is nothing for a second one to say. A client holds turns by `uuid`; an
   * entry it already has is replaced in place and an entry it does not is inserted at its `seq`. The
   * two cases are the same write.
   */
  upserts: ChatEntry[];
}

/**
 * A `?before=` page: older turns off disk, numbered into the same `gen` the live window uses.
 *
 * It carries `upserts` and not a differently-named list on purpose: an older turn is a turn to put
 * into the thread at its `seq`, which is exactly what a live one is. One merge on the client, two
 * reasons to call it. What this answer cannot say is where the live tail got to, so it does not
 * pretend to: no `rev`, no `head`, no `oldest`.
 */
export interface ChatOlderBody {
  page: "older";
  gen: number;
  /** Oldest first, the turns immediately before the one asked about. */
  upserts: ChatEntry[];
  /** Turns exist before `upserts[0]` too. */
  hasOlder: boolean;
}

/** Either answer. The route serves one body type, discriminated by {@link ChatWindowBody.page}. */
export type ChatBody = ChatWindowBody | ChatOlderBody;

/** `?after=<gen>:<rev>`, read off the query. */
export interface ChatAfter {
  gen: number;
  rev: number;
}

/** `?before=<seq>:<uuid>`, read off the query — the oldest turn the client holds. */
export interface ChatBefore {
  seq: number;
  uuid: string;
}

/** One page request off the query string. `after` and `before` are never both honoured. */
export interface ChatParams {
  limit: number;
  after?: ChatAfter;
  before?: ChatBefore;
}

/** Digits only, both fields of both tokens: a position is never negative and never a float. */
const DIGITS = /^\d+$/;

/**
 * Read `?after=<gen>:<rev>`.
 *
 * Null for anything that is not exactly that, and null means "I hold nothing" — which is the safe
 * direction, because the answer is then the window's newest turns rather than a wrong delta.
 */
export function parseChatAfter(raw: string | null): ChatAfter | null {
  if (raw === null) return null;
  const [gen, rev, extra] = raw.split(":");
  if (extra !== undefined || gen === undefined || rev === undefined) return null;
  if (!DIGITS.test(gen) || !DIGITS.test(rev)) return null;
  const pair = { gen: Number(gen), rev: Number(rev) };
  return Number.isSafeInteger(pair.gen) && Number.isSafeInteger(pair.rev) ? pair : null;
}

/**
 * Read `?before=<seq>:<uuid>` — one entry the client holds, by both of its names.
 *
 * It needs both. The `uuid` is what the read on disk pages backwards from (the History path's own
 * cursor, unchanged), and the `seq` is what the answer's turns are numbered DOWN from, so the page
 * lands in the numbering the client already has. A uuid alone would arrive with no place to go.
 *
 * The uuid is length-capped and never touches the filesystem: it only ever reaches an in-memory
 * `findIndex` over already-parsed turns, exactly as `?before=` on the History route does.
 */
export function parseChatBefore(raw: string | null): ChatBefore | null {
  if (raw === null) return null;
  const cut = raw.indexOf(":");
  if (cut <= 0) return null;
  const seq = raw.slice(0, cut);
  const uuid = raw.slice(cut + 1);
  if (!DIGITS.test(seq) || uuid === "" || uuid.length > 100) return null;
  const at = Number(seq);
  return Number.isSafeInteger(at) ? { seq: at, uuid } : null;
}

/**
 * The whole query, clamped. Pure and exported for the reason every route parser here is: the handler
 * lives inside `Bun.serve`, which `bun test` cannot stand up.
 */
export function chatParams(url: URL): ChatParams {
  const raw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_CHAT_LIMIT) : DEFAULT_CHAT_LIMIT;
  const params: ChatParams = { limit };
  // Assigned, never conditionally spread, so an unreadable token leaves the key OFF — which the
  // window reads as "this client holds nothing", the only safe reading of a token it cannot trust.
  const before = parseChatBefore(url.searchParams.get("before"));
  if (before !== null) {
    params.before = before;
    return params;
  }
  const after = parseChatAfter(url.searchParams.get("after"));
  if (after !== null) params.after = after;
  return params;
}

/**
 * Generation numbers, seeded from the clock.
 *
 * A bridge restart must not hand out a `gen` a phone is already holding, or a stale thread would be
 * merged into a numbering that has nothing to do with it. Seeding from `Date.now()` makes that
 * practically impossible without keeping anything on disk, and `Math.max` keeps it strictly
 * increasing inside a process whatever the clock does.
 */
let lastGen = 0;
function nextGen(): number {
  lastGen = Math.max(Date.now(), lastGen + 1);
  return lastGen;
}

/** One turn held live. Mutable, because a tool result edits the turn its call went out in. */
interface LiveRow {
  readonly seq: number;
  /** The tick this row was last added or changed at. What `?after=` selects on. */
  rev: number;
  /** Bytes of JSON, re-measured when the row changes — the bound's own arithmetic. */
  weight: number;
  readonly entry: TranscriptEntry;
}

/** What a row costs. The length of its JSON: what it weighs on the wire, and near what it weighs here. */
function weigh(entry: TranscriptEntry): number {
  return JSON.stringify(entry).length;
}

/**
 * The wire form of one turn: a COPY of the entry, carrying its position.
 *
 * A copy, because the entry itself belongs either to a live row (which a later tool result mutates in
 * place) or to the History store's cache (which every other reader shares). Writing a `seq` onto
 * either would be writing a request's own bookkeeping into state that outlives the request.
 *
 * Shallow, which is enough: the body is serialised before control leaves the handler, so nothing can
 * mutate a shared `parts` array in between.
 */
function chatEntry(entry: TranscriptEntry, seq: number): ChatEntry {
  return Object.assign({ seq }, entry);
}

/**
 * One session's live tail.
 *
 * Deliberately NOT exported: a window is only ever reached through {@link LiveWindows}, which owns
 * the key, the idle rule and the one-window-per-session guarantee. Two windows over one session would
 * be two numberings of the same turns.
 */
class LiveWindow {
  /** Oldest first. The only ordering in this class; `seq` is derived from it, never the reverse. */
  private rows: LiveRow[] = [];
  private readonly byUuid = new Map<string, LiveRow>();
  private gen = nextGen();
  private rev = 0;
  private nextSeq = SEQ_BASE;
  private weight = 0;
  private cursor: Cursor = NO_CURSOR;
  /**
   * One reducer per GENERATION, built when the first row of that generation arrives.
   *
   * Lazy rather than eager, so the count is exactly one: a window's first read always resets (a
   * source handed {@link NO_CURSOR} has nothing to resume from), so a reducer built in the
   * constructor would be thrown away before it ever saw a row.
   */
  private reducer: RowReducer | null = null;
  /** The read that filled this generation began at the source's own first row. */
  private fromStart = false;
  /** This generation has thrown a turn off its front. Once true it stays true. */
  private trimmed = false;
  /** Whether a read has ever run. The floor below has nothing to measure against until it has. */
  private ticked = false;
  private lastTickAt = 0;
  private lastSeen: { size: number; mtimeMs: number } | null = null;
  /** When a reader last asked. The idle rule's whole input. */
  askedAt: number;

  constructor(
    private readonly adapter: JournalAdapter,
    private readonly now: () => number,
  ) {
    this.askedAt = now();
  }

  /**
   * Read what is new, at most once per {@link TICK_FLOOR_MS}.
   *
   * `stat` first, and that is the whole reason a quiet session is free: a size and mtime that did not
   * move means there is nothing to ask the source for. The one case that must skip the pre-check is
   * the first tick, where there is no cursor yet and so nothing to compare against.
   */
  async tick(key: string): Promise<void> {
    const now = this.now();
    if (this.ticked && now - this.lastTickAt < TICK_FLOOR_MS) return;
    this.ticked = true;
    this.lastTickAt = now;
    const seen = await this.adapter.source.stat(key);
    if (
      seen !== null &&
      this.lastSeen !== null &&
      seen.size === this.lastSeen.size &&
      seen.mtimeMs === this.lastSeen.mtimeMs
    ) {
      return;
    }
    this.lastSeen = seen;
    const read = await this.adapter.source.readSince(key, this.cursor);
    this.cursor = read.cursor;
    if (read.reset) this.rebuild(read.fromStart);
    this.fold(read.lines);
    this.trim();
  }

  /**
   * Throw the generation away and start another.
   *
   * A new reducer, not the old one: a reducer remembers the tool calls it is still waiting on, and a
   * reset means the rows those calls were in are not this window's any more. Carrying it over would
   * fold a result into a turn nobody is holding.
   */
  private rebuild(fromStart: boolean): void {
    this.rows = [];
    this.byUuid.clear();
    this.weight = 0;
    this.nextSeq = SEQ_BASE;
    this.gen = nextGen();
    this.rev = 0;
    this.trimmed = false;
    this.fromStart = fromStart;
    this.reducer = null;
  }

  /**
   * Fold rows in, and stamp everything they touched with ONE revision.
   *
   * One per tick rather than one per row, because a revision is a moment a reader can be at, and a
   * reader is never between two rows of the same read. A tick that folded nothing leaves `rev` where
   * it was, which is what makes the next poll a 304.
   */
  private fold(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const reducer = (this.reducer ??= this.adapter.reducer());
    const rev = this.rev + 1;
    let moved = false;
    for (const line of lines) {
      const reduction = reducer.push(line);
      for (const entry of reduction.added) {
        const row: LiveRow = { seq: this.nextSeq++, rev, weight: weigh(entry), entry };
        this.rows.push(row);
        this.byUuid.set(entry.uuid, row);
        this.weight += row.weight;
        moved = true;
      }
      for (const uuid of reduction.changed) {
        const row = this.byUuid.get(uuid);
        // A uuid we do not hold: the turn was trimmed off the front while its tool call was still
        // waiting. The reducer mutated a part of a turn nobody is looking at any more, which costs
        // nothing and is not reportable.
        if (row === undefined) continue;
        const after = weigh(row.entry);
        this.weight += after - row.weight;
        row.weight = after;
        row.rev = rev;
        moved = true;
      }
    }
    if (moved) this.rev = rev;
  }

  /** Bring the window back under both bounds, oldest first, never below {@link MIN_LIVE_ENTRIES}. */
  private trim(): void {
    while (
      this.rows.length > MIN_LIVE_ENTRIES &&
      (this.rows.length > MAX_LIVE_ENTRIES || this.weight > MAX_LIVE_BYTES)
    ) {
      const gone = this.rows.shift();
      if (gone === undefined) return;
      this.weight -= gone.weight;
      this.byUuid.delete(gone.entry.uuid);
      this.trimmed = true;
    }
  }

  /**
   * The answer for one reader.
   *
   * A reader holding this generation gets what moved since its revision, and that answer is bounded
   * by the WINDOW rather than by `limit`. Capping it would drop turns between the ones sent and the
   * ones kept, and a reader has no way to ask for a gap in the middle — `?before=` walks backwards
   * from what it holds, which is the wrong end. The window is already bounded, so there is nothing
   * left for a second cap to protect.
   *
   * A reader holding nothing, or another generation, gets the newest `limit` turns instead. That is a
   * first paint, and a first paint is a screenful.
   */
  body(after: ChatAfter | null, limit: number): ChatWindowBody {
    const rows =
      after !== null && after.gen === this.gen
        ? this.rows.filter((row) => row.rev > after.rev)
        : this.rows.slice(-limit);
    return {
      page: "live",
      gen: this.gen,
      rev: this.rev,
      // `nextSeq - 1` rather than the last row's seq, so an empty window answers `head < oldest`
      // instead of claiming a position it does not hold.
      head: this.nextSeq - 1,
      oldest: this.rows[0]?.seq ?? this.nextSeq,
      hasOlder: this.trimmed || !this.fromStart,
      upserts: rows.map((row) => chatEntry(row.entry, row.seq)),
    };
  }

  /** This generation, for a `?before=` page that must land in the same numbering. */
  generation(): number {
    return this.gen;
  }
}

/**
 * Every live session this bridge is holding, one window each.
 *
 * Keyed by the RESOLVED key — the path a file harness's log sits at, or the database-plus-session key
 * the two SQLite harnesses use — never by pane id. Two panes fronting one session share the window,
 * which is the same reason `TranscriptStore` caches by path: the session is the thing, the pane is a
 * way of looking at it.
 */
export class LiveWindows {
  private readonly windows = new Map<string, LiveWindow>();

  constructor(
    private readonly store: TranscriptStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * What is new in this pane's session.
   *
   * Null for every reason a client may not distinguish, exactly as `TranscriptStore.page` answers:
   * the ref names nothing, the adapter refused its shape, or the path failed containment. Those stay
   * indistinguishable on purpose — a containment failure must not be probeable.
   */
  async window(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    params: ChatParams,
  ): Promise<ChatWindowBody | null> {
    const key = await adapter.source.resolve(ref);
    if (key === null) return null;
    const window = this.reach(key, adapter);
    await window.tick(key);
    return window.body(params.after ?? null, params.limit);
  }

  /**
   * The turns immediately before one the client holds, read off disk on demand.
   *
   * This is the History path (`store.ts`) with the numbering put back on: the store pages backwards
   * from a `uuid` exactly as the History route asks it to, and the page's turns are numbered DOWN
   * from the `seq` the client sent. So a "load older" tap costs one bounded read of the log and no
   * memory at all — nothing older is ever held live, which is what keeps a 186 MB session's window
   * the same size as a small one's.
   *
   * The answer carries `gen`, and a client whose generation has moved on must throw the page away:
   * the numbering it was computed against no longer exists.
   */
  async older(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    before: ChatBefore,
    limit: number,
  ): Promise<ChatOlderBody | null> {
    const key = await adapter.source.resolve(ref);
    if (key === null) return null;
    const window = this.reach(key, adapter);
    const page = await this.store.page(adapter, ref, { limit, before: before.uuid });
    if (page === null) return null;
    // Numbered from the END of the page backwards, so the newest turn in it sits immediately before
    // the one the client named. A short page (the log's own start) therefore begins higher, which is
    // right: the turns that do not exist take no positions.
    const first = before.seq - page.entries.length;
    return {
      page: "older",
      gen: window.generation(),
      upserts: page.entries.map((entry, i) => chatEntry(entry, first + i)),
      hasOlder: page.hasMore,
    };
  }

  /** How many sessions are held live. For tests and for the idle rule's own assertions. */
  size(): number {
    return this.windows.size;
  }

  /**
   * The window for this key, creating it if needed — and paying the idle rule on the way in.
   *
   * Eviction runs HERE rather than on a timer, for the reason there is no timer in this file: a
   * bridge nobody is watching must cost nothing, and a sweep that fires whether or not anybody asked
   * is a cost. The `Map` is insertion-ordered and every ask re-inserts, so "oldest asked" is simply
   * the first key.
   */
  private reach(key: string, adapter: JournalAdapter): LiveWindow {
    const now = this.now();
    for (const [held, window] of this.windows) {
      if (now - window.askedAt > WINDOW_IDLE_MS) this.windows.delete(held);
    }
    const found = this.windows.get(key);
    if (found !== undefined) {
      found.askedAt = now;
      this.windows.delete(key);
      this.windows.set(key, found);
      return found;
    }
    const made = new LiveWindow(adapter, this.now);
    this.windows.set(key, made);
    while (this.windows.size > MAX_WINDOWS) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
    return made;
  }
}

