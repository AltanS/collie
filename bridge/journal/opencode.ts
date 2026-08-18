// OpenCode's journal adapter.
//
// SHAPE OF THE SOURCE (live-verified against opencode 1.18.9 + herdr 0.7.5, 2026-08-03) — and it is
// the odd one out: OpenCode keeps NO per-session log file. Everything lives in ONE SQLite database,
//   <dataDir>/opencode.db     (WAL mode; the `-shm`/`-wal` siblings sit beside it)
// where dataDir is `$XDG_DATA_HOME/opencode`, defaulting to `~/.local/share/opencode`. The three
// tables this adapter reads (schema verified):
//   session(id TEXT PK, project_id, workspace_id, parent_id, slug, directory, title, …,
//           time_created INT ms, time_updated INT ms)   — a non-null `parent_id` marks a SUBAGENT
//                                                         (task-tool) session
//   message(id TEXT PK, session_id, time_created INT ms, time_updated INT ms, data TEXT json)
//   part(id TEXT PK, message_id, session_id, time_created, time_updated, data TEXT json)
//
// SECURITY — THE SAME DATABASE HOLDS OAUTH TOKENS. `account`, `credential` and `control_account` are
// tables in this very file. So: this module queries `session`, `message` and `part` and NOTHING else;
// every query is opened READONLY and uses BOUND PARAMETERS (never string interpolation); the session
// id is regex-validated before it can touch a query at all; and the database path is fixed
// (`<root>/opencode.db`, never derived from the ref) and still passed through `containedRealpath`,
// because the containment rule in CLAUDE.md is absolute even for a constant path.
//
// Message `data` json, verified samples:
//   user      {"role":"user","time":{"created":1785311866628},"agent":"build","model":{…},
//              "summary":{"diffs":[]}}
//   assistant {"parentID":"msg_…","role":"assistant","mode":"build","agent":"build",
//              "variant":"medium","path":{…},"cost":…,"time":{"created":…}}
// Part `data` json `type` values, verified: `text`, `reasoning`, `tool`, `step-start`, `step-finish`.
//
// WHERE HERDR'S ID COMES FROM: `herdr integration install opencode` installs a plugin (integration
// version 9) that calls `pane.report_agent_session {agent_session_id}`, so the pane record carries
// `agent_session: {source:"herdr:opencode", agent:"opencode", kind:"id",
// value:"ses_03969c19cffeJrZCPOT6zG8Bm7"}` — a kind-`id` ref of `ses_` + base62. Without the
// integration installed there is no ref at all and the history route already answers "no-session".
//
// NO SIDECHAIN FILTERING IS NEEDED, unlike Claude's adapter. A subagent turn is not interleaved into
// its parent's rows: it lives in its OWN `session` row (the one carrying `parent_id`), with its own
// messages and parts, and the herdr plugin already refuses to report a parentID-carrying session. The
// ref is therefore always a root session, and the subagent rows are simply never queried.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
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

interface CountRow {
  c: number;
  m: number;
}

/** What a session's row counts stand in for, in place of a file's size + mtime. */
type SessionMeta = { size: number; mtimeMs: number };

/** Row counts + newest touch across `message` and `part` for one session. */
function sessionMeta(db: Database, sessionId: string): SessionMeta {
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

/** One composed JSONL line — the text `parse()` reads, once it has parsed to an object at all. */
type OpencodeLine = JsonObject;

/**
 * Compose the session's rows into JSONL — one line per message, its parts nested.
 *
 * The line format is this adapter's own (there is no file on disk to mirror), chosen so `parse()` can
 * stay PURE and table-testable exactly like every other harness's: the source produces text, the
 * parser reads text, and no test needs a database to pin the grammar.
 */
function composeLines(db: Database, sessionId: string): string[] {
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
      name: typeof d.tool === "string" ? d.tool : "tool",
      summary: summarizeToolInput(state.input),
    };
    if (state.status === "completed") {
      const out = stripAnsi(typeof state.output === "string" ? state.output : "");
      if (out !== "") part.result = clamp(out, MAX_RESULT_CHARS);
    } else if (state.status === "error") {
      // The error text lives in `error`; `output` is usually absent on a failed call.
      const err = stripAnsi(
        typeof state.error === "string"
          ? state.error
          : typeof state.output === "string"
            ? state.output
            : "",
      );
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
    // put words in the operator's mouth.
    if (data.role !== "user" && data.role !== "assistant") continue;
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
      const found = withDb(real, (db) =>
        db.query<{ id: string }, [string]>("select id from session where id = ?").get(ref.value),
      );
      // The session id is unique across databases, so the first database holding it is the right one.
      if (found) return opencodeKey(real, ref.value);
    }
    return null;
  }

  /**
   * The store's cache-validity check, without reading the conversation.
   *
   * Row COUNT stands in for "size" and the newest `time_updated` for mtime. Streaming bumps
   * `part.time_updated` continuously, so a live session invalidates on every poll while a finished
   * one stays cached — exactly the behaviour a file's mtime gives the other adapters. Count is not a
   * byte-exact size, but combined with the timestamp a false cache hit would need an add and a delete
   * inside the SAME millisecond, which sqlite's ms-resolution stamps make effectively impossible.
   */
  async stat(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    const parts = splitOpencodeKey(key);
    if (parts === null) return null;
    return withDb(parts.dbPath, (db) => sessionMeta(db, parts.sessionId));
  }

  async load(key: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
    const empty = { text: "", complete: true, size: 0, mtimeMs: 0 };
    const parts = splitOpencodeKey(key);
    if (parts === null) return empty;
    return (
      withDb(parts.dbPath, (db) => {
        const { size, mtimeMs } = sessionMeta(db, parts.sessionId);
        const { text, complete } = clipToCap(composeLines(db, parts.sessionId));
        return { text, complete, size, mtimeMs };
      }) ?? empty
    );
  }
}

/** OpenCode's journal adapter. `agent` matches the Herdr snapshot's `agent` string. */
export function opencodeJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "opencode",
    source: new OpencodeTranscriptSource(roots),
    parse: parseOpencodeTranscript,
  };
}
