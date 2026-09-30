// OpenCode's journal adapter.
//
// SHAPE OF THE SOURCE — and it is the odd one out: OpenCode keeps NO per-session log file. Everything
// lives in ONE SQLite database,
//   <dataDir>/opencode.db     (WAL mode; the `-shm`/`-wal` siblings sit beside it)
// where dataDir is `$XDG_DATA_HOME/opencode`, defaulting to `~/.local/share/opencode`. TWO storage
// generations sit in that one file, and neither migrates the other away:
//
//   V1 (live-verified against opencode 1.18.9 + herdr 0.7.5, 2026-08-03):
//     session(id TEXT PK, project_id, workspace_id, parent_id, slug, directory, title, …,
//             time_created INT ms, time_updated INT ms)   — a non-null `parent_id` marks a SUBAGENT
//                                                           (task-tool) session
//     message(id TEXT PK, session_id, time_created INT ms, time_updated INT ms, data TEXT json)
//     part(id TEXT PK, message_id, session_id, time_created, time_updated, data TEXT json)
//
//   V2 (live-verified against opencode 2.0.12, 2026-09-22):
//     session_v2(id TEXT PK, parent_id, title, …, time_created INT ms, time_updated INT ms)
//     session_message(id TEXT PK, session_id, type, seq INT, time_created INT ms,
//                     time_updated INT ms, data TEXT json)
//       — `type` is the role (`user`, `assistant`) or a session event (`compaction`, `synthetic`,
//         `system`, `idle`, `agent-switched`, `model-switched`, `location-switched`), and each
//         turn's parts are INLINE in `data.content` instead of joined from a `part` table.
//
// A machine that upgraded keeps its V1 sessions in `session` while every new one lands in
// `session_v2`. A session can exist in BOTH — the migration copied it, and it may have kept running
// in V1 afterwards — so the adapter compares the two stores' newest rows and serves the newer one
// (see `sessionStore`), rather than trusting a fixed order.
//
// SECURITY — THE SAME DATABASE HOLDS OAUTH TOKENS. `account`, `credential` and `control_account` are
// tables in this very file. So: this module queries `session`, `message`, `part`, `session_v2` and
// `session_message`, plus the table names in `sqlite_master`, and NOTHING else; every query is
// opened READONLY and uses BOUND PARAMETERS (never string interpolation); the session id is
// regex-validated before it can touch a query at all; and the database path is fixed
// (`<root>/opencode.db`, never derived from the ref) and still passed through `containedRealpath`,
// because the containment rule in CLAUDE.md is absolute even for a constant path.
//
// Message `data` json, verified samples:
//   V1 user      {"role":"user","time":{"created":1785311866628},"agent":"build","model":{…},
//                 "summary":{"diffs":[]}}
//   V1 assistant {"parentID":"msg_…","role":"assistant","mode":"build","agent":"build",
//                 "variant":"medium","path":{…},"cost":…,"time":{"created":…}}
//   V2 user      {"time":{"created":…},"text":"…","files":[],"agents":[]}
//                 — no `role`: the row's `type` column carries it, and the text is one field.
//   V2 assistant {"time":{"created":…,"streamed":…,"completed":…},"agent":"build",
//                 "model":{"id":…,"providerID":…,"variant":…},"content":[…]}
//                 — `content` items are `text{text}`, `reasoning{text}` and
//                   `tool{name, state{status, input, content[]}}`, so a tool's result is a content
//                   array here where V1 wrote `state.output`.
//   V2 compaction {"time":{"created":…},"status":"completed","reason":"manual","model":{…},
//                 "summary":"## Objective\n…"}   — the summary is a STRING, not V1's boolean flag.
//
// Part `data` json `type` values, verified: `text`, `reasoning`, `tool`, `step-start`, `step-finish`.
//
// WHERE HERDR'S ID COMES FROM: `herdr integration install opencode` installs a plugin that calls
// `pane.report_agent_session {agent_session_id}`, so the pane record carries
// `agent_session: {source:"herdr:opencode", agent:"opencode", kind:"id",
// value:"ses_03969c19cffeJrZCPOT6zG8Bm7"}` — a kind-`id` ref of `ses_` + base62, unchanged by V2.
// Without the integration installed there is no ref at all and the history route already answers
// "no-session".
//
// NO SIDECHAIN FILTERING IS NEEDED, unlike Claude's adapter. A subagent turn is not interleaved into
// its parent's rows: it lives in its OWN session row (the one carrying `parent_id`) in either
// generation, with its own messages, and the herdr plugin already refuses to report a
// parentID-carrying session. The ref is therefore always a root session. V2's `synthetic` rows — a
// subagent's report, a tool echo — sit in the ROOT session and are queried, then skipped by `type`
// in `v2Role`, exactly as V1's `step-start`/`step-finish` parts are: neither is speech.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { ResetEvent } from "../cache/claims.ts";
import type { CacheProbe } from "../cache/engine.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { NO_CHANGE, parseWith, type Reduction, type RowReducer } from "./reduce.ts";
import { asRecord, asText, tokenCount } from "./cache-probe.ts";
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
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import { parseUnifiedDiff } from "./diff.ts";
import { classifyToolCall, type Hunk, type ToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** The one file in the data dir we ever open. Constant — never built from anything a ref carries. */
const DB_FILE = "opencode.db";

/** `ses_` + base62, as reported by the herdr plugin. Validated BEFORE the id reaches any query. */
const SESSION_ID_RE = /^ses_[A-Za-z0-9]{8,64}$/;

export function isOpencodeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/**
 * The adapter's own key format: `<realDbPath>#<sessionId>`.
 *
 * WHY A VIRTUAL KEY. Every other harness has one file per session, so `resolve()` returning a path is
 * both "where to read" and "what to cache under". OpenCode has one file for ALL sessions, so a bare
 * path would collapse every session in the herd onto a single TranscriptStore cache entry. The store
 * treats what `resolve()` returns as an OPAQUE string it only ever hands back to `stat`/`load` (see
 * types.ts — `TranscriptSource` is a seam, not a filesystem API), so the adapter is free to define
 * that string. Splitting it back apart is adapter-internal by design and lives right here.
 */
export function opencodeKey(dbPath: string, sessionId: string): string {
  return `${dbPath}#${sessionId}`;
}

/**
 * Split a key back into its halves. `lastIndexOf` because a directory may legitimately contain `#`
 * while a validated session id never can.
 */
export function splitOpencodeKey(key: string): { dbPath: string; sessionId: string } | null {
  const at = key.lastIndexOf("#");
  if (at <= 0) return null;
  const dbPath = key.slice(0, at);
  const sessionId = key.slice(at + 1);
  return isOpencodeSessionId(sessionId) ? { dbPath, sessionId } : null;
}

/** Open the database read-only and run `fn`, closing it either way. Null on any sqlite error. */
function withDb<T>(dbPath: string, fn: (db: Database) => T): T | null {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null; // missing / unreadable / not a database
  }
  try {
    return fn(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Which of OpenCode's two stores holds a session: V1's `session`/`message`/`part`, or V2's. */
type OpencodeStore = "v1" | "v2";

/** The table names in this database — the V2 tables are absent on a pre-2.0 install. */
function tableNames(db: Database): ReadonlySet<string> {
  const rows = db.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all();
  return new Set(rows.map((row) => row.name));
}

/**
 * Which store holds this session, or null when neither does.
 *
 * Both generations live in the same database and neither migrates the other away, so a session can
 * exist in BOTH: the migration copied V1 sessions into `session_v2`, and a session that kept running
 * in V1 afterwards has newer rows there (measured live: 1 of 30 overlapping ids). The newer content
 * wins — a fixed V2-first order would serve the migration's snapshot and hide that tail — and a tie
 * reads as V2, the generation every current OpenCode writes.
 */
function sessionStore(db: Database, sessionId: string): OpencodeStore | null {
  const tables = tableNames(db);
  const inV2 =
    tables.has("session_v2") &&
    db.query<{ id: string }, [string]>("select id from session_v2 where id = ?").get(sessionId) !== null;
  const inV1 =
    tables.has("session") &&
    db.query<{ id: string }, [string]>("select id from session where id = ?").get(sessionId) !== null;
  if (inV2 && inV1) return newerStore(db, sessionId, tables);
  if (inV2) return "v2";
  if (inV1) return "v1";
  return null;
}

/** The store whose newest row is newer, for a session both tables hold. A tie reads as V2. */
function newerStore(db: Database, sessionId: string, tables: ReadonlySet<string>): OpencodeStore {
  const v1 = tables.has("message") && tables.has("part") ? sessionMetaV1(db, sessionId).mtimeMs : 0;
  const v2 = tables.has("session_message") ? sessionMetaV2(db, sessionId).mtimeMs : 0;
  return v2 >= v1 ? "v2" : "v1";
}

interface CountRow {
  c: number;
  m: number;
}

/** What a session's row counts stand in for, in place of a file's size + mtime. */
type SessionMeta = { size: number; mtimeMs: number };

/**
 * Row COUNT stands in for "size" and the newest `time_updated` for mtime, per store. Streaming
 * bumps the touched row continuously in both generations (`part.time_updated` in V1,
 * `session_message.time_updated` in V2 — verified 2026-09-22: +497 ms over five streaming seconds),
 * so a live session invalidates on every poll while a finished one stays cached — exactly the
 * behaviour a file's mtime gives the other adapters. Count is not a byte-exact size, but combined
 * with the timestamp a false cache hit would need an add and a delete inside the SAME millisecond,
 * which sqlite's ms-resolution stamps make effectively impossible.
 */
function sessionMeta(db: Database, sessionId: string, store: OpencodeStore): SessionMeta {
  return store === "v2" ? sessionMetaV2(db, sessionId) : sessionMetaV1(db, sessionId);
}

/** Row counts + newest touch across `message` and `part` for one V1 session. */
function sessionMetaV1(db: Database, sessionId: string): SessionMeta {
  const msg = db
    .query<CountRow, [string]>(
      "select count(*) c, coalesce(max(time_updated),0) m from message where session_id = ?",
    )
    .get(sessionId);
  const part = db
    .query<CountRow, [string]>(
      "select count(*) c, coalesce(max(time_updated),0) m from part where session_id = ?",
    )
    .get(sessionId);
  return {
    size: (msg?.c ?? 0) + (part?.c ?? 0),
    mtimeMs: Math.max(msg?.m ?? 0, part?.m ?? 0),
  };
}

/** Row counts + newest touch across `session_message` for one V2 session. */
function sessionMetaV2(db: Database, sessionId: string): SessionMeta {
  const row = db
    .query<CountRow, [string]>(
      "select count(*) c, coalesce(max(time_updated),0) m from session_message where session_id = ?",
    )
    .get(sessionId);
  return { size: row?.c ?? 0, mtimeMs: row?.m ?? 0 };
}

/** Parse a `data` column, or null when it isn't json. The row still renders what it can. */
function parseData(raw: string | null): JsonValue {
  if (typeof raw !== "string") return null;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction — string/number/boolean/null or an
    // array/object of those. It is re-serialised into the composed line right after this.
    return JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
}

interface MessageRow {
  id: string;
  time_created: number;
  /**
   * The clock the live cursor counts. Selected by every query here and composed into no line: this
   * column is how a read says "since", and it is not something `parse()` has any business seeing.
   * Nullable in the schema, so every comparison goes through `coalesce`.
   */
  time_updated: number | null;
  data: string | null;
}

interface PartRow {
  id: string;
  message_id: string;
  /** A part's own clock, which is the one that moves while a reply streams. See {@link MessageRow}. */
  time_updated: number | null;
  data: string | null;
}

/** A V2 row: the role/event `type` column, plus the inline-parts `data` json. */
interface MessageRowV2 extends MessageRow {
  type: string;
}

/** One composed JSONL line — the text `parse()` reads, once it has parsed to an object at all. */
type OpencodeLine = JsonObject;

/**
 * Compose the session's rows into JSONL — one line per message, its parts nested.
 *
 * The line format is this adapter's own (there is no file on disk to mirror), chosen so `parse()` can
 * stay PURE and table-testable exactly like every other harness's: the source produces text, the
 * parser reads text, and no test needs a database to pin the grammar. Both stores normalise into the
 * same line, so `parse()` never learns which generation wrote the row.
 */
function composeLines(db: Database, sessionId: string, store: OpencodeStore): string[] {
  return store === "v2" ? composeLinesV2(db, sessionId) : composeLinesV1(db, sessionId);
}

/**
 * The columns every read of this store selects, whole-session or live.
 *
 * ONE list rather than one per query, because the composed line must not depend on which read
 * produced it: a live read and a History read of the same turn have to be the same text, or the two
 * paths disagree about a conversation for no reason a reader could ever find.
 */
const V1_MESSAGE_COLUMNS = "id, time_created, time_updated, data";
const V1_PART_COLUMNS = "id, message_id, time_updated, data";

/** V1's rows as composed lines: one per message, its parts nested. */
function linesV1(messages: readonly MessageRow[], parts: readonly PartRow[]): string[] {
  const byMessage = new Map<string, PartRow[]>();
  for (const p of parts) {
    const list = byMessage.get(p.message_id);
    if (list === undefined) byMessage.set(p.message_id, [p]);
    else list.push(p);
  }

  return messages.map((m) =>
    JSON.stringify({
      id: m.id,
      ts: m.time_created,
      data: parseData(m.data),
      parts: (byMessage.get(m.id) ?? []).map((p) => ({ id: p.id, data: parseData(p.data) })),
    }),
  );
}

/** V1: one `message` row per turn, its `part` rows joined by message id. */
function composeLinesV1(db: Database, sessionId: string): string[] {
  const messages = db
    .query<MessageRow, [string]>(
      `select ${V1_MESSAGE_COLUMNS} from message where session_id = ? order by time_created, id`,
    )
    .all(sessionId);
  // Ids are time-ordered (verified lexicographically monotone), so ordering by id keeps a message's
  // parts in the order the agent emitted them without trusting a nullable timestamp.
  const parts = db
    .query<PartRow, [string]>(
      `select ${V1_PART_COLUMNS} from part where session_id = ? order by id`,
    )
    .all(sessionId);

  return linesV1(messages, parts);
}

/** The role a V2 row's `type` column stands for, or null for a row that is plumbing, not speech. */
function v2Role(type: string): "user" | "assistant" | "summary" | null {
  if (type === "user" || type === "assistant") return type;
  // A compaction writes the summary that replaces the history, and the transcript vocabulary has a
  // role for exactly that. Every other type (`system`, `synthetic`, `idle`, `agent-switched`,
  // `model-switched`) is plumbing — rendering it as speech would put words in the operator's mouth.
  return type === "compaction" ? "summary" : null;
}

/** A V2 row's inline parts: `content` when the row carries any, else the row's one text field. */
function v2Parts(record: JsonObject): JsonValue[] {
  // An EMPTY `content` array is a failed turn, not an empty message: it must fall through to the
  // error sentence below rather than end the row here.
  if (Array.isArray(record.content) && record.content.length > 0) return record.content;
  // User turns keep their text in `text`; a compaction keeps its summary in `summary`; a FAILED turn
  // carries neither and keeps its reason in `error.message`, which is the one sentence worth showing
  // rather than silently skipping the turn. V1's user `summary` was an OBJECT, so the string checks
  // are what tell the spellings apart.
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.summary === "string"
        ? record.summary
        : v2ErrorText(record);
  return text === "" ? [] : [{ type: "text", text }];
}

/** A failed V2 turn's reason, or "" — `{type, message}` under `error` (verified on 2.0.12). */
function v2ErrorText(record: JsonObject): string {
  const error = asRecord(record.error);
  return error !== null && typeof error.message === "string" ? error.message : "";
}

/** See {@link V1_MESSAGE_COLUMNS} for why there is one list and not one per query. */
const V2_COLUMNS = "id, type, time_created, time_updated, data";

/**
 * V2: one `session_message` row per turn, its parts inline.
 *
 * The role lives in the row's `type` column (V2's json carries none) and the parts are already a
 * `content` array, so the composed line is normalised here — `data.role` from `type`, parts as
 * `{id, data}` — and `parse()` keeps reading one grammar for both generations. Only the fields the
 * parser reads travel on: copying `content` into `data` as well would double every line's bytes
 * against the transcript cap.
 */
function composeLinesV2(db: Database, sessionId: string): string[] {
  const rows = db
    .query<MessageRowV2, [string]>(
      // `seq` is V2's per-session order (unique index `session_message_session_seq_idx`), so it
      // orders the turns; unlike `time_created` two rows can never share it.
      `select ${V2_COLUMNS} from session_message where session_id = ? order by seq`,
    )
    .all(sessionId);
  return rows.map(lineV2).filter((line): line is string => line !== null);
}


/** One V2 row as a composed line, or null for a row that is plumbing rather than speech. */
function lineV2(row: MessageRowV2): string | null {
  const role = v2Role(row.type);
  if (role === null) return null;
  const record = asRecord(parseData(row.data)) ?? {};
  return JSON.stringify({
    id: row.id,
    ts: row.time_created,
    data: { role, time: record.time },
    parts: v2Parts(record).map((part, index) => ({ id: `prt_${row.id}_${index}`, data: part })),
  });
}

/**
 * Keep the NEWEST lines that fit under the byte cap — the same "keep the tail" policy `loadTail`
 * applies to a file, applied to composed text instead.
 */
type ClippedText = { text: string; complete: boolean };

function clipToCap(lines: string[]): ClippedText {
  const start = clipStart(lines, MAX_TRANSCRIPT_BYTES);
  return { text: lines.slice(start).join("\n"), complete: start === 0 };
}

/**
 * Index of the oldest line that still fits under `bytes`, counting from the newest back.
 *
 * Split out of {@link clipToCap} for the live read, which needs the same "keep the tail" policy at
 * its own smaller bound and needs the LINES rather than one joined text.
 */
function clipStart(lines: readonly string[], bytes: number): number {
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += Buffer.byteLength(lines[i]!) + 1; // +1 for the joining newline
    if (total > bytes) return i + 1;
  }
  return 0;
}

// ── The live read ────────────────────────────────────────────────────────────
//
// WHAT THE CURSOR COUNTS HERE, AND WHY IT IS NOT A ROW ID. OpenCode MUTATES a row while a reply
// streams — `part.time_updated` in V1, `session_message.time_updated` in V2, measured at +497 ms
// over five streaming seconds on 2026-09-22 — so "what is new" is not "which rows were added". It is
// "which rows were TOUCHED", and the only column that answers that is the clock. A row id cursor
// would report a streaming reply once, at its first word, and never again.
//
// SO A LIVE READ RE-EMITS, BY DESIGN. The comparison is `>=`, not `>`: two rows can share a
// millisecond, and `>` would drop a row written in the same millisecond as the cursor for good,
// since nothing later would ever bring it back. `>=` re-emits the newest row instead, which costs
// one row and is what the caller must handle anyway — it is holding a half-streamed reply under the
// same id. The idle cost is nothing, because `stat` is the pre-check: a session whose count and
// newest touch did not move is never read at all.

/** What one live read got out of the database. */
interface SinceRows {
  lines: string[];
  /** The newest `time_updated` among the rows READ, including any the role filter dropped. */
  position: number;
}

/** The newest touch across some rows, or `fallback` when none of them carried one. */
function newestTouch(rows: readonly { time_updated: number | null }[], fallback: number): number {
  let newest = fallback;
  for (const row of rows) if ((row.time_updated ?? 0) > newest) newest = row.time_updated ?? 0;
  return newest;
}

/** V1's live read: the messages a cursor has not seen, or the newest `limit` when it holds none. */
function composeSinceV1(db: Database, sessionId: string, at: number | null, limit: number): SinceRows {
  const messages =
    at === null
      ? db
          .query<MessageRow, [string, number]>(
            `select ${V1_MESSAGE_COLUMNS} from message where session_id = ? order by time_created desc, id desc limit ?`,
          )
          .all(sessionId, limit)
          .toReversed()
      : db
          .query<MessageRow, [string, number, string, number, number]>(
            // EITHER end of a message may have moved: the message row's own clock, or one of its
            // parts', which is the one that ticks while the reply streams. The whole message is
            // re-composed with all its parts either way, because a caller replacing a turn by uuid
            // needs the whole turn, not the piece that changed.
            `select ${V1_MESSAGE_COLUMNS} from message where session_id = ?
               and (coalesce(time_updated, 0) >= ?
                    or id in (select message_id from part where session_id = ? and coalesce(time_updated, 0) >= ?))
             order by time_created, id limit ?`,
          )
          .all(sessionId, at, sessionId, at, limit);

  // The parts of exactly the messages selected above. A placeholder per id rather than a second copy
  // of the selection: the ids are already in hand, the list is bounded by `limit`, and repeating the
  // predicate is how the two halves of one read start disagreeing.
  const ids = messages.map((m) => m.id);
  const parts =
    ids.length === 0
      ? []
      : db
          .query<PartRow, string[]>(
            `select ${V1_PART_COLUMNS} from part where session_id = ? and message_id in (${ids.map(() => "?").join(",")}) order by id`,
          )
          .all(sessionId, ...ids);

  return {
    lines: linesV1(messages, parts),
    position: newestTouch(parts, newestTouch(messages, at ?? 0)),
  };
}

/** V2's live read. Its parts are inline, so one row's own clock is the whole answer. */
function composeSinceV2(db: Database, sessionId: string, at: number | null, limit: number): SinceRows {
  const rows =
    at === null
      ? db
          .query<MessageRowV2, [string, number]>(
            `select ${V2_COLUMNS} from session_message where session_id = ? order by seq desc limit ?`,
          )
          .all(sessionId, limit)
          .toReversed()
      : db
          .query<MessageRowV2, [string, number, number]>(
            `select ${V2_COLUMNS} from session_message where session_id = ? and coalesce(time_updated, 0) >= ? order by seq limit ?`,
          )
          .all(sessionId, at, limit);

  return {
    lines: rows.map(lineV2).filter((line): line is string => line !== null),
    // Over ALL rows read, not only the ones that composed a line. A `system` or `idle` row is read
    // and deliberately not shown; leaving its clock out of the cursor would make every later read
    // fetch it again for ever.
    position: newestTouch(rows, at ?? 0),
  };
}

/** Both generations' live read, behind the one store decision the rest of this module makes once. */
function composeSince(
  db: Database,
  sessionId: string,
  store: OpencodeStore,
  at: number | null,
  limit: number,
): SinceRows {
  return store === "v2"
    ? composeSinceV2(db, sessionId, at, limit)
    : composeSinceV1(db, sessionId, at, limit);
}

/**
 * A completed tool call's result text. V1 writes one `state.output` string, while V2 writes
 * `state.content` — the same content array a message carries (verified 2026-09-22 on 2.0.12) — so its
 * text items are joined.
 */
function toolOutputText(state: JsonObject): string {
  if (typeof state.output === "string") return state.output;
  if (!Array.isArray(state.content)) return "";
  const texts: string[] = [];
  for (const item of state.content) {
    const record = asRecord(item);
    if (record !== null && typeof record.text === "string") texts.push(record.text);
  }
  return texts.join("\n");
}

/**
 * An errored call's sentence: `state.error` first, then whatever output also made it. V1 writes the
 * error as a string; V2 writes `{type, message}` (`SessionError.Error` upstream) and may leave out
 * `content` entirely, so its `message` is the only sentence there is.
 */
function toolErrorText(state: JsonObject): string {
  if (typeof state.error === "string") return state.error;
  const error = asRecord(state.error);
  if (error !== null && typeof error.message === "string") return error.message;
  return toolOutputText(state);
}

/**
 * An errored call that is a REFUSAL, not a failure.
 *
 * OpenCode marks both with `status: "error"`, so the status alone cannot tell "the command exited 1"
 * from "the person said no" — the same problem Claude's `is_error` has, and the text is again the
 * only answer. The first two phrasings are the ones a real store holds (opencode 1.18.9, 398
 * completed and 23 errored tool parts, read 2026-09-29); the rest are the ones the session-stream
 * prototype met on 1.18.32 and 2.0.12. A phrasing this misses degrades to `isError`, the old
 * behaviour, which is why the list may be short without being wrong.
 */
const REFUSED_TEXT =
  /rejected permission|dismissed this question|specified a rule which prevents|execution aborted|permission denied|user declined/i;

/**
 * V2's `error.type` is an enum, not prose (`ToolStateError`, 2.0.12), so a substring match on it is
 * safe where the same match on a message would claim "connection aborted" as somebody's refusal.
 */
const REFUSED_TYPE = /permission|abort|interrupt|declin|reject|dismiss/i;

/** True when an errored call was stopped by a person rather than by the tool. */
function isRefusal(state: JsonObject): boolean {
  const metadata = asRecord(state.metadata);
  if (metadata !== null && metadata.interrupted === true) return true;
  // V1 writes the error as a STRING, so prose is all there is to read.
  if (typeof state.error === "string") return REFUSED_TEXT.test(state.error);
  // V2 writes `{type, message}`, and the type is the stronger signal of the two.
  const error = asRecord(state.error);
  if (error === null) return false;
  if (typeof error.type === "string" && REFUSED_TYPE.test(error.type)) return true;
  return typeof error.message === "string" && REFUSED_TEXT.test(error.message);
}


/**
 * Fold a file-changing call's patch out of `state.metadata`, where the two generations DISAGREE.
 *
 * V1 (1.18.9) writes ONE unified-diff string in `diff` for an `edit`, and for an `apply_patch`
 * writes that same string PLUS a `files` list of `{filePath, relativePath, type, patch}` with no
 * counts of its own. V2 (2.0.12) writes a FileDiff list in `files` instead —
 * `{file, patch, additions, deletions, status}` — so there the counts are given.
 *
 * `files` therefore outranks `diff`: it is the multi-file truth in both generations, while V1's
 * `diff` beside it is only the first file's patch.
 */
function enrichEdit(call: Extract<ToolCall, { kind: "edit" }>, metadata: JsonObject): void {
  const hunks: Hunk[] = [];
  let added = 0;
  let removed = 0;
  let created = false;
  const files = Array.isArray(metadata.files) ? metadata.files : null;
  if (files !== null) {
    for (const entry of files) {
      const file = asRecord(entry);
      if (file === null) continue;
      const parsed = parseUnifiedDiff(typeof file.patch === "string" ? file.patch : "");
      // With more than one file in one call the hunk headers no longer say which file they belong
      // to, so the first hunk of each carries its name. V2 spells it `file`, V1 `relativePath`.
      const name =
        typeof file.file === "string"
          ? file.file
          : typeof file.relativePath === "string"
            ? file.relativePath
            : "";
      const first = parsed.hunks[0];
      if (files.length > 1 && first !== undefined && name !== "") first.header = `${name} ${first.header}`.trim();
      hunks.push(...parsed.hunks);
      added += typeof file.additions === "number" ? file.additions : parsed.added;
      removed += typeof file.deletions === "number" ? file.deletions : parsed.removed;
    }
    // V2 spells a new file `status: "added"`, V1's apply_patch rows `type: "add"`. Only a single-file
    // call can say it: a batch that created one file among five did not create the call's subject.
    const only = files.length === 1 ? asRecord(files[0]) : null;
    if (only !== null && (only.status === "added" || only.type === "add")) created = true;
    // A patch tool names no file in its INPUT — verified on a real store, an `apply_patch` call's
    // classified path is empty — so a single-file patch takes its path from the result. A patch over
    // several files keeps the empty path and is named by its hunk headers instead, because the one
    // sentence that would cover them is a phrase, and the bridge composes no user-facing prose.
    if (call.path === "" && only !== null) {
      const path = typeof only.file === "string" ? only.file : typeof only.filePath === "string" ? only.filePath : "";
      if (path !== "") call.path = path;
    }
  } else if (typeof metadata.diff === "string") {
    const parsed = parseUnifiedDiff(metadata.diff);
    hunks.push(...parsed.hunks);
    added = parsed.added;
    removed = parsed.removed;
  }
  // A write against nothing is a NEW file, and V1 says so on the write itself (`exists: false`).
  if (metadata.exists === false) created = true;
  if (hunks.length > 0) call.diff = hunks;
  if (hunks.length > 0 || added > 0 || removed > 0) {
    call.added = added;
    call.removed = removed;
  }
  if (created) call.created = true;
  // NOT filled: the diff of a `write`, which OpenCode records nowhere — it keeps the new content in
  // the INPUT and no copy of what was there before. Computing one from the input would be this
  // module inventing a result rather than reading one, and `added`/`removed` staying 0 says honestly
  // that the harness counted nothing.
}

/**
 * Enrich a classified call from its `state`, which is where OpenCode records what the call actually
 * DID rather than what it was asked to do.
 *
 * MUTATES `call`, the same in-place fold `claude.ts` does and for the same reason: the part it sits
 * on is already built. Only the metadata keys verified on a real store are read — `exit`, `diff`,
 * `files`, `exists`, `matches`, `count` — and both generations keep all but the patch in one place.
 */
function enrichCall(call: ToolCall, state: JsonObject): void {
  const metadata = asRecord(state.metadata);
  if (metadata === null) return;
  if (call.kind === "edit") {
    enrichEdit(call, metadata);
  } else if (call.kind === "execute") {
    const exit = metadata.exit;
    if (typeof exit === "number" && Number.isFinite(exit)) call.exitCode = exit;
  } else if (call.kind === "search") {
    // `matches` is grep's count of matching lines; `count` is glob's count of paths.
    const hits = typeof metadata.matches === "number" ? metadata.matches : metadata.count;
    if (typeof hits === "number" && Number.isFinite(hits)) call.hits = hits;
  }
  // NOT filled: a read's range. V1's `metadata.display` names the lines the tool actually returned,
  // which can be narrower than the ones asked for, and `classifyToolCall` has already set `range`
  // from the input. Two answers to one field is worse than one answer, so the input's wins.
}

/** Map one part's `data` json onto a renderable part. Null for anything we don't model. */
export function opencodePart(data: JsonValue | undefined): TranscriptPart | null {
  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) return null;
  const d: JsonObject = data;

  if (d.type === "text") {
    const text = stripAnsi(typeof d.text === "string" ? d.text : "");
    return text.trim() === "" ? null : { kind: "text", ...clamp(text, MAX_TEXT_CHARS) };
  }

  if (d.type === "reasoning") {
    const text = stripAnsi(typeof d.text === "string" ? d.text : "");
    return text.trim() === "" ? null : { kind: "thinking", ...clamp(text, MAX_TEXT_CHARS) };
  }

  if (d.type === "tool") {
    const rawState = d.state;
    const state: JsonObject =
      rawState !== null && rawState !== undefined && typeof rawState === "object" && !Array.isArray(rawState)
        ? rawState
        : {};
    // V1 spells the tool `tool`; V2 spells it `name` (verified on 2.0.12).
    const name = typeof d.tool === "string" ? d.tool : typeof d.name === "string" ? d.name : "tool";
    const summary = summarizeToolInput(state.input);
    const call = classifyToolCall(name, state.input, summary);
    const part: Extract<TranscriptPart, { kind: "tool" }> = { kind: "tool", name, summary, call };
    // The CALL's own id, which is what a permission dialog names — V1 carries it as `callID` on the
    // part (every tool part in a real 1.18.9 store has one), V2 as the content block's `id`. The
    // part's own row id is deliberately not a fallback: it addresses the part, not the call.
    const id = typeof d.callID === "string" ? d.callID : typeof d.id === "string" ? d.id : "";
    if (id !== "") part.id = id;
    if (state.status === "completed") {
      const out = stripAnsi(toolOutputText(state));
      if (out !== "") part.result = clamp(out, MAX_RESULT_CHARS);
      enrichCall(call, state);
    } else if (state.status === "error") {
      // The error text lives in `error`, falling back to whatever output also made it.
      const err = stripAnsi(toolErrorText(state));
      part.result = { ...clamp(err, MAX_RESULT_CHARS), isError: true };
      // A refusal is not a failure. `isError` stays, so a view that only knows it reads as before,
      // and `denied` is what tells the two apart.
      if (isRefusal(state)) part.result.denied = true;
      // An errored call still records what it got as far as doing: a non-zero exit, a partial patch.
      enrichCall(call, state);
    }
    // pending/running: the call is on screen, its result simply hasn't happened yet.
    return part;
  }

  // `step-start` / `step-finish` are turn bookkeeping (token counts, stop reason), and an unknown
  // type is a format we haven't verified — neither is speech, so neither renders.
  return null;
}

/**
 * Parse composed OpenCode JSONL into oldest-first turns. PURE — no fs, no clock.
 *
 * `uuid` is the MESSAGE ID: OpenCode gives every message a stable primary key, so unlike Codex there
 * is nothing to synthesise for paging. Unparseable lines are skipped for the same reason every other
 * adapter skips them — the byte cap clips the head line mid-object by construction.
 */
export function parseOpencodeTranscript(text: string): TranscriptEntry[] {
  return parseWith(createOpencodeReducer(), text);
}

/**
 * The same reading, one row at a time (see `reduce.ts`).
 *
 * STATELESS BY FORMAT, so `changed` is always empty and there is no map to carry. A composed line
 * holds a WHOLE message: V1 joins that message's `part` rows onto it (`composeLinesV1`), V2 has its
 * parts inline in `data.content`, and a tool's RESULT sits on the call's own part — `state.output` in
 * V1, `state.content` in V2 — never in a row of its own. So no row can fold anything into a turn this
 * reducer already handed over, and `push` can never need to report a `changed` uuid. Claude and pi
 * both need one; this format gives them nothing to attach to.
 *
 * WHAT MOVES INSTEAD — the fact a live window has to be designed against. OpenCode MUTATES a part row
 * in place while a reply streams (`part.time_updated` / `session_message.time_updated` climb, see
 * `sessionMeta`), and `composeLines` groups parts by message id. Within ONE composition each message
 * id therefore appears exactly once — `message.id` and `session_message.id` are primary keys — but the
 * NEXT composition of the same live session carries that same id again with more parts on it. A
 * reducer fed those successive compositions emits the line twice, BOTH TIMES AS `added`, because it
 * keeps no memory of what it has seen and could not tell the two apart if it did. A caller holding the
 * first copy is holding a shorter version of a turn it is about to be handed again: it must replace by
 * `uuid`, never append. Solving that is the cursor's and the live window's job, not this module's; the
 * job here is to state it truthfully so the design above it is built on the truth.
 */
export function createOpencodeReducer(): RowReducer {
  // A nested `function` rather than a method on the returned object: the body below is the old loop
  // body at the indentation it always had, so this refactor is readable as the move it is.
  function push(line: string): Reduction {
    const entries: TranscriptEntry[] = [];
    if (line.trim() === "") return NO_CHANGE;
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction — and this line was composed by
      // `composeLines` above, so it is our own JSON.stringify round-tripping.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      return NO_CHANGE; // a torn row, or the head line a byte cap clipped mid-object
    }
    // A line that parses to a scalar (or a bare `null`, which used to reach `.data` and THROW) has
    // no row shape — skip it exactly as an unparseable line is skipped.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return NO_CHANGE;
    const row: OpencodeLine = parsed;
    const rawData = row.data;
    const data: JsonObject =
      rawData !== null && rawData !== undefined && typeof rawData === "object" && !Array.isArray(rawData)
        ? rawData
        : {};
    // Roles are matched EXPLICITLY, never "assistant or else user" — same rule and same rationale as
    // codex.ts's `developer` guard: an unmodelled role is plumbing, and rendering it as speech would
    // put words in the operator's mouth. `summary` is V2's compaction role (composeLinesV2), which the
    // transcript vocabulary renders set apart from speech.
    if (data.role !== "user" && data.role !== "assistant" && data.role !== "summary") return NO_CHANGE;
    const role = data.role;

    const parts: TranscriptPart[] = [];
    if (Array.isArray(row.parts)) {
      for (const p of row.parts) {
        // A `continue` over the BLOCK, not the row: the message's other parts still count.
        if (p === null || typeof p !== "object" || Array.isArray(p)) continue;
        const part = opencodePart(p.data);
        if (part !== null) parts.push(part);
      }
    }
    // Every part was bookkeeping (a lone step-start/step-finish message) — nothing to render. Here
    // that is `NO_CHANGE` outright, where Claude's reducer must still answer with its `changed` set:
    // this format folds nothing, so a row with nothing to show did nothing at all.
    if (parts.length === 0) return NO_CHANGE;

    entries.push({
      uuid: typeof row.id === "string" ? row.id : "",
      ts: isoFrom(data.time, row.ts),
      role,
      parts,
    });
    // Built directly rather than through `reduction()`: with `changed` always empty, both of that
    // helper's rules — drop `""`, drop a uuid `added` already carries — have nothing to do, and
    // `NO_CHANGE.changed` is the same frozen empty list every skip above hands back.
    return { added: entries, changed: NO_CHANGE.changed };
  }

  return { push };
}

/** ISO timestamp from `data.time.created`, falling back to the message row's `time_created`. */
function isoFrom(time: JsonValue | undefined, fallback: JsonValue | undefined): string {
  const fromTime =
    time !== null && time !== undefined && typeof time === "object" && !Array.isArray(time)
      ? time.created
      : undefined;
  const created =
    typeof fromTime === "number" ? fromTime : typeof fallback === "number" ? fallback : null;
  if (created === null) return "";
  const d = new Date(created);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * SQLite source rooted at OpenCode's data dir.
 *
 * Every method takes the virtual key `resolve()` produced (see {@link opencodeKey}) and splits it,
 * because one database backs every session on the machine.
 */
export class OpencodeTranscriptSource implements TranscriptSource {
  private readonly roots: string[];

  /** One data dir or several (a second `XDG_DATA_HOME`), each holding its own `opencode.db`. */
  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isOpencodeSessionId(ref.value)) return null;
    for (const root of this.roots) {
      // Null here is "no database, or this root's opencode.db is symlinked out of it" — either way
      // the root has nothing it may serve, and the next one is asked on its own terms.
      const real = await containedRealpath(join(root, DB_FILE), root);
      if (real === null) continue;
      const found = withDb(real, (db) => sessionStore(db, ref.value));
      // The session id is unique across databases, so the first database holding it is the right one
      // — in whichever of the two stores holds it.
      if (found !== null) return opencodeKey(real, ref.value);
    }
    return null;
  }

  /**
   * The store's cache-validity check, without reading the conversation — `sessionMeta` carries what
   * size and mtime stand for, and why they move while an agent streams.
   */
  async stat(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    const parts = splitOpencodeKey(key);
    if (parts === null) return null;
    return withDb(parts.dbPath, (db) => {
      const store = sessionStore(db, parts.sessionId);
      // The session vanished between resolve and read; an empty reading is the honest answer.
      return store === null ? { size: 0, mtimeMs: 0 } : sessionMeta(db, parts.sessionId, store);
    });
  }

  async load(key: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
    const empty = { text: "", complete: true, size: 0, mtimeMs: 0 };
    const parts = splitOpencodeKey(key);
    if (parts === null) return empty;
    return (
      withDb(parts.dbPath, (db) => {
        // ONE store decision per read: size, mtime and text must come from the same generation, and
        // the store caches that triple as one entry.
        const store = sessionStore(db, parts.sessionId);
        if (store === null) return empty;
        const { size, mtimeMs } = sessionMeta(db, parts.sessionId, store);
        const { text, complete } = clipToCap(composeLines(db, parts.sessionId, store));
        return { text, complete, size, mtimeMs };
      }) ?? empty
    );
  }

  /**
   * What is new in this session since `cursor` (see "the live read" above for what it counts).
   *
   * A read that cannot be resumed answers with the newest {@link FIRST_TAIL_ROWS} turns, clipped to
   * {@link FIRST_TAIL_BYTES}, and `reset: true`. Two bounds rather than one because the query has to
   * be bounded as well as its answer: composing ten thousand turns to throw nine thousand away is
   * the cost this method exists to remove.
   *
   * An unreadable database or a session that vanished between resolve and read HOLDS the caller's
   * cursor and reports nothing new, exactly as a file whose `stat` lost a race does. Blanking a
   * screen over a locked database would be a worse answer than an unchanged one.
   */
  async readSince(key: string, cursor: Cursor): Promise<ReadSince> {
    const held: ReadSince = { lines: [], cursor, reset: false };
    const parts = splitOpencodeKey(key);
    if (parts === null) return { lines: [], cursor: NO_CURSOR, reset: false };
    const at = decodeCursor(cursor, "updated", key);
    return (
      withDb(parts.dbPath, (db) => {
        // ONE store decision per read, like `load`: the rows and the position must come from the
        // same generation.
        const store = sessionStore(db, parts.sessionId);
        if (store === null) return held;
        const { lines, position } = composeSince(db, parts.sessionId, store, at, FIRST_TAIL_ROWS);
        const next = encodeCursor("updated", key, position);
        // The clip only ever applies to a reset. Clipping an INCREMENTAL read would drop rows off the
        // head of the delta while the cursor moved past them, which loses a turn for good; the
        // incremental read is bounded by `limit` instead, and what does not fit arrives next tick.
        if (at !== null) return { lines, cursor: next, reset: false };
        return { lines: lines.slice(clipStart(lines, FIRST_TAIL_BYTES)), cursor: next, reset: true };
      }) ?? held
    );
  }
}

/** OpenCode's journal adapter. `agent` matches the Herdr snapshot's `agent` string. */
export function opencodeJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new OpencodeTranscriptSource(roots);
  return {
    agent: "opencode",
    source,
    parse: parseOpencodeTranscript,
    cacheProbe: (ref) => opencodeCacheProbe(source, ref),
  };
}

// ── The prompt-cache probe ───────────────────────────────────────────────────
//
// "Seek, don't stream" becomes "query, don't scan": the twelve newest turns for THIS session by
// indexed key, because the last row is often the operator's own message rather than an assistant
// turn. Read-only, bound parameters, and the same tables the rest of this module reads — nothing
// outside them, because the same database holds OAuth tokens. V1's query is ported from
// herdr-cache-alert `src/harness/opencode.ts:210-256`; V2's reads `session_message` instead, where
// the role lives in the `type` column, the resets are explicit rows, and the window is filtered to
// the types the probe reads (V2 interleaves bookkeeping rows V1 never had).
//
// The cache lifetime is the UPSTREAM's, not opencode's: every session records its own provider, so
// `model` is reported as `providerID:model` and `bridge/cache/rules/providers.ts` unwraps a gateway
// prefix out of it. `tokens.cache.read` / `.write` is the warm/cold verdict, and it is the
// trustworthy part of the chip even where the upstream documents no TTL at all.
//
// Verified against opencode's live database on 2026-09-13 (V1) and 2026-09-22 (V2): an assistant
// message's `data` carries `tokens.cache.{read,write}` and `time.{created,completed}` in both, and
// the model pair is `providerID`/`modelID` at the top level in V1 but `model:{providerID, id}` in V2.

interface ProbeRow {
  /** V2's role/event column; the V1 query aliases `null` in so both rows share one shape. */
  type: string | null;
  data: string | null;
  time_created: number;
}

// ── Actions that drop the cache between turns ────────────────────────────────
//
// Ported from herdr-cache-alert `src/harness/opencode.ts` (commit 17fb2af). STRUCTURED FIELDS ONLY,
// never message text, and all three live on the same `data` json the probe already parses (checked
// against a live `opencode.db` on 2026-09-19):
//
//   a USER message's `model: {providerID, modelID}`   the model picked for the turn it starts
//   an ASSISTANT message's `mode: "compaction"`       the summary a compaction writes, together with
//     and `summary: true`                             `summary: true` (a user message's `summary` is an
//                                                     object, so only the boolean counts)
//
// V2 writes the same two actions as EXPLICIT `model-switched` and `compaction` rows instead, so its
// probe reads those (`opencodeResetsV2`) rather than inferring from a user message's model field —
// which V2 does not write (verified 2026-09-22).

/** The ids this module reports. Each is a shipped rule (`bridge/cache/rules/opencode.ts`). */
const OPENCODE_RESET_IDS = {
  model: "opencode.reset.model",
  compaction: "opencode.reset.compaction",
} as const;

/** A compaction summary: the assistant message a compaction writes in place of the history. */
function isCompaction(message: JsonObject): boolean {
  return message.mode === "compaction" || message.summary === true;
}

/** `provider/model`, or null when either half is missing. A half-known model claims nothing. */
function modelKey(provider: JsonValue | undefined, model: JsonValue | undefined): string | null {
  const p = asText(provider);
  const m = asText(model);
  return p !== undefined && m !== undefined ? `${p}/${m}` : null;
}

/**
 * The `provider/model` a nested model record names, or null when either half is missing. V2 nests
 * `model`/`previous` as `{providerID, id}`; V1's user rows nest the same shape with `modelID`.
 */
function nestedModelKey(record: JsonObject | null): string | null {
  if (record === null) return null;
  return modelKey(record.providerID, record.id) ?? modelKey(record.providerID, record.modelID);
}

/**
 * The `provider/model` a message names, or null when either half is missing.
 *
 * Both spellings must read: V1 keeps `providerID`/`modelID` on the message itself (assistant rows) or
 * under `model` (user rows), while V2 always nests `model: {providerID, id}` (verified on 2.0.12).
 */
function messageModelKey(message: JsonObject): string | null {
  const nested = asRecord(message.model);
  return nested !== null ? nestedModelKey(nested) : modelKey(message.providerID, message.modelID);
}

/** An epoch-ms instant as the evidence line prints it. */
function when(ms: number): string {
  return new Date(ms).toISOString();
}

/** One compaction as a reset event, at the instant it happened. */
function compactionReset(at: number): ResetEvent {
  return { ruleId: OPENCODE_RESET_IDS.compaction, at, evidence: `compaction at ${when(at)}` };
}

/** When a message happened: finished if it finished, else started, else `fallback`. */
function messageAt(message: JsonObject, fallback: number): number {
  const time = asRecord(message.time);
  return tokenCount(time?.completed) ?? tokenCount(time?.created) ?? fallback;
}

/**
 * Reset events around the newest assistant turn in a V1 session, oldest first. V2 writes the same
 * actions as explicit rows instead — see {@link opencodeResetsV2}.
 *
 * `messages` runs NEWEST FIRST, as the probe's query returns them, and `newest` indexes the assistant
 * turn the probe chose. Three cases, and the engine sorts them by the turn's own time:
 *
 *  - the turn IS a compaction summary: the next request builds on the summary, so the reset is
 *    reported just after the turn and reads as pending;
 *  - a user message newer than the turn picked another model: pending, the newest such message only;
 *  - the assistant turn before this one was a compaction, or ran on another model: history, which
 *    explains a cold turn.
 */
export function opencodeResets(messages: ReadonlyArray<JsonObject | null>, newest: number): ResetEvent[] {
  const turn = messages[newest];
  if (turn === undefined || turn === null) return [];
  const at = messageAt(turn, 0);
  const current = messageModelKey(turn);
  const events: ResetEvent[] = [];

  if (isCompaction(turn)) {
    events.push({ ruleId: OPENCODE_RESET_IDS.compaction, at: at + 1, evidence: `compaction summary at ${when(at)}` });
  }

  // Newest first, so the first user message found is the newest one.
  for (let i = 0; i < newest; i++) {
    const message = messages[i];
    if (message === undefined || message === null || message.role !== "user") continue;
    const picked = messageModelKey(message);
    if (current !== null && picked !== null && picked !== current) {
      const pickedAt = Math.max(messageAt(message, at + 1), at + 1);
      events.push({ ruleId: OPENCODE_RESET_IDS.model, at: pickedAt, evidence: `model ${current} → ${picked}` });
    }
    break;
  }

  for (let i = newest + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined || message === null) continue;
    if (message.role !== "assistant" || asRecord(message.tokens) === null) continue;
    if (isCompaction(message)) {
      events.push(compactionReset(messageAt(message, at)));
      break;
    }
    const before = messageModelKey(message);
    if (before !== null && current !== null && before !== current) {
      events.push({ ruleId: OPENCODE_RESET_IDS.model, at, evidence: `model ${before} → ${current}` });
    }
    break;
  }
  return events.toSorted((a, b) => a.at - b.at);
}

/**
 * Reset events for a V2 session, off the explicit event rows V2 writes instead of V1's inference.
 *
 * `messages` runs NEWEST FIRST, and `newest` indexes the assistant turn the probe chose. V2 records
 * the two cache-dropping actions as their own `session_message` rows — `model-switched` (carrying
 * `previous` and the new `model`) and `compaction` (whose `summary` replaces the history) — so
 * nothing has to be inferred from a user message's model or a boolean flag:
 *
 *  - a `model-switched`/`compaction` row NEWER than the turn is pending: the next request pays the
 *    full rate, so the event sits just after the turn's own clock, newest of each kind only;
 *  - the nearest such row OLDER than the turn explains the cold turn it followed.
 */
export function opencodeResetsV2(messages: ReadonlyArray<JsonObject | null>, newest: number): ResetEvent[] {
  const turn = messages[newest];
  if (turn === undefined || turn === null) return [];
  const at = messageAt(turn, 0);
  const events: ResetEvent[] = [];

  // Pending: the newest of each kind among the rows newer than the turn (index < newest).
  let pendingModel: JsonObject | null = null;
  let pendingCompaction: JsonObject | null = null;
  for (let i = 0; i < newest; i++) {
    const message = messages[i];
    if (message === undefined || message === null) continue;
    if (pendingModel === null && message.type === "model-switched") pendingModel = message;
    if (pendingCompaction === null && isV2Compaction(message)) pendingCompaction = message;
    if (pendingModel !== null && pendingCompaction !== null) break;
  }
  if (pendingModel !== null) {
    const event = v2ModelEvent(pendingModel, Math.max(messageAt(pendingModel, at + 1), at + 1));
    if (event !== null) events.push(event);
  }
  if (pendingCompaction !== null) {
    events.push(compactionReset(Math.max(messageAt(pendingCompaction, at + 1), at + 1)));
  }

  // History: the nearest event row older than the turn (index > newest).
  for (let i = newest + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message === undefined || message === null) continue;
    if (isV2Compaction(message)) {
      events.push(compactionReset(messageAt(message, at)));
      break;
    }
    if (message.type === "model-switched") {
      const event = v2ModelEvent(message, at);
      if (event !== null) events.push(event);
      break;
    }
  }
  return events.toSorted((a, b) => a.at - b.at);
}

/**
 * A V2 compaction that replaces, or is replacing, the history. A `failed` one left the history as it
 * was, so the cache it would have dropped is still warm and it claims nothing.
 */
function isV2Compaction(row: JsonObject): boolean {
  return row.type === "compaction" && row.status !== "failed";
}

/** One V2 `model-switched` row as a reset event, or null when it names no model to switch to. */
function v2ModelEvent(row: JsonObject, at: number): ResetEvent | null {
  const to = nestedModelKey(asRecord(row.model));
  if (to === null) return null;
  const from = nestedModelKey(asRecord(row.previous));
  return { ruleId: OPENCODE_RESET_IDS.model, at, evidence: `model ${from ?? "?"} → ${to}` };
}

async function opencodeCacheProbe(
  source: OpencodeTranscriptSource,
  ref: AgentSessionRef,
): Promise<CacheProbe | null> {
  const key = await source.resolve(ref);
  if (key === null) return null;
  const split = splitOpencodeKey(key);
  if (split === null) return null;
  const read = withDb(split.dbPath, (db) => {
    const store = sessionStore(db, split.sessionId);
    const rows =
      store === "v2"
        ? db
            .query<ProbeRow, [string]>(
              // `seq` is V2's per-session order, so newest-first is its reverse. The type filter
              // keeps the twelve-row window for the rows this probe reads: V2 interleaves `idle`,
              // `synthetic` and `system` rows V1 never had, and without the filter a busy session's
              // window can hold no token-bearing turn at all (measured live 2026-09-23: one of 132
              // sessions), leaving that pane with no chip.
              "select type, data, time_created from session_message where session_id = ? and type in ('assistant', 'model-switched', 'compaction') order by seq desc limit 12",
            )
            .all(split.sessionId)
        : db
            .query<ProbeRow, [string]>(
              "select null type, data, time_created from message where session_id = ? order by time_created desc limit 12",
            )
            .all(split.sessionId);
    return { store, rows };
  });
  // A database that failed to open, or a session that vanished between resolve and read, has no
  // reading to give — the tracker treats null as "nothing new" and ages the last one.
  if (read === null) return null;
  const { store, rows } = read;
  const messages = rows.map((row) => {
    const parsed = asRecord(parseData(row.data)) ?? {};
    // V2 keeps the role in the `type` column rather than the row's json; a V1 row already has it.
    return row.type === null ? parsed : { ...parsed, role: row.type, type: row.type };
  });

  for (const [index, row] of rows.entries()) {
    const message = messages[index] ?? null;
    if (message === null || message.role !== "assistant") continue;
    const tokens = asRecord(message.tokens);
    if (tokens === null) continue;
    const time = asRecord(message.time);
    // `time.completed` is when the turn finished, `time.created` when it started. Either beats the
    // row's own column, which tracks the row and not the request.
    const at = tokenCount(time?.completed) ?? tokenCount(time?.created) ?? row.time_created;
    if (!Number.isFinite(at)) continue;
    const cache = asRecord(tokens.cache);
    const cacheReadTokens = tokenCount(cache?.read);
    const cacheCreationTokens = tokenCount(cache?.write);
    // The model pair sits on the message itself in V1 and under `model` in V2; both come out as
    // `provider:model` for the rules lookup, and a half-known pair claims only what it knows.
    const nested = asRecord(message.model);
    const provider = asText(nested?.providerID) ?? asText(message.providerID);
    const model = asText(nested?.id) ?? asText(nested?.modelID) ?? asText(message.modelID);
    const pair = provider !== undefined && model !== undefined ? `${provider}:${model}` : model;
    const probe: CacheProbe = {
      lastRequestAt: at,
      // Message ids are unique per turn, and `time_created` stands in for one: two assistant turns
      // cannot share a millisecond in this schema.
      turnId: String(row.time_created),
      // The query's own newest timestamp is this reading's clock — there is no file mtime to take.
      measuredAt: at,
      evidence: `${split.dbPath} (${pair ?? "?"}, cache read ${String(cacheReadTokens ?? "?")})`,
    };
    if (cacheReadTokens !== undefined) probe.cacheReadTokens = cacheReadTokens;
    if (cacheCreationTokens !== undefined) probe.cacheCreationTokens = cacheCreationTokens;
    if (pair !== undefined) probe.model = pair;
    const resets = store === "v2" ? opencodeResetsV2(messages, index) : opencodeResets(messages, index);
    if (resets.length > 0) probe.resets = resets;
    return probe;
  }
  return null;
}
