// Hermes' local SessionDB journal adapter.
//
// Hermes stores sessions in one SQLite database per profile: `~/.hermes/state.db` for the default
// profile, and `~/.hermes/profiles/<name>/state.db` for each named one (`hermes_state.py`,
// `hermes_cli/profiles.py`; `hermes profile use <name>` makes a named profile the one a bare `hermes`
// runs). The pane supplies the session id through Herdr, so this adapter reads exactly that session;
// it never guesses from the newest row. It looks for the id in the root's own database, then in each
// profile's. The profile names are the bridge's own directory listing, never anything a client sent,
// and every database path is confined to the configured root, after symlinks, before it is opened.
// Each database is opened read-only.

import type { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import {
  parseWith,
  createUnknownCounter,
  type KnownTypes,
  NO_CHANGE,
  noQueue,
  type Reduction,
  type RowReducer,
} from "./reduce.ts";
import {
  type Cursor,
  decodeCursor,
  encodeCursor,
  NO_CURSOR,
  type ReadSince,
} from "./cursor.ts";
import {
  containedRealpath,
  FIRST_TAIL_BYTES,
  FIRST_TAIL_ROWS,
  MAX_TRANSCRIPT_BYTES,
  rootList,
} from "./files.ts";
import { readSqlite } from "./sqlite-read.ts";
import { clamp, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  DiscoverHints,
  ForegroundProcess,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

const DB_FILE = "state.db";
// Where named profiles live under a Hermes root (`hermes_cli/profiles.py`).
const PROFILES_DIR = "profiles";
const SESSION_ID_RE = /^(?:\d{8}_\d{6}_[A-Za-z0-9]+|local-[a-f0-9]{64})$/;

export function isHermesSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

export function hermesKey(dbPath: string, sessionId: string): string {
  return `${dbPath}#${sessionId}`;
}

export function splitHermesKey(key: string): { dbPath: string; sessionId: string } | null {
  const at = key.lastIndexOf("#");
  if (at <= 0) return null;
  const dbPath = key.slice(0, at);
  const sessionId = key.slice(at + 1);
  return isHermesSessionId(sessionId) ? { dbPath, sessionId } : null;
}

/**
 * Extract the CLI arguments passed to Hermes from a foreground process's argv, or null when the
 * process is not Hermes. Handles both a direct `hermes` argv[0] and the Python `-c` launcher
 * (`python3 -I -c "...from hermes_cli.main import main..." "$@"`) Hermes's wrapper script execs into.
 */
function hermesArgs(argv: readonly string[]): readonly string[] | null {
  if (argv.length === 0) return null;
  const base = (argv[0]!.split(/[/\\]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
  if (base === "hermes") return argv.slice(1);
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(base)) {
    const cAt = argv.indexOf("-c");
    if (cAt >= 1 && (argv[cAt + 1] ?? "").includes("from hermes_cli.main import main")) {
      return argv.slice(cAt + 2);
    }
  }
  return null;
}

/**
 * The session a pane's foreground argv names, or null when none does. Only an explicit
 * `--resume <id>` / `-r <id>` counts (`hermes chat --help`): a fresh `hermes chat` with no resume
 * falls through to the cwd walk below, where the just-started row is the newest and still wins.
 */
function sessionFromArgv(processes: readonly ForegroundProcess[] | undefined): string | null {
  if (processes === undefined) return null;
  for (const proc of processes) {
    const args = hermesArgs(proc.argv);
    if (args === null) continue;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if ((arg === "--resume" || arg === "-r") && i + 1 < args.length && isHermesSessionId(args[i + 1]!)) {
        return args[i + 1]!;
      }
      if (arg.startsWith("--resume=")) {
        const value = arg.slice("--resume=".length);
        if (isHermesSessionId(value)) return value;
      }
    }
  }
  return null;
}

interface MessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number;
  reasoning: string | null;
  reasoning_content: string | null;
  active: number;
  compacted: number;
  display_kind: string | null;
}

function parseJson(raw: string | null): JsonValue {
  if (raw === null) return null;
  try {
    // SAFETY: JSON.parse returns only JSON primitives, arrays, and objects; JsonValue names that exact boundary.
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
}

function textPart(raw: string | null): TranscriptPart | null {
  if (typeof raw !== "string") return null;
  const text = stripAnsi(raw);
  return text.trim() === "" ? null : { kind: "text", ...clamp(text, MAX_TEXT_CHARS) };
}

function toolCallPart(raw: JsonValue, fallbackName: string | null): TranscriptPart | null {
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw)) return null;
  for (const call of raw) {
    if (call === null || typeof call !== "object" || Array.isArray(call)) continue;
    const fn = call.function;
    if (fn === null || typeof fn !== "object" || Array.isArray(fn)) continue;
    const name = typeof fn.name === "string" ? fn.name : fallbackName ?? "tool";
    const args = typeof fn.arguments === "string" ? parseJson(fn.arguments) : fn.arguments;
    const summary = summarizeToolInput(args);
    const part: Extract<TranscriptPart, { kind: "tool" }> = {
      kind: "tool",
      name,
      summary,
      call: classifyToolCall(name, args, summary),
    };
    // The call's OWN id, not the message row's: the `tool` row answering this call repeats it in
    // `tool_call_id`, so this is the only field that pairs the two rows. `uuid` already carries the
    // row id. Assigned, never set to `undefined` — an absent id has to be absent.
    if (typeof call.id === "string" && call.id !== "") part.id = call.id;
    return part;
  }
  return null;
}

function isoTimestamp(value: number): string {
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

type ParsedMessageRow = JsonObject & MessageRow;

function isMessageRow(value: JsonValue): value is ParsedMessageRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  // SAFETY: JsonValue object branch is JsonObject by definition; fields are narrowed immediately below.
  const row = value as JsonObject;
  return typeof row.id === "number" && typeof row.role === "string" && typeof row.timestamp === "number";
}

function rowEntry(row: MessageRow): TranscriptEntry | null {
  if ((row.active === 0 && row.compacted === 0) || row.display_kind === "hidden") return null;

  const parts: TranscriptPart[] = [];
  const reasoning = textPart(row.reasoning ?? row.reasoning_content);
  if (reasoning !== null && reasoning.kind === "text") {
    const thinking: TranscriptPart = { kind: "thinking", text: reasoning.text };
    if (reasoning.truncated) thinking.truncated = true;
    parts.push(thinking);
  }
  const content = textPart(row.content);
  if (content !== null) parts.push(content);
  const toolCalls = toolCallPart(parseJson(row.tool_calls), row.tool_name);
  if (toolCalls !== null) parts.push(toolCalls);

  if (row.role === "tool") {
    const result = textPart(row.content);
    if (result === null) return null;
    const toolResult = result.kind === "text" && result.truncated
      ? { text: result.text, truncated: true }
      : { text: result.kind === "text" ? result.text : "" };
    // No `call` here, and no `enrichCall` anywhere in this adapter. A `tool` row in Hermes' SessionDB
    // holds `content`, `tool_call_id`, `tool_name`, `timestamp`, `active`, `compacted` and
    // `display_kind` and NOTHING about what the call did — no exit code, no patch, no success flag,
    // no status. The input that would name a path or a command sits on the assistant row's
    // `tool_calls`, which is where this adapter classifies (see `toolCallPart`); classifying again
    // from a name alone would emit an empty path or an empty command, which reads as a fact and is
    // not one. For the same reason a refusal cannot be told from an error: the store has no error
    // flag at all, so `isError` stays absent rather than guessed, and `denied` with it.
    const part: Extract<TranscriptPart, { kind: "tool" }> = {
      kind: "tool",
      name: row.tool_name ?? "tool",
      summary: "",
      result: toolResult,
    };
    // The id the assistant row's call carried, so a view can pair this result with it.
    if (typeof row.tool_call_id === "string" && row.tool_call_id !== "") part.id = row.tool_call_id;
    return {
      uuid: String(row.id),
      ts: isoTimestamp(row.timestamp),
      role: "note",
      parts: [part],
    };
  }
  if (row.role !== "user" && row.role !== "assistant") return null;
  if (parts.length === 0) return null;
  return { uuid: String(row.id), ts: isoTimestamp(row.timestamp), role: row.role, parts };
}

// ── The one query, in three pieces ───────────────────────────────────────────
//
// The whole-session read and the live read must select the SAME columns in the SAME order, because
// the composed line here is literally `JSON.stringify(row)` — a column list that drifted between the
// two would make a History read and a live read of one turn two different texts. So the query is
// assembled from pieces rather than written twice.

/** The session and every ancestor it was forked from, oldest ancestor at the greatest depth. */
const LINEAGE_CTE =
  "with recursive lineage(id, depth) as (select ? as id, 0 union all select s.parent_session_id, lineage.depth + 1 from sessions s join lineage on s.id = lineage.id where s.parent_session_id is not null and lineage.depth < 32)";

/** Exactly the columns `MessageRow` names, in its order. The composed line is this row, verbatim. */
const MESSAGE_COLUMNS =
  "m.id, m.role, m.content, m.tool_call_id, m.tool_calls, m.tool_name, m.timestamp, m.reasoning, m.reasoning_content, m.active, m.compacted, m.display_kind";

/**
 * The rows a read may see: this session's lineage, and only rows still live or kept by a compaction.
 *
 * THE PARENTHESES ARE LOAD-BEARING. `and` binds tighter than `or` in SQL, so a live read appending
 * `and m.id > ?` to an unbracketed `active = 1 or compacted = 1` would silently mean
 * `active = 1 or (compacted = 1 and id > ?)` — every active row in the session, on every read.
 */
const FROM_LINEAGE =
  "from messages m join lineage on lineage.id = m.session_id where (m.active = 1 or m.compacted = 1)";

function composeLines(db: Database, sessionId: string): string[] {
  const rows = db.query<MessageRow, [string]>(
    `${LINEAGE_CTE} select ${MESSAGE_COLUMNS} ${FROM_LINEAGE} order by lineage.depth desc, m.id`,
  ).all(sessionId);
  return rows.map((row: MessageRow) => JSON.stringify(row));
}

// ── The live read ────────────────────────────────────────────────────────────
//
// WHAT THE CURSOR COUNTS HERE. `messages.id` is an INTEGER PRIMARY KEY, so a row's id is unique and
// never reused, and `max(id)` is the whole cursor. The comparison is `>`, unlike opencode's `>=`: two
// hermes rows cannot share an id, so there is no same-value row to lose.
//
// WHAT THIS CURSOR CANNOT SEE, stated rather than papered over. A hermes row is NOT frozen once
// written: `active`, `compacted` and `display_kind` are mutable per-row state, and both the query
// above and `rowEntry` read them. So a turn can change, or stop being composed at all, WITHOUT its id
// moving — and an id cursor is blind to both. `Reduction` has no `removed` and should not grow one: a
// reader going forward cannot know a row vanished. That is the live window's business, and its verb
// for it is a reset. This method's duty is to be honest about the hole, not to invent a fix for it
// one layer too low.
//
// ORDER, AND ITS ONE KNOWN LIMIT. A live read orders by `m.id` alone, where the whole-session read
// orders by `lineage.depth desc, m.id`. Inside a window bounded by id the two agree, because an
// ancestor's rows were all written before the child session existed and therefore carry lower ids.
// The exception is an ancestor that gains a row AFTER the fork: its low id is already behind the
// cursor, so a live read never sees it. It arrives on the next reset. A fork whose parent is still
// being written to is not a session shape hermes produces today.

/** The newest id among some rows, or `fallback` when there were none. */
function newestId(rows: readonly MessageRow[], fallback: number): number {
  let newest = fallback;
  for (const row of rows) if (row.id > newest) newest = row.id;
  return newest;
}

function clipLines(lines: string[]) {
  const start = clipStart(lines, MAX_TRANSCRIPT_BYTES);
  return { text: lines.slice(start).join("\n"), complete: start === 0 };
}

/**
 * Index of the oldest line that still fits under `bytes`, counting from the newest back.
 *
 * Split out of {@link clipLines} for the live read, which keeps the same "keep the tail" policy at
 * its own smaller bound and needs the LINES rather than one joined text.
 */
function clipStart(lines: readonly string[], bytes: number): number {
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    total += Buffer.byteLength(lines[i]!) + 1;
    if (total > bytes) return i + 1;
  }
  return 0;
}

export function parseHermesTranscript(text: string): TranscriptEntry[] {
  return parseWith(createHermesReducer(), text);
}

/**
 * Every role this adapter has MET, rendered or dropped (`reduce.ts` § "what a reducer reports about
 * what it could not read"). Anything else is counted and named.
 *
 * `role` IS the whole of it: a `messages` row has no `type` column, so there is no second row-kind
 * field to read, and `parts` is EMPTY BY FORMAT rather than by omission. Content is one column,
 * reasoning is another, and a tool call is a JSON array of `{id, function:{name, arguments}}` with no
 * type on it anywhere — there is no content discriminator Hermes could add a value to. So this
 * reducer's part tally is always empty, and that is the format speaking.
 *
 * Not swept: no Hermes SessionDB exists on the canary host. The three roles are the ones `rowEntry`
 * reads and the ones the test corpus carries, and this list is what the first real Hermes will be
 * measured against.
 */
const HERMES_KNOWN: KnownTypes = { rows: [], roles: ["user", "assistant", "tool"], parts: [] };

/**
 * The same reading, one row at a time (see `reduce.ts`).
 *
 * STATELESS BY FORMAT, so `changed` is always empty and there is no map to carry. One `messages` row
 * is one turn: `rowEntry` reads that row and nothing else, and Hermes writes a tool RESULT as its own
 * row, which this adapter renders as its own `note` entry rather than folding onto the assistant turn
 * that made the call (`rowEntry`, the `role === "tool"` branch). The two are paired by the id the
 * result repeats in `tool_call_id`, carried on the part for a VIEW to match up; the adapter never
 * reaches back. So no row can alter a turn `push` already handed over, and it can never need to
 * report a `changed` uuid. Claude and pi both need one; this format gives them nothing to attach to.
 *
 * WHAT MOVES INSTEAD — the fact a live window has to be designed against. Within ONE composition each
 * id appears exactly once: `messages.id` is an INTEGER PRIMARY KEY, so even the lineage walk in
 * `composeLines`, which pulls a parent session's rows in as well, brings rows with ids of their own.
 * But a row is not frozen once written. `active`, `compacted` and `display_kind` are mutable per-row
 * state, and both the query (`active = 1 or compacted = 1`) and `rowEntry` read them — so the NEXT
 * composition of the same session may carry the same id again, may carry it rendering differently, or
 * may not carry it at all. A reducer fed those successive compositions emits such a line twice, BOTH
 * TIMES AS `added`, because it keeps no memory of what it has seen. A caller holding the first copy
 * must replace by `uuid` rather than append, and a turn a later read stops producing is something the
 * `Reduction` shape has no word for at all. Solving either is the cursor's and the live window's job,
 * not this module's; the job here is to state it truthfully so the design above it is built on the
 * truth.
 */
export function createHermesReducer(): RowReducer {
  // The one piece of state this reducer keeps: what it met and had no branch for.
  const unknown = createUnknownCounter(HERMES_KNOWN);

  // A nested `function` rather than a method on the returned object: the body below is the old loop
  // body at the indentation it always had, so this refactor is readable as the move it is.
  function push(line: string): Reduction {
    const entries: TranscriptEntry[] = [];
    if (line.trim() === "") return NO_CHANGE;
    let raw: JsonValue;
    try {
      // SAFETY: JSON.parse returns only JSON primitives, arrays, and objects; JsonValue names that exact boundary.
      raw = JSON.parse(line) as JsonValue;
    } catch {
      return NO_CHANGE; // a torn row, or the head line a byte cap clipped mid-object
    }
    if (!isMessageRow(raw)) return NO_CHANGE;
    // At the READ, not in the branch that declined (`reduce.ts` § `createUnknownCounter`): `rowEntry`
    // turns an unmodelled role into `null`, which is indistinguishable from a hidden row.
    unknown.role(raw.role);
    const entry = rowEntry(raw);
    // `rowEntry` declines a row that renders nothing — inactive, hidden, an unmodelled role, a `tool`
    // row with no output. With nothing folded anywhere either, such a row did nothing at all.
    if (entry === null) return NO_CHANGE;
    entries.push(entry);
    // Built directly rather than through `reduction()`: with `changed` always empty, both of that
    // helper's rules — drop `""`, drop a uuid `added` already carries — have nothing to do, and
    // `NO_CHANGE.changed` is the same frozen empty list every skip above hands back.
    return { added: entries, changed: NO_CHANGE.changed };
  }

  // No queue in this format's log: see `RowReducer.queued`.
  return { push, unknowns: unknown.tally, queued: noQueue };
}

type SessionMeta = { size: number; mtimeMs: number };

function sessionMeta(db: Database, sessionId: string): SessionMeta {
  const row = db.query<{ count: number; newest: number }, [string]>(
    "select count(*) as count, coalesce(max(timestamp), 0) as newest from messages where session_id = ?",
  ).get(sessionId);
  return { size: row?.count ?? 0, mtimeMs: row?.newest ?? 0 };
}

/**
 * The databases a Hermes root may hold a session in: its own `state.db`, then each named profile's,
 * in name order. Paths only; the caller confines each to the root before opening it. A root with no
 * `profiles` folder (or one this process cannot read) is just its own database.
 */
async function sessionDbs(root: string): Promise<string[]> {
  const dbs = [join(root, DB_FILE)];
  let names: string[];
  try {
    names = await readdir(join(root, PROFILES_DIR));
  } catch {
    return dbs;
  }
  for (const name of names.toSorted()) {
    if (name.startsWith(".")) continue;
    dbs.push(join(root, PROFILES_DIR, name, DB_FILE));
  }
  return dbs;
}

export class HermesTranscriptSource implements TranscriptSource {
  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isHermesSessionId(ref.value)) return null;
    for (const root of this.roots) {
      for (const candidate of await sessionDbs(root)) {
        const path = await containedRealpath(candidate, root);
        if (path === null) continue;
        const found = readSqlite(path, (db) =>
          db.query<{ id: string }, [string]>("select id from sessions where id = ?").get(ref.value),
        );
        if (found !== null && found !== undefined) return hermesKey(path, ref.value);
      }
    }
    return null;
  }

  /**
   * Find the session running in `cwd` without a reported ref.
   *
   * First checks the pane's foreground argv for an explicit `--resume <id>` / `-r <id>`; when
   * another Hermes pane shares the folder (`hints.shared`), returns null rather than guessing a
   * neighbour's session (#508); otherwise picks the newest `sessions` row across every `state.db`
   * this root holds (including profiles) whose `cwd` column equals the pane's folder.
   */
  async discoverSession(cwd: string, hints?: DiscoverHints): Promise<AgentSessionRef | null> {
    const named = sessionFromArgv(hints?.processes);
    if (named !== null) return { kind: "id", value: named };
    if (hints?.shared === true) return null;
    if (cwd.trim() === "") return null;
    let best: { id: string; startedAt: number } | null = null;
    for (const root of this.roots) {
      for (const candidate of await sessionDbs(root)) {
        const path = await containedRealpath(candidate, root);
        if (path === null) continue;
        const hit = readSqlite(path, (db) =>
          db
            .query<{ id: string; started_at: number }, [string]>(
              "select id, started_at from sessions where cwd = ? order by started_at desc limit 1",
            )
            .get(cwd),
        );
        if (hit === null || hit === undefined || !isHermesSessionId(hit.id)) continue;
        if (best === null || hit.started_at > best.startedAt) best = { id: hit.id, startedAt: hit.started_at };
      }
    }
    return best === null ? null : { kind: "id", value: best.id };
  }

  async stat(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    const parts = splitHermesKey(key);
    if (parts === null) return null;
    return readSqlite(parts.dbPath, (db) => sessionMeta(db, parts.sessionId));
  }

  async load(key: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
    const empty = { text: "", complete: true, size: 0, mtimeMs: 0 };
    const parts = splitHermesKey(key);
    if (parts === null) return empty;
    return readSqlite(parts.dbPath, (db) => {
      const meta = sessionMeta(db, parts.sessionId);
      const clipped = clipLines(composeLines(db, parts.sessionId));
      return { ...clipped, ...meta };
    }) ?? empty;
  }

  /**
   * What is new in this session since `cursor` (see "the live read" above for what it counts, and
   * for the mutable row state it cannot).
   *
   * A read that cannot be resumed answers with the newest {@link FIRST_TAIL_ROWS} turns, clipped to
   * {@link FIRST_TAIL_BYTES}, and `reset: true`. An unreadable database holds the caller's cursor and
   * reports nothing new, exactly as a file whose `stat` lost a race does.
   */
  async readSince(key: string, cursor: Cursor): Promise<ReadSince> {
    const held: ReadSince = { lines: [], cursor, reset: false, fromStart: false };
    const parts = splitHermesKey(key);
    if (parts === null) return { lines: [], cursor: NO_CURSOR, reset: false, fromStart: false };
    const at = decodeCursor(cursor, "rowid", key);
    return (
      readSqlite(parts.dbPath, (db) => {
        const rows =
          at === null
            ? db
                .query<MessageRow, [string, number]>(
                  `${LINEAGE_CTE} select ${MESSAGE_COLUMNS} ${FROM_LINEAGE} order by m.id desc limit ?`,
                )
                .all(parts.sessionId, FIRST_TAIL_ROWS)
                .toReversed()
            : db
                .query<MessageRow, [string, number, number]>(
                  `${LINEAGE_CTE} select ${MESSAGE_COLUMNS} ${FROM_LINEAGE} and m.id > ? order by m.id limit ?`,
                )
                .all(parts.sessionId, at, FIRST_TAIL_ROWS);
        const lines = rows.map((row: MessageRow) => JSON.stringify(row));
        const next = encodeCursor("rowid", key, newestId(rows, at ?? 0));
        // The clip only ever applies to a reset. Clipping an INCREMENTAL read would drop rows off the
        // head of the delta while the cursor moved past them, which loses a turn for good; the
        // incremental read is bounded by its `limit` instead, and the rest arrives on the next tick.
        if (at !== null) return { lines, cursor: next, reset: false, fromStart: false };
        const start = clipStart(lines, FIRST_TAIL_BYTES);
        // BOTH bounds have to have stood down for this to be the lineage's start: the row limit did
        // not bite, and the byte clip dropped nothing. Either one biting means an older turn exists.
        // Rows rather than lines is safe here, because hermes composes one line per row.
        return {
          lines: lines.slice(start),
          cursor: next,
          reset: true,
          fromStart: start === 0 && rows.length < FIRST_TAIL_ROWS,
        };
      }) ?? held
    );
  }
}

export function hermesJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new HermesTranscriptSource(roots);
  return {
    agent: "hermes",
    source,
    parse: parseHermesTranscript,
    reducer: createHermesReducer,
    discover: (cwd: string, hints?: DiscoverHints) => source.discoverSession(cwd, hints),
    sharedFolderBlind: true,
  };
}