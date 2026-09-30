// Hermes' local SessionDB journal adapter.
//
// Hermes stores sessions in one SQLite database (`~/.hermes/state.db`). The pane supplies the
// session id through Herdr, so this adapter reads exactly that session; it never guesses from the
// newest row. The database is opened read-only and the fixed filename is confined to the configured
// root before opening.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { NO_CHANGE, parseWith, type Reduction, type RowReducer } from "./reduce.ts";
import { containedRealpath, MAX_TRANSCRIPT_BYTES, rootList } from "./files.ts";
import { clamp, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

const DB_FILE = "state.db";
const SESSION_ID_RE = /^\d{8}_\d{6}_[A-Za-z0-9]+$/;

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

function withDb<T>(dbPath: string, fn: (db: Database) => T): T | null {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    return fn(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
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

function composeLines(db: Database, sessionId: string): string[] {
  const rows = db.query<MessageRow, [string]>(
    "with recursive lineage(id, depth) as (select ? as id, 0 union all select s.parent_session_id, lineage.depth + 1 from sessions s join lineage on s.id = lineage.id where s.parent_session_id is not null and lineage.depth < 32) select m.id, m.role, m.content, m.tool_call_id, m.tool_calls, m.tool_name, m.timestamp, m.reasoning, m.reasoning_content, m.active, m.compacted, m.display_kind from messages m join lineage on lineage.id = m.session_id where m.active = 1 or m.compacted = 1 order by lineage.depth desc, m.id",
  ).all(sessionId);
  return rows.map((row: MessageRow) => JSON.stringify(row));
}

function clipLines(lines: string[]) {
  let bytes = 0;
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    bytes += Buffer.byteLength(lines[i]!) + 1;
    if (bytes > MAX_TRANSCRIPT_BYTES) {
      start = i + 1;
      break;
    }
  }
  return { text: lines.slice(start).join("\n"), complete: start === 0 };
}

export function parseHermesTranscript(text: string): TranscriptEntry[] {
  return parseWith(createHermesReducer(), text);
}

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

  return { push };
}

type SessionMeta = { size: number; mtimeMs: number };

function sessionMeta(db: Database, sessionId: string): SessionMeta {
  const row = db.query<{ count: number; newest: number }, [string]>(
    "select count(*) as count, coalesce(max(timestamp), 0) as newest from messages where session_id = ?",
  ).get(sessionId);
  return { size: row?.count ?? 0, mtimeMs: row?.newest ?? 0 };
}

export class HermesTranscriptSource implements TranscriptSource {
  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isHermesSessionId(ref.value)) return null;
    for (const root of this.roots) {
      const path = await containedRealpath(join(root, DB_FILE), root);
      if (path === null) continue;
      const found = withDb(path, (db) =>
        db.query<{ id: string }, [string]>("select id from sessions where id = ?").get(ref.value),
      );
      if (found !== null && found !== undefined) return hermesKey(path, ref.value);
    }
    return null;
  }

  async stat(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    const parts = splitHermesKey(key);
    if (parts === null) return null;
    return withDb(parts.dbPath, (db) => sessionMeta(db, parts.sessionId));
  }

  async load(key: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
    const empty = { text: "", complete: true, size: 0, mtimeMs: 0 };
    const parts = splitHermesKey(key);
    if (parts === null) return empty;
    return withDb(parts.dbPath, (db) => {
      const meta = sessionMeta(db, parts.sessionId);
      const clipped = clipLines(composeLines(db, parts.sessionId));
      return { ...clipped, ...meta };
    }) ?? empty;
  }
}

export function hermesJournal(roots: string | readonly string[]): JournalAdapter {
  return { agent: "hermes", source: new HermesTranscriptSource(roots), parse: parseHermesTranscript };
}