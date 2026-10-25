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

import { createHash, randomBytes } from "node:crypto";

import type { Cursor } from "./cursor.ts";
import { NO_CURSOR } from "./cursor.ts";
import type { RowReducer } from "./reduce.ts";
import type { TranscriptStore } from "./store.ts";
import { receiptQueue, type QueuedSendWire, type ReceiptQueued } from "./receipt-queue.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry } from "./types.ts";
import { LIVE_TURNS, MAX_PAGE_ROWS, pageStart } from "./turns.ts";
import { redactText } from "../redact.ts";
import { clamp, redactEntry } from "./text.ts";

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

/**
 * The fewest rows in a first answer, when the client holds no cursor. A page reaches back over the
 * last {@link LIVE_TURNS} prompts, and never holds fewer rows than this.
 */
export const DEFAULT_CHAT_LIMIT = 40;

// A page is counted in turns, with `DEFAULT_CHAT_LIMIT` as its floor in rows (journal/turns.ts).
export { LIVE_TURNS, MAX_PAGE_ROWS };

/** Ceiling for `?limit=`. Past this a first paint is not a first paint, it is a History page. */
export const MAX_CHAT_LIMIT = 200;

/**
 * How much of the operator's newest prompt {@link ChatWindowBody.lastPrompt} carries.
 *
 * The phone shows two lines of it pinned above the thread. A pasted log can be a prompt of a hundred
 * kilobytes, and every answer carries this field whole, so the cap is what keeps one paste from
 * riding every poll.
 */
export const LAST_PROMPT_MAX_CHARS = 1000;

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
  /**
   * Which SESSION, as an opaque tag ({@link sessionTag}). It changes when the pane's agent starts
   * another session (pi's `/new`, a Claude log handed over), and a client holding another one drops
   * what it holds for the pane, older pages included (#526). `gen` alone cannot say this: it also
   * moves when one session's window rebuilds. Never the path itself: the browser is not handed
   * filesystem layout (`PaneWire` in bridge/types.ts).
   */
  session: string;
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
  /**
   * What the operator typed that the agent has not started on yet, oldest first.
   *
   * STATE, NOT TURNS, and that is the whole reason it is a field of its own beside `upserts` rather
   * than entries in it. A queued message appears and then is gone. `upserts` can only add or replace
   * a turn by `uuid` — there is no removal on the wire, on purpose — so a queue carried as turns could
   * only be un-drawn by bumping `gen`, which throws away the client's whole thread and its scroll
   * position to retract one line.
   *
   * WHOLE, EVERY ANSWER, never a delta. It is short (a bound of `QUEUE_MAX`, and 367 of 400 measured
   * sessions never had one at all), and a delta over a list with no identity would need a removal verb
   * this wire does not have. The 304 still works: the ETag is over these bytes, so a queue that
   * changed is a different body and a queue that did not is the same one.
   *
   * Claude Code and Muse record their queues in the log, and their reducers fill it. Every other
   * harness records none (`journal/reduce.ts` § `RowReducer.queued`). This list is the JOURNAL's only:
   * Collie's own queued sends ride in {@link queuedSends} and never here, because a phone one release
   * behind draws this list with a Send now button that cannot work for them (ADR 0122).
   */
  queued: string[];
  /**
   * The pane's queued sends as Collie's receipts know them (ADR 0122), oldest first: each card's request
   * id, where it stands (`queued` in the harness, `returned` to the input box by a Stop, `unconfirmed`
   * when Collie cannot tell), and its text, masked like {@link queued}. A run of texts a Stop gave back
   * together is one card. A card whose text {@link queued} lists is left out; a harness that records
   * its queue in the log gets only `returned` cards. STATE, whole on every answer, like {@link queued}.
   * ABSENT when there is none, and from a bridge one release behind.
   */
  queuedSends?: QueuedSendWire[];
  /**
   * The keys that deliver {@link queued} now, in the neutral spelling, when this session's harness
   * declares any (`JournalAdapter.sendQueuedNow`). ABSENT for every other harness, so their bodies are
   * byte-identical to before, and absent from a bridge one release behind, which the phone reads as
   * "no button". Static per harness: the same list on every answer, so it never moves the ETag.
   * The route then drops it where the pane's multiplexer cannot deliver those keys as themselves
   * (`chatBodyForMux` in server.ts): tmux and zellij send `ctrl+Enter` as a plain Enter.
   */
  sendQueuedNow?: string[];
  /**
   * The operator's newest prompt the window knows, so the phone can say which question the reply on
   * screen answers even when that question sits above the screenful a first paint sends. A long run
   * of tool calls fills `limit`, so the prompt that started it is routinely outside it.
   *
   * STATE, like {@link queued}, and WHOLE on every answer: it moves when a prompt lands, is rewound
   * away, or a lookup behind the front finishes; otherwise a poll serialises to the same bytes and
   * stays a 304. A field rather than a widened first
   * page because ADR 0073 sized a first paint at a screenful, and walking back to the prompt would make
   * every first paint a History page.
   *
   * Only `user` turns count. A `note` is a prompt the agent sent itself (a `/loop` wake-up, another
   * session's message), and drawing it as the operator's question is the thing #306 kept out of
   * History. ABSENT when the window holds no such turn, and from a bridge one release behind; the
   * phone reads both as "not known" and offers to load older turns instead.
   */
  lastPrompt?: ChatPrompt;
}

/** The operator's newest prompt, as {@link ChatWindowBody.lastPrompt} carries it. */
export interface ChatPrompt {
  /** The turn's own uuid, so a client can tell whether it already holds the full turn. */
  uuid: string;
  ts: string;
  /** Its text parts joined, capped at {@link LAST_PROMPT_MAX_CHARS}. */
  text: string;
  truncated?: boolean;
}

/**
 * This turn as a prompt, or null when it is not one the operator wrote.
 *
 * A turn the agent rewound past is not part of the conversation, and a `user` turn with no text is
 * not a prompt: Claude files a tool result under `user`, and a window that opens mid-run starts with
 * exactly such orphans. A picture alone has nothing to pin either.
 */
function promptOf(entry: TranscriptEntry): ChatPrompt | null {
  if (entry.role !== "user" || entry.abandoned === true) return null;
  const said = entry.parts
    .flatMap((part) => (part.kind === "text" && part.text.trim() !== "" ? [part.text.trim()] : []))
    .join("\n\n");
  if (said === "") return null;
  return { uuid: entry.uuid, ts: entry.ts, ...clamp(said, LAST_PROMPT_MAX_CHARS) };
}

/** The newest prompt among these turns, walking from the tail, so the common case ends in a few. */
function newestPrompt<T>(items: readonly T[], entryOf: (item: T) => TranscriptEntry): ChatPrompt | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const prompt = promptOf(entryOf(items[i]!));
    if (prompt !== null) return prompt;
  }
  return null;
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
  /** The session the page was read from, as {@link ChatWindowBody.session} names it. */
  session: string;
  /** Oldest first, the turns immediately before the one asked about. */
  upserts: ChatEntry[];
  /** Turns exist before `upserts[0]` too. */
  hasOlder: boolean;
}

/** Either answer. The route serves one body type, discriminated by {@link ChatWindowBody.page}. */
export type ChatBody = ChatWindowBody | ChatOlderBody;

/**
 * Either answer with every content string masked (`bridge/redact.ts`, through `redactEntry`): the
 * turns and, on a live window, the queued messages. Positions, ids and flags are untouched, so a
 * client merges a masked answer exactly as it merges any other.
 */
export function redactChatBody(body: ChatBody): ChatBody {
  const upserts = body.upserts.map(redactEntry);
  if (body.page === "older") return { ...body, upserts };
  const masked: ChatWindowBody = { ...body, upserts, queued: body.queued.map(redactText) };
  if (body.queuedSends !== undefined) masked.queuedSends = body.queuedSends.map((row) => ({ ...row, text: redactText(row.text) }));
  if (body.lastPrompt !== undefined) {
    masked.lastPrompt = { ...body.lastPrompt, text: redactText(body.lastPrompt.text) };
  }
  return masked;
}

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

/** Salt for {@link sessionTag}: fresh per process, so a tag is no stable hash of a path. */
const SESSION_SALT = randomBytes(16);

/**
 * The opaque name of one session as the wire carries it: a salted hash of the window's key.
 *
 * The key is a path for every file harness, and the browser is never handed a path. A hash keeps the
 * one thing the phone needs, "is this the session I hold", and nothing else. The salt changes with
 * the process, which costs nothing: a restart changes every `gen` anyway, so the phone replaces.
 */
export function sessionTag(key: string): string {
  return createHash("sha256").update(SESSION_SALT).update(key).digest("base64url").slice(0, 16);
}

/** One turn held live. Mutable, because a tool result edits the turn its call went out in. */
interface LiveRow {
  readonly seq: number;
  /** The tick this row was last added or changed at. What `?after=` selects on. */
  rev: number;
  /** Bytes of JSON, re-measured when the row changes — the bound's own arithmetic. */
  weight: number;
  /**
   * The turn. NOT readonly: a source may hand the same turn back whole rather than mutate it in
   * place, and then the row keeps its `seq` and takes the newer object (see {@link LiveWindow.fold}).
   */
  entry: TranscriptEntry;
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
  /**
   * The newest prompt behind the window's front, looked up once per generation when the window holds
   * none (see {@link LiveWindows.window}). `prompt` is null while the lookup runs and when it found
   * nothing. Older turns do not change, so one answer holds for the whole generation.
   */
  private behind: { gen: number; prompt: ChatPrompt | null } | null = null;
  /** Whether a read has ever run. The floor below has nothing to measure against until it has. */
  private ticked = false;
  private lastTickAt = 0;
  private lastSeen: { size: number; mtimeMs: number } | null = null;
  /** When a reader last asked. The idle rule's whole input. */
  askedAt: number;
  /**
   * The ref values readers reached this window by, so {@link LiveWindows.held} can find it from a
   * pane's ref without resolving a path. A pane names one or two (a pi path, then its id), so a handful.
   */
  readonly refs = new Set<string>();
  /** This window's session on the wire ({@link sessionTag}). Fixed: one window is one key. */
  readonly session: string;

  constructor(
    private readonly adapter: JournalAdapter,
    private readonly now: () => number,
    key: string,
  ) {
    this.askedAt = now();
    this.session = sessionTag(key);
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
    // No log at this key yet, and nothing read from it: a session the harness named before writing
    // its first row (pi after `/new`, #526, reached through `TranscriptSource.pending`). It is an
    // empty session from its start, so nothing is older. When the file appears, the cursor is still
    // the empty one, so that read resets into a generation of its own and the rows flow.
    if (seen === null && this.cursor === NO_CURSOR) {
      this.fromStart = true;
      return;
    }
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
    this.behind = null;
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
        // A uuid we ALREADY HOLD is a re-emit, not a new turn, and it must keep its place.
        //
        // Two sources do this by design. opencode mutates a row while a reply streams and its cursor
        // compares `>=`, so every read of a live reply hands the same `uuid` back; hermes re-composes
        // a turn rather than editing one. Taking either as new would put one turn at a second `seq`,
        // send both, and leave the client's merge-by-uuid MOVING a turn that never moved, against
        // this file's own rule that a `seq` is assigned once. It would also leak the old row's weight
        // until a trim caught it. So a re-emit is a change in place, exactly like a folded result.
        const held = this.byUuid.get(entry.uuid);
        if (held !== undefined) {
          held.entry = entry;
          const after = weigh(entry);
          this.weight += after - held.weight;
          held.weight = after;
          held.rev = rev;
          moved = true;
          continue;
        }
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
   * A reader holding nothing, or another generation, gets the last {@link LIVE_TURNS} prompts and
   * everything after each instead, held to `limit` rows at least and {@link MAX_PAGE_ROWS} at most
   * (`journal/turns.ts`). That is a first paint.
   */
  body(after: ChatAfter | null, limit: number, receipts: readonly ReceiptQueued[] = []): ChatWindowBody {
    const rows =
      after !== null && after.gen === this.gen
        ? this.rows.filter((row) => row.rev > after.rev)
        : this.rows.slice(pageStart(this.rows.length, limit, (i) => this.rows[i]!.entry));
    const body: ChatWindowBody = {
      page: "live",
      gen: this.gen,
      session: this.session,
      rev: this.rev,
      // `nextSeq - 1` rather than the last row's seq, so an empty window answers `head < oldest`
      // instead of claiming a position it does not hold.
      head: this.nextSeq - 1,
      oldest: this.rows[0]?.seq ?? this.nextSeq,
      hasOlder: this.trimmed || !this.fromStart,
      upserts: rows.map((row) => chatEntry(row.entry, row.seq)),
      // The reducer's own reading, not a stored copy: it is a snapshot method for that reason. A
      // generation with no reducer yet has read no rows, so it has met no queue either.
      queued: [...(this.reducer?.queued() ?? [])],
    };
    // Added only when declared, so every other harness's body is byte-identical to before.
    if (this.adapter.sendQueuedNow !== undefined) body.sendQueuedNow = [...this.adapter.sendQueuedNow];
    // Collie's own queued sends (ADR 0122), checked against every prompt the window holds, not the page.
    if (receipts.length > 0) {
      const cards = receiptQueue(receipts, this.rows.map((row) => row.entry), this.adapter.recordsQueue === true, body.queued);
      if (cards.length > 0) body.queuedSends = cards;
    }
    // Over every row the window holds, not the `limit` sent: the point is the prompt the first paint
    // left out. A window that opened mid-run holds none, and then the one looked up behind its front
    // stands in, until a prompt the window does hold replaces it.
    const prompt = newestPrompt(this.rows, (row) => row.entry) ?? this.behind?.prompt ?? null;
    if (prompt !== null) body.lastPrompt = prompt;
    return body;
  }

  /**
   * What the window holds, for a reader that is not a client poll ({@link LiveWindows.held}). `stamp`
   * moves whenever a held turn does, so a caller can keep what it derived until it moves.
   */
  heldNow(): HeldWindow {
    const held: HeldWindow = {
      stamp: `${this.gen}:${this.rev}`,
      askedAt: this.askedAt,
      entries: () => this.rows.map((row) => row.entry),
    };
    if (this.lastSeen !== null) held.writtenAt = this.lastSeen.mtimeMs;
    return held;
  }

  /** This generation, for a `?before=` page that must land in the same numbering. */
  generation(): number {
    return this.gen;
  }

  /**
   * Whether the newest prompt has to be looked up behind the window's front: the window holds none,
   * older turns exist, and this generation has not asked yet. Asking marks it, so a session costs
   * at most one lookup per generation however many readers poll it.
   */
  claimLookup(): number | null {
    if (this.behind?.gen === this.gen) return null;
    if (!(this.trimmed || !this.fromStart)) return null;
    if (newestPrompt(this.rows, (row) => row.entry) !== null) return null;
    this.behind = { gen: this.gen, prompt: null };
    return this.gen;
  }

  /** The lookup's answer, kept only if the generation it was asked for is still this one. */
  settleLookup(gen: number, prompt: ChatPrompt | null): void {
    if (gen === this.gen) this.behind = { gen, prompt };
  }
}

/** One live window as {@link LiveWindows.held} hands it out. Read only; the entries are the window's own. */
export interface HeldWindow {
  /** `<gen>:<rev>`. The same stamp means the same turns in the same state. */
  stamp: string;
  /** When a reader last polled this window. */
  askedAt: number;
  /** The log's mtime at the last read, when a read has run. */
  writtenAt?: number;
  /** The held turns, oldest first. Built on call, so a caller whose stamp did not move pays nothing. */
  entries: () => readonly TranscriptEntry[];
}

/** Most ref values one window remembers; past it the oldest go. */
const MAX_WINDOW_REFS = 4;

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
   *
   * One exception, and it is not "no log": a ref whose log the harness has not written YET, at a
   * place the adapter can confine now (`TranscriptSource.pending`, pi only). That window answers an
   * empty session from its start under the new session's tag, and the same window starts reading
   * when the file appears, because `resolve` then answers the same key (#526).
   *
   * `receipts` are the pane's open queued sends from Collie's own receipts (ADR 0122): the answer lists
   * those the journal does not show as a prompt yet. Per pane, not per window: two panes on one session
   * each see their own sends.
   */
  async window(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    params: ChatParams,
    receipts: readonly ReceiptQueued[] = [],
  ): Promise<ChatWindowBody | null> {
    const key = (await adapter.source.resolve(ref)) ?? (await adapter.source.pending?.(ref)) ?? null;
    if (key === null) return null;
    const window = this.reach(key, adapter);
    window.refs.delete(ref.value);
    window.refs.add(ref.value);
    for (const old of window.refs) {
      if (window.refs.size <= MAX_WINDOW_REFS) break;
      window.refs.delete(old);
    }
    await window.tick(key);
    // The window opened mid-run (its first read is a 2 MB tail, and a long tool run fills that with
    // no prompt in it): look the prompt up in the History read, once per generation and WITHOUT
    // holding this answer for it. The next poll carries what it found. That read is the one a
    // "load older" tap or the History page already makes, and it is paid only by a window that
    // holds no prompt at all, never by an ordinary poll.
    const gen = window.claimLookup();
    if (gen !== null) {
      void this.store.cached(adapter, ref).then(
        (found) => window.settleLookup(gen, found === null ? null : newestPrompt(found.entries, (e) => e)),
        () => window.settleLookup(gen, null),
      );
    }
    return window.body(params.after ?? null, params.limit, receipts);
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
    const page = await this.store.page(adapter, ref, { limit, before: before.uuid, turns: true });
    if (page === null) return null;
    // Numbered from the END of the page backwards, so the newest turn in it sits immediately before
    // the one the client named. A short page (the log's own start) therefore begins higher, which is
    // right: the turns that do not exist take no positions.
    const first = before.seq - page.entries.length;
    return {
      page: "older",
      gen: window.generation(),
      session: window.session,
      upserts: page.entries.map((entry, i) => chatEntry(entry, first + i)),
      hasOlder: page.hasMore,
    };
  }

  /**
   * The window a client poll reached by this ref value, from memory alone: no resolve, no read, and
   * no idle bookkeeping, so asking keeps nothing alive. Null when no poll has reached it, or the
   * window has gone. The belt's agents pill reads Oh My Pi's and Gentle Shell's ongoing task cards
   * from here (bridge/subagents-journal.ts).
   */
  held(refValue: string): HeldWindow | null {
    for (const window of this.windows.values()) {
      if (window.refs.has(refValue)) return window.heldNow();
    }
    return null;
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
    const made = new LiveWindow(adapter, this.now, key);
    this.windows.set(key, made);
    while (this.windows.size > MAX_WINDOWS) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
    return made;
  }
}

