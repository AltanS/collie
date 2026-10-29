// Antigravity CLI (AGY 1.3.x–1.4.8) journal adapter.
//
// Reads per-conversation SQLite trajectories (`<root>/conversations/<uuid>.db`, CortexStep protobuf
// payloads) first, and falls back to plaintext `<root>/brain/<uuid>/.system_generated/logs/transcript.jsonl`
// when no populated `.db` exists (excluding `.pb` fixed-key decryption). Session discovery binds to
// the running process's held `<root>/presence/<uuid>.lock` via `lsof`, never guessing from the newest
// conversation in a shared folder.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { JsonValue } from "../json.ts";
import { decodeCursor, encodeCursor, NO_CURSOR, type Cursor, type ReadSince } from "./cursor.ts";
import {
  containedRealpath,
  FIRST_TAIL_BYTES,
  FIRST_TAIL_ROWS,
  loadTail,
  MAX_TRANSCRIPT_BYTES,
  readSinceFile,
  rootList,
  statFile,
} from "./files.ts";
import {
  createUnknownCounter,
  NO_CHANGE,
  noQueue,
  rememberPending,
  type Reduction,
  type RowReducer,
} from "./reduce.ts";
import { readSqlite } from "./sqlite-read.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  DiscoverHints,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STEP_BYTES = 4 * 1024 * 1024;
const exec = promisify(execFile);

// Historical and current CortexStep tool step_types that share `meta.4` (`call.1=id, call.2=name, call.3=args`).
const TOOL_STEP_TYPES = new Set([5, 7, 8, 9, 17, 21, 33, 132]);

const KNOWN_STEP_ROWS = [
  "5",
  "7",
  "8",
  "9",
  "14",
  "15",
  "17",
  "21",
  "23",
  "33",
  "90",
  "98",
  "101",
  "132",
  "139",
  "USER_INPUT",
  "PLANNER_RESPONSE",
  "GENERIC",
  "SYSTEM_MESSAGE",
  "CHECKPOINT",
  "VIEW_FILE",
  "RUN_COMMAND",
  "EPHEMERAL_MESSAGE",
  "GREP_SEARCH",
  "CONVERSATION_HISTORY",
  "LIST_DIRECTORY",
  "SEARCH_WEB",
  "ERROR_MESSAGE",
  "CODE_ACTION",
] as const;

type ProtoField = { field: number; value: number | Uint8Array };

/** The bounded protobuf wire reader only descends into fields named below, never arbitrary data. */
function proto(raw: Uint8Array, maxFields = 1024): ProtoField[] {
  let at = 0;
  function integer(): number {
    let value = 0n;
    for (let shift = 0n; shift < 70n && at < raw.length; shift += 7n) {
      const byte = raw[at++]!;
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("oversized protobuf integer");
        return Number(value);
      }
    }
    throw new Error("truncated protobuf integer");
  }
  const fields: ProtoField[] = [];
  while (at < raw.length) {
    if (fields.length >= maxFields) throw new Error("too many protobuf fields");
    const tag = integer();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) throw new Error("invalid protobuf field");
    if (wire === 0) {
      fields.push({ field, value: integer() });
    } else if (wire === 2 || wire === 1 || wire === 5) {
      const length = wire === 2 ? integer() : wire === 1 ? 8 : 4;
      if (length > raw.length - at) throw new Error("truncated protobuf field");
      if (wire === 2) fields.push({ field, value: raw.subarray(at, at + length) });
      at += length;
    } else {
      throw new Error("unsupported protobuf wire type");
    }
  }
  return fields;
}

function bytes(fields: ProtoField[], field: number): Uint8Array {
  const value = fields.find((item) => item.field === field)?.value;
  return value instanceof Uint8Array ? value : new Uint8Array();
}

function string(fields: ProtoField[], field: number): string {
  return stripAnsi(new TextDecoder("utf-8", { fatal: true }).decode(bytes(fields, field)));
}

function textPart(kind: "text" | "thinking", value: string): TranscriptPart[] {
  return value.trim() ? [{ kind, ...clamp(value, MAX_TEXT_CHARS) }] : [];
}

function stepEntry(idx: number, type: number, payload: Uint8Array): TranscriptEntry | null {
  const step = proto(payload);
  if (step.find((item) => item.field === 1)?.value !== type) return null;
  const meta = proto(bytes(step, 5));
  const time = proto(bytes(meta, 1));
  const seconds = time.find((item) => item.field === 1)?.value;
  const date = typeof seconds === "number" ? new Date(seconds * 1000) : null;
  const ts = date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
  let role: TranscriptEntry["role"] = "assistant";
  let parts: TranscriptPart[] = [];
  if (type === 14) {
    role = "user";
    parts = textPart("text", string(proto(bytes(step, 19)), 2));
  } else if (type === 15) {
    const message = proto(bytes(step, 20));
    // Field 8 repeats the rendered answer. Field 7's calls reappear as tool steps: show each once.
    parts = [...textPart("thinking", string(message, 3)), ...textPart("text", string(message, 1))];
  } else if (type === 23) {
    role = "summary";
    parts = textPart("text", string(proto(bytes(step, 30)), 5));
  } else if (TOOL_STEP_TYPES.has(type)) {
    const call = proto(bytes(meta, 4));
    const name = string(call, 2);
    if (!name) return null;
    const input = string(call, 3);
    let args: JsonValue = input;
    try {
      // SAFETY: JSON.parse returns JSON values; the tool classifier validates their shape.
      args = JSON.parse(input) as JsonValue;
    } catch {
      /* Keep a malformed input as the native string. */
    }
    const summary = summarizeToolInput(args);
    const tool: Extract<TranscriptPart, { kind: "tool" }> = {
      kind: "tool",
      name,
      summary,
      call: classifyToolCall(name, args, summary),
    };
    const id = string(call, 1);
    if (id) tool.id = id;
    const output = string(proto(bytes(proto(bytes(step, 140)), 2)), 1);
    const error = string(proto(bytes(step, 31)), 2);
    if (error) tool.result = { ...clamp(error, MAX_RESULT_CHARS), isError: true };
    else if (output) tool.result = clamp(output, MAX_RESULT_CHARS);
    parts = [tool];
  }
  if (parts.length === 0) return null;
  return { uuid: `agy-${idx}`, ts, role, parts };
}

// 1.3.5 wraps USER_INPUT in a request envelope followed by generated metadata. Only unwrap that
// complete shape; literal tags in ordinary user/assistant text stay verbatim.
function userRequest(content: string): string {
  const open = "<USER_REQUEST>\n";
  const close = "\n</USER_REQUEST>";
  if (!content.startsWith(open)) return content;
  const end = content.lastIndexOf(close);
  if (end < open.length) return content;
  const tail = content.slice(end + close.length);
  if (
    !/^\s*<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>(?:\s*<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>)?\s*$/.test(
      tail,
    )
  ) {
    return content;
  }
  return content.slice(open.length, end);
}

const JSONL_NOTE_TYPES = new Set([
  "GENERIC",
  "VIEW_FILE",
  "RUN_COMMAND",
  "GREP_SEARCH",
  "LIST_DIRECTORY",
  "SEARCH_WEB",
  "ERROR_MESSAGE",
  "CODE_ACTION",
]);

export function createAgyReducer(): RowReducer {
  const unknown = createUnknownCounter({ rows: KNOWN_STEP_ROWS, roles: [], parts: [] });
  const entries = new Map<string, TranscriptEntry>();

  function push(line: string): Reduction {
    try {
      // SAFETY: JSON.parse is an untrusted JSON boundary; every field is checked before use.
      const row = JSON.parse(line) as JsonValue;
      if (row === null || typeof row !== "object" || Array.isArray(row)) return NO_CHANGE;

      // SQLite trajectory step row: `{ idx, type: number, format, payload }`.
      if (typeof row.type === "number") {
        unknown.row(String(row.type));
        if (row.format !== 0) unknown.row(`format:${String(row.format)}`);
        if (
          typeof row.idx !== "number" ||
          !Number.isSafeInteger(row.idx) ||
          row.idx < 0 ||
          row.format !== 0 ||
          typeof row.payload !== "string" ||
          row.payload.length > MAX_STEP_BYTES * 1.34 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(row.payload)
        ) {
          return NO_CHANGE;
        }
        const entry = stepEntry(row.idx, row.type, Buffer.from(row.payload, "base64"));
        return entry ? { added: [entry], changed: [] } : NO_CHANGE;
      }

      // Plaintext `transcript.jsonl` fallback row: `{ step_index, type: string, ... }`.
      unknown.row(row.type);
      if (typeof row.step_index !== "number" || !Number.isSafeInteger(row.step_index) || row.step_index < 0) {
        return NO_CHANGE;
      }
      const role =
        row.type === "USER_INPUT"
          ? "user"
          : row.type === "PLANNER_RESPONSE"
            ? "assistant"
            : typeof row.type === "string" && JSONL_NOTE_TYPES.has(row.type)
              ? "note"
              : undefined;
      if (role === undefined) return NO_CHANGE;
      const parts: TranscriptPart[] = [];
      if (typeof row.content === "string" && row.content.trim() !== "") {
        const content = role === "user" ? userRequest(row.content) : row.content;
        const clipped = clamp(stripAnsi(content), MAX_TEXT_CHARS);
        if (Array.isArray(row.truncated_fields) && row.truncated_fields.includes("content")) clipped.truncated = true;
        parts.push({ kind: "text", ...clipped });
      }
      if (role === "assistant" && Array.isArray(row.tool_calls)) {
        for (const tool of row.tool_calls) {
          if (tool === null || typeof tool !== "object" || Array.isArray(tool) || typeof tool.name !== "string") {
            continue;
          }
          const summary = summarizeToolInput(tool.args);
          parts.push({ kind: "tool", name: tool.name, summary, call: classifyToolCall(tool.name, tool.args, summary) });
        }
      }
      if (parts.length === 0) return NO_CHANGE;
      const uuid = `agy-${row.step_index}`;
      const ts = typeof row.created_at === "string" ? row.created_at : "";
      const previous = entries.get(uuid);
      if (previous !== undefined) {
        previous.parts = parts;
        previous.ts = ts;
        previous.role = role;
        return { added: [], changed: [uuid] };
      }
      const entry: TranscriptEntry = { uuid, ts, role, parts };
      rememberPending(entries, uuid, entry);
      return { added: [entry], changed: [] };
    } catch {
      return NO_CHANGE;
    }
  }

  return { push, queued: noQueue, unknowns: unknown.tally };
}

export function parseAgyTranscript(text: string): TranscriptEntry[] {
  const reducer = createAgyReducer();
  const entries = new Map<string, TranscriptEntry>();
  for (const line of text.split("\n")) {
    for (const entry of reducer.push(line).added) entries.set(entry.uuid, entry);
  }
  return [...entries.values()];
}

type StepRow = { idx: number; type: number; format: number; payload: Uint8Array };

function isJsonlTranscriptPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const match = /\/([0-9a-f-]{36})\/\.system_generated\/logs\/transcript\.jsonl$/i.exec(normalized);
  return match !== null && SESSION_ID.test(match[1]!);
}

/**
 * The database's version, as a string that moves on every commit, or null when it cannot be read.
 * SQLite bumps the file change counter (header bytes 24-27) on every commit in rollback mode. In WAL
 * mode a commit appends frames to `-wal`, so its size grows, and a WAL restart rewrites the WAL
 * header's salts (bytes 16-23). Sizes and mtimes ride along. Two header reads, no SQLite open.
 */
async function dbVersion(path: string): Promise<string | null> {
  const [db, wal] = await Promise.all([statFile(path), statFile(`${path}-wal`)]);
  if (db === null) return null;
  try {
    const head = await Bun.file(path).slice(24, 28).bytes();
    const walHead = wal === null ? new Uint8Array() : await Bun.file(`${path}-wal`).slice(0, 32).bytes();
    return [path, db.size, db.mtimeMs, Buffer.from(head).toString("hex"), wal?.size ?? -1, wal?.mtimeMs ?? -1, Buffer.from(walHead).toString("hex")].join("\u0000");
  } catch {
    return null;
  }
}

export class AgyTranscriptSource implements TranscriptSource {
  readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !SESSION_ID.test(ref.value)) return null;
    for (const root of this.roots) {
      const dbPath = await containedRealpath(join(root, "conversations", `${ref.value}.db`), root);
      if (dbPath !== null && readSqlite(dbPath, (db) => db.query("select idx from steps limit 1").get()) !== null) {
        return dbPath;
      }
      for (const candidate of [
        join(root, "brain", ref.value, ".system_generated", "logs", "transcript.jsonl"),
        join(root, ref.value, ".system_generated", "logs", "transcript.jsonl"),
      ]) {
        const jsonlPath = await containedRealpath(candidate, root);
        if (jsonlPath !== null && (await statFile(jsonlPath)) !== null) return jsonlPath;
      }
    }
    return null;
  }

  private async contained(key: string): Promise<string | null> {
    for (const root of this.roots) {
      if (key.endsWith(".db")) {
        const path = await containedRealpath(key, join(root, "conversations"));
        const id = path?.split(/[/\\]/).pop()?.replace(/\.db$/, "") ?? "";
        if (path !== null && SESSION_ID.test(id)) return path;
      } else if (key.endsWith("transcript.jsonl")) {
        const path = await containedRealpath(key, root);
        if (path !== null && isJsonlTranscriptPath(path)) return path;
      }
    }
    return null;
  }

  async stat(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    const path = await this.contained(key);
    if (path === null) return null;
    if (path.endsWith(".jsonl")) return statFile(path);
    const [db, wal] = await Promise.all([statFile(path), statFile(`${path}-wal`)]);
    return db ? { size: db.size + (wal?.size ?? 0), mtimeMs: Math.max(db.mtimeMs, wal?.mtimeMs ?? 0) } : null;
  }

  private async readDb(path: string, cap: number, limit: number) {
    const meta = await this.stat(path);
    if (meta === null) return null;
    const data = readSqlite(path, (db) => {
      const lines: string[] = [];
      const total = db.query<{ total: number }, []>("select count(*) as total from steps").get()?.total ?? 0;
      let size = 0;
      for (const row of db
        .query<StepRow, [number, number]>(
          "select idx, step_type as type, step_format as format, step_payload as payload from steps where length(step_payload) <= ? order by idx desc limit ?",
        )
        .iterate(MAX_STEP_BYTES, limit)) {
        const line = JSON.stringify({ ...row, payload: Buffer.from(row.payload).toString("base64") });
        size += Buffer.byteLength(line);
        if (size > cap) break;
        lines.push(line);
      }
      lines.reverse();
      return { lines, complete: lines.length === total, ...meta };
    });
    const after = await this.stat(path);
    // An immutable read takes no file lock: discard a snapshot if a native writer moved underneath it.
    return after?.mtimeMs === meta.mtimeMs && after.size === meta.size ? data : null;
  }

  async load(key: string) {
    const path = await this.contained(key);
    if (path === null) return { text: "", complete: true, size: 0, mtimeMs: 0 };
    if (path.endsWith(".jsonl")) return loadTail(path);
    const data = await this.readDb(path, MAX_TRANSCRIPT_BYTES, 10000);
    return data ? { ...data, text: data.lines.join("\n") } : { text: "", complete: true, size: 0, mtimeMs: 0 };
  }

  async readSince(key: string, cursor: Cursor): Promise<ReadSince> {
    const path = await this.contained(key);
    if (path === null) return { lines: [], cursor: cursor || NO_CURSOR, reset: false, fromStart: false };
    if (path.endsWith(".jsonl")) return readSinceFile(path, cursor);
    // THE CURSOR IS A VERSION, NOT A STEP ID. agy rewrites a step in place while it streams (the
    // "in-place streaming edit" test), so a cursor past the newest `idx` would freeze a step at its
    // first written state. What a poll can skip is the read when nothing moved: the cursor is keyed
    // on the database's version (see `dbVersion`), and an unchanged database answers "nothing new"
    // without opening SQLite or re-reducing the tail. Any change still reads the whole bounded tail
    // and resets, which is the one answer that carries an edited step.
    const held: ReadSince = { lines: [], cursor, reset: false, fromStart: false };
    const before = await dbVersion(path);
    if (before === null) return held;
    if (decodeCursor(cursor, "updated", before) !== null) return held;
    const data = await this.readDb(path, FIRST_TAIL_BYTES, FIRST_TAIL_ROWS);
    // The version is read again after the rows: a write between the two keys the cursor to a version
    // these rows may not hold, so it is not kept, and the next poll reads again.
    const after = await dbVersion(path);
    return data
      ? {
          lines: data.lines,
          cursor: after === before ? encodeCursor("updated", before, data.size) : NO_CURSOR,
          reset: true,
          fromStart: data.complete,
        }
      : { lines: [], cursor: cursor || NO_CURSOR, reset: false, fromStart: false };
  }
}

type OpenFiles = (pid: number) => Promise<string>;
const openFiles: OpenFiles = async (pid) =>
  (
    await exec("lsof", ["-nP", "-a", "-p", String(pid), "-Fn"], {
      timeout: 1000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
  ).stdout;

/** Bind to the process-held presence lock, never the newest database in a shared workspace. */
export function agyJournal(roots: string | readonly string[], files: OpenFiles = openFiles): JournalAdapter {
  const source = new AgyTranscriptSource(roots);
  const cache = new Map<number, { at: number; paths: string[] }>();

  async function discover(_cwd: string, hints?: DiscoverHints): Promise<AgentSessionRef | null> {
    for (const proc of hints?.processes ?? []) {
      const name = proc.argv[0]?.split(/[/\\]/).pop()?.replace(/\.exe$/i, "");
      if (name !== "agy" && name !== "antigravity") continue;
      const index = proc.argv.indexOf("--conversation");
      const arg =
        proc.argv.find((value) => value.startsWith("--conversation="))?.slice(15) ??
        (index >= 0 ? proc.argv[index + 1] : undefined);
      if (!proc.pid && arg && SESSION_ID.test(arg)) {
        const ref = { kind: "id" as const, value: arg };
        if (await source.resolve(ref)) return ref;
      }
      if (!proc.pid || !Number.isSafeInteger(proc.pid) || proc.pid <= 0) continue;
      try {
        let held = cache.get(proc.pid);
        if (!held || Date.now() - held.at > 1000) {
          held = {
            at: Date.now(),
            paths: (await files(proc.pid))
              .split("\n")
              .filter((line) => line.startsWith("n"))
              .map((line) => line.slice(1)),
          };
          if (cache.size >= 64) cache.clear();
          cache.set(proc.pid, held);
        }
        for (const root of source.roots) {
          const ids: string[] = [];
          for (const path of held.paths) {
            const id = path.split(/[/\\]/).pop()?.replace(/\.lock$/, "") ?? "";
            if (!path.endsWith(".lock") || !SESSION_ID.test(id)) continue;
            if (await containedRealpath(path, join(root, "presence"))) ids.push(id);
          }
          if (ids.length !== 1) continue;
          const ref = { kind: "id" as const, value: ids[0]! };
          if (await source.resolve(ref)) return ref;
        }
      } catch {
        /* Missing lsof or an exited process leaves the native terminal available. */
      }
    }
    return null;
  }

  return {
    agent: "agy",
    source,
    discover,
    parse: parseAgyTranscript,
    reducer: createAgyReducer,
  };
}
