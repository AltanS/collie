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
import { asRecord, asText, tokenCount } from "./cache-probe.ts";
import { containedRealpath, MAX_TRANSCRIPT_BYTES, rootList } from "./files.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
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
  data: string | null;
}

interface PartRow {
  id: string;
  message_id: string;
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

/** V1: one `message` row per turn, its `part` rows joined by message id. */
function composeLinesV1(db: Database, sessionId: string): string[] {
  const messages = db
    .query<MessageRow, [string]>(
      "select id, time_created, data from message where session_id = ? order by time_created, id",
    )
    .all(sessionId);
  // Ids are time-ordered (verified lexicographically monotone), so ordering by id keeps a message's
  // parts in the order the agent emitted them without trusting a nullable timestamp.
  const parts = db
    .query<PartRow, [string]>(
      "select id, message_id, data from part where session_id = ? order by id",
    )
    .all(sessionId);

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
      "select id, type, time_created, data from session_message where session_id = ? order by seq",
    )
    .all(sessionId);
  const lines: string[] = [];
  for (const row of rows) {
    const role = v2Role(row.type);
    if (role === null) continue;
    const record = asRecord(parseData(row.data)) ?? {};
    lines.push(
      JSON.stringify({
        id: row.id,
        ts: row.time_created,
        data: { role, time: record.time },
        parts: v2Parts(record).map((part, index) => ({ id: `prt_${row.id}_${index}`, data: part })),
      }),
    );
  }
  return lines;
}

/**
 * Keep the NEWEST lines that fit under the byte cap — the same "keep the tail" policy `loadTail`
 * applies to a file, applied to composed text instead.
 */
type ClippedText = { text: string; complete: boolean };

function clipToCap(lines: string[]): ClippedText {
  let bytes = 0;
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    bytes += Buffer.byteLength(lines[i]!) + 1; // +1 for the joining newline
    if (bytes > MAX_TRANSCRIPT_BYTES) {
      start = i + 1;
      break;
    }
  }
  return { text: lines.slice(start).join("\n"), complete: start === 0 };
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
    const part: Extract<TranscriptPart, { kind: "tool" }> = {
      kind: "tool",
      // V1 spells the tool `tool`; V2 spells it `name` (verified on 2.0.12).
      name: typeof d.tool === "string" ? d.tool : typeof d.name === "string" ? d.name : "tool",
      summary: summarizeToolInput(state.input),
    };
    if (state.status === "completed") {
      const out = stripAnsi(toolOutputText(state));
      if (out !== "") part.result = clamp(out, MAX_RESULT_CHARS);
    } else if (state.status === "error") {
      // The error text lives in `error`, falling back to whatever output also made it.
      const err = stripAnsi(toolErrorText(state));
      part.result = { ...clamp(err, MAX_RESULT_CHARS), isError: true };
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
  const entries: TranscriptEntry[] = [];

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction — and this line was composed by
      // `composeLines` above, so it is our own JSON.stringify round-tripping.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      continue;
    }
    // A line that parses to a scalar (or a bare `null`, which used to reach `.data` and THROW) has
    // no row shape — skip it exactly as an unparseable line is skipped.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
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
    if (data.role !== "user" && data.role !== "assistant" && data.role !== "summary") continue;
    const role = data.role;

    const parts: TranscriptPart[] = [];
    if (Array.isArray(row.parts)) {
      for (const p of row.parts) {
        if (p === null || typeof p !== "object" || Array.isArray(p)) continue;
        const part = opencodePart(p.data);
        if (part !== null) parts.push(part);
      }
    }
    // Every part was bookkeeping (a lone step-start/step-finish message) — nothing to render.
    if (parts.length === 0) continue;

    entries.push({
      uuid: typeof row.id === "string" ? row.id : "",
      ts: isoFrom(data.time, row.ts),
      role,
      parts,
    });
  }

  return entries;
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
