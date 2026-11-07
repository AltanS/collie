// MiniMax Code's (`mcode`, `@minimax-ai/code`) journal adapter.
//
// SHAPE OF THE SOURCE (verified against on-disk sessions, 2026-11-07):
//   $MINIMAX_HOME/v2/sessions/YYYY/MM/DD/HH-mm-ss-SSS-session_<base64url(sessionId)>/
//     manifest.json   — session metadata, { sessionId, createdAtMs, updatedAtMs, paths }
//     messages.jsonl  — the transcript
// plus a metadata database at $MINIMAX_HOME/v2/sqlite/runtime-state.sqlite, table
// `local_runtime_sessions`, which maps session_id → workspace_dir and history_relative_dir.
//
// messages.jsonl rows are Anthropic-Messages-shaped envelopes:
//   {"message_id":"msg-…","turn_id":"…","message":{ "role":"user"|"assistant"|"toolResult",
//     "content":[{type:"text",text}|{type:"thinking",thinking}|{type:"toolCall",id,name,arguments}],
//     "timestamp":<ms>, … }}
// A toolResult row carries { toolCallId, toolName, content, isError } and folds onto the call.
//
// WHERE THE SESSION COMES FROM: mcode panes report no session Herdr keeps, so the adapter
// discovers it — first through the SQLite index (workspace_dir = cwd, not archived, newest), then
// through the newest messages.jsonl under the roots. The disk walk cannot tell two panes in one
// folder apart, so it is the fallback, not the answer.

import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import {
  parseWith,
  createUnknownCounter,
  type KnownTypes,
  NO_CHANGE,
  noQueue,
  type PendingTool,
  reduction,
  type Reduction,
  rememberPending,
  type RowReducer,
} from "./reduce.ts";import { containedRealpath, exists, loadTail, readSinceFile, rootList, statFile } from "./files.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** MiniMax Code names sessions `mvs_<hex-or-base64url>`. */
const SESSION_ID_RE = /^mvs_[0-9a-zA-Z_-]+$/;

export function isMcodeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** The session folder's suffix for a session id, as mcode writes it: base64url of the id. */
function sessionDirSuffix(sessionId: string): string {
  // SAFETY: Buffer.from of a validated id always encodes; base64url emits no path separators.
  return `session_${Buffer.from(sessionId).toString("base64url")}`;
}

/**
 * Every row type this adapter has MET, rendered or dropped (see reduce.ts). The row `type` here is
 * the envelope's `message.role`, so the role list is what the counter is asked.
 */
const MCODE_KNOWN: KnownTypes = {
  rows: ["user", "assistant", "toolResult"],
  roles: [],
  parts: ["text", "thinking", "toolCall"],
};

/** Flatten the content blocks of a user or toolResult row into plain text. */
function contentText(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b !== null && typeof b === "object" && !Array.isArray(b) && typeof b.text === "string"
        ? b.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Report a content block's type to the unknown counter, at the read like every other row. */
function noteBlocks(tally: ReturnType<typeof createUnknownCounter>, content: JsonValue | undefined): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block !== null && typeof block === "object" && !Array.isArray(block)) {
      // SAFETY: the guard above narrowed the block to an object; `.type` is read as a field of it.
      const b: JsonObject = block;
      tally.part(typeof b.type === "string" ? b.type : "?");
    }
  }
}

/** One `messages.jsonl` line, once JSON.parse has admitted it is an object at all. */
type McodeRow = JsonObject;

/**
 * Parse a MiniMax Code `messages.jsonl` into oldest-first turns. PURE — no fs, no clock.
 * Unparseable lines are skipped (live append, tail-read window).
 */
export function parseMcodeTranscript(text: string): TranscriptEntry[] {
  return parseWith(createMcodeReducer(), text);
}

export function createMcodeReducer(): RowReducer {
  // `toolCall.id` → the part awaiting its result and the turn it went out in.
  const pendingTools = new Map<string, PendingTool>();
  const unknown = createUnknownCounter(MCODE_KNOWN);

  function push(line: string): Reduction {
    const entries: TranscriptEntry[] = [];
    const changed = new Set<string>();
    if (line.trim() === "") return NO_CHANGE;
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction — naming it keeps every field
      // read below a checked property access.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      return NO_CHANGE;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return NO_CHANGE;
    const row: McodeRow = parsed;
    const envelope = row.message;
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return NO_CHANGE;
    const message: JsonObject = envelope;
    const role = message.role;
    // At the READ, not in the branch that declined (reduce.ts § `createUnknownCounter`).
    unknown.row(role);
    noteBlocks(unknown, message.content);
    const uuid = typeof row.message_id === "string" && row.message_id !== "" ? row.message_id : "";

    if (role === "user") {
      const text = stripAnsi(contentText(message.content)).trim();
      if (text === "") return NO_CHANGE;
      entries.push({ uuid, ts: "", role: "user", parts: [{ kind: "text", ...clamp(text, MAX_TEXT_CHARS) }] });
      return reduction(entries, changed);
    }

    if (role === "assistant") {
      const parts: TranscriptPart[] = [];
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block === null || typeof block !== "object" || Array.isArray(block)) continue;
        const b: JsonObject = block;
        if (b.type === "thinking" && typeof b.thinking === "string") {
          const held = stripAnsi(b.thinking);
          if (held.trim() !== "") parts.push({ kind: "thinking", ...clamp(held, MAX_TEXT_CHARS) });
        } else if (b.type === "text" && typeof b.text === "string") {
          const body = stripAnsi(b.text);
          if (body.trim() !== "") parts.push({ kind: "text", ...clamp(body, MAX_TEXT_CHARS) });
        } else if (b.type === "toolCall") {
          const name = typeof b.name === "string" ? b.name : "tool";
          const input = b.arguments;
          const summary = summarizeToolInput(input);
          const part: Extract<TranscriptPart, { kind: "tool" }> = {
            kind: "tool",
            name,
            summary,
            call: classifyToolCall(name, input, summary),
          };
          if (typeof b.id === "string") {
            part.id = b.id;
            rememberPending(pendingTools, b.id, { part, uuid });
          }
          parts.push(part);
        }
      }
      if (parts.length === 0) return reduction(entries, changed);
      entries.push({ uuid, ts: isoOf(message.timestamp), role: "assistant", parts });
      return reduction(entries, changed);
    }

    if (role === "toolResult") {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const resultText = stripAnsi(contentText(message.content));
      const isError = message.isError === true;
      const target = pendingTools.get(id);
      if (target) {
        pendingTools.delete(id);
        target.part.result = { ...clamp(resultText, MAX_RESULT_CHARS) };
        if (isError) target.part.result.isError = true;
        changed.add(target.uuid);
      } else if (resultText.trim() !== "") {
        entries.push({
          uuid,
          ts: isoOf(message.timestamp),
          role: "assistant",
          parts: [{ kind: "tool", name: "result", summary: "", result: { ...clamp(resultText, MAX_RESULT_CHARS) } }],
        });
      }
    }

    return reduction(entries, changed);
  }

  // No queue in this format's log: see `RowReducer.queued`.
  return { push, unknowns: unknown.tally, queued: noQueue };
}

/** A millisecond timestamp as an ISO string, or "" when the row names none. */
function isoOf(value: JsonValue | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/**
 * Scan `$MINIMAX_HOME/v2/sessions/YYYY/MM/DD/HH-mm-ss-SSS-session_<base64url>/messages.jsonl`.
 * The folder suffix is the base64url of the session id, so the lookup is a name match at one depth,
 * not a content read. The manifest is not trusted for identity — the folder name is.
 */
export class McodeTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();

  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isMcodeSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      // The cache memoises the scan, not the containment verdict: `exists` follows a symlink, so a
      // file replaced by an outward link after the first resolve would otherwise be served.
      const real = await containedRealpath(cached, rootOf(cached, this.roots));
      if (real !== null) {
        if (real !== cached) this.pathCache.set(sessionId, real);
        return real;
      }
      this.pathCache.delete(sessionId);
    }
    for (const root of this.roots) {
      const hit = await this.findUnder(root, sessionId);
      if (hit === null) continue;
      this.pathCache.set(sessionId, hit);
      return hit;
    }
    return null;
  }

  private async findUnder(root: string, sessionId: string): Promise<string | null> {
    const suffix = sessionDirSuffix(sessionId);
    for (const year of await descending(root)) {
      for (const month of await descending(join(root, year))) {
        for (const day of await descending(join(root, year, month))) {
          const dir = join(root, year, month, day);
          let names: string[];
          try {
            names = await readdir(dir);
          } catch {
            continue;
          }
          const hit = names.find((n) => n.endsWith(suffix));
          if (hit === undefined) continue;
          return containedRealpath(join(dir, hit, "messages.jsonl"), root);
        }
      }
    }
    return null;
  }

  /**
   * The session running in `cwd`. First the SQLite index mcode itself keeps, read-only: the newest
   * unarchived session whose workspace_dir is the pane's folder, resolved through the
   * `history_relative_dir` the row names. Then the disk walk's newest `messages.jsonl`, which
   * cannot tell two panes in one folder apart — the index is the answer, the walk the fallback.
   */
  async discoverSession(cwd: string): Promise<AgentSessionRef | null> {
    if (cwd.trim() === "") return null;
    for (const root of this.roots) {
      const indexed = await this.fromSqlite(root, cwd);
      if (indexed !== null) {
        const ref: AgentSessionRef = { kind: "id", value: indexed };
        if ((await this.resolve(ref)) !== null) return ref;
      }
    }
    for (const root of this.roots) {
      const newest = await this.newestUnder(root);
      if (newest === null) continue;
      return { kind: "id", value: newest };
    }
    return null;
  }

  /** The newest unarchived session the index lists for `cwd`, or null. Read-only; never writes. */
  private async fromSqlite(root: string, cwd: string): Promise<string | null> {
    const dbPath = join(root, "..", "sqlite", "runtime-state.sqlite");
    let db: Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      return null;
    }
    try {
      // SAFETY: `bun:sqlite`'s `.get` is typed as unknown rows; the SELECT names exactly the one
      // column this cast reads, and the shape check guards it.
      const row = db
        .query(
          "SELECT session_id FROM local_runtime_sessions WHERE workspace_dir = ? AND archived = 0 ORDER BY updated_at_ms DESC LIMIT 1",
        )
        .get(cwd) as { session_id?: unknown } | null;
      const id = row?.session_id;
      return typeof id === "string" && isMcodeSessionId(id) ? id : null;
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  /** The newest `messages.jsonl` under `root`, by folder-name time, as its session id. Bounded. */
  private async newestUnder(root: string): Promise<string | null> {
    const MAX_CANDIDATES = 500;
    let seen = 0;
    for (const year of await descending(root)) {
      for (const month of await descending(join(root, year))) {
        for (const day of await descending(join(root, year, month))) {
          const dir = join(root, year, month, day);
          let names: string[];
          try {
            names = await readdir(dir);
          } catch {
            continue;
          }
          // Newest first, and the folder name IS the time mcode sorts by: the first candidate
          // whose messages.jsonl exists is the answer. The caps bound the worst case.
          for (const name of names.toSorted((a, b) => (a < b ? 1 : a > b ? -1 : 0))) {
            seen += 1;
            if (seen > MAX_CANDIDATES) return null;
            const mark = name.lastIndexOf("-session_");
            if (mark === -1) continue;
            // SAFETY: base64url of an mvs_ id decodes to the id itself; the shape check guards it.
            const id = Buffer.from(name.slice(mark + "-session_".length), "base64url").toString("utf8");
            if (!isMcodeSessionId(id)) continue;
            if (await exists(join(dir, name, "messages.jsonl"))) return id;
          }
        }
      }
    }
    return null;
  }

  stat = statFile;

  load = loadTail;

  /** The live read, byte-counted like every harness that writes a JSONL file. */
  readSince = readSinceFile;
}

/** The root a cached path was resolved through — the one that may still contain it. */
function rootOf(cached: string, roots: readonly string[]): string {
  return roots.find((root) => cached.startsWith(root)) ?? cached;
}

/** Directory entries, newest-name first. Empty when the directory doesn't exist. */
async function descending(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).toSorted((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  } catch {
    return [];
  }
}

export function mcodeJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new McodeTranscriptSource(roots);
  return {
    agent: "mcode",
    source,
    parse: parseMcodeTranscript,
    reducer: createMcodeReducer,
    discover: (cwd) => source.discoverSession(cwd),
  };
}
