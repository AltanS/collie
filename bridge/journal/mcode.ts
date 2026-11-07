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
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { processStartMs } from "./process-start.ts";
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
} from "./reduce.ts";import { containedRealpath, loadTail, readSinceFile, rootList, statFile } from "./files.ts";
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

/** MiniMax Code names sessions `mvs_<hex-or-base64url>`. */
/**
 * execFile as a promise, typed for the one call this file makes (no overloads) so tests can spy on
 * node:child_process. Bound at each call so a spy on the module is the one that runs.
 */
const runLsof = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number; windowsHide?: boolean },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    // SAFETY: runLsof takes readonly so callers can pass frozen arrays; execFile's type wants string[].
    execFile(file, args as string[], options ?? {}, (err, stdout, stderr) => {
      if (err) reject(err);
      else {
        // SAFETY: the mock in tests passes { stdout } objects; a real lsof passes a Buffer.
        const out =
          typeof stdout === "object" && stdout !== null && "stdout" in stdout
            ? String((stdout as { stdout: unknown }).stdout ?? "")
            : String(stdout ?? "");
        resolve({ stdout: out, stderr: String(stderr ?? "") });
      }
    });
  });

/** The log files a live mcode process may hold open, each naming the session it is writing. */
const OPEN_SESSION_PATHS: readonly { pattern: RegExp; decode?: boolean }[] = [
  // The observability log: the raw session id sits in the path itself.
  { pattern: /\/logs\/sessions\/(mvs_[0-9a-f]+)\// },
  // The transcript: the folder suffix is the base64url of the id, which decodes to it.
  { pattern: /-session_([A-Za-z0-9_-]+)\/messages\.jsonl/, decode: true },
];

/** The session ids these open-file paths name, decoded and shape-checked. */
function sessionIdsOfPaths(paths: readonly string[]): string[] {
  const ids: string[] = [];
  for (const path of paths) {
    for (const { pattern, decode } of OPEN_SESSION_PATHS) {
      const match = pattern.exec(path);
      const captured = match?.[1];
      if (captured === undefined) continue;
      // SAFETY: base64url of an mvs_ id decodes to the id itself; the shape check guards it.
      const id = decode ? Buffer.from(captured, "base64url").toString("utf8") : captured;
      if (isMcodeSessionId(id)) ids.push(id);
    }
  }
  return ids;
}

const SESSION_ID_RE = /^mvs_[0-9a-zA-Z_-]+$/;
export function isMcodeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** How the pane's mcode process was told to pick its session. */
export type McodeStartIntent =
  | { kind: "resume_id"; sessionId: string }
  | { kind: "resume_picker" }
  | { kind: "continue" }
  | { kind: "fresh" };

/**
 * The execution intent of one mcode argv, as far as the flags say. PURE — no fs, no clock. A bare
 * `--session` / `--resume` (or one followed by another flag) opens the picker; `-c` / `--continue`
 * means the newest session in the folder; no flag means mcode starts a fresh session that only
 * exists once the first prompt is submitted.
 */
export function parseMcodeArgv(argv: readonly string[]): McodeStartIntent {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-c" || arg === "--continue") return { kind: "continue" };
    if (arg === "--session" || arg === "--resume") {
      const next = argv[i + 1];
      if (next !== undefined && next !== "" && !next.startsWith("-")) {
        return isMcodeSessionId(next) ? { kind: "resume_id", sessionId: next } : { kind: "resume_picker" };
      }
      return { kind: "resume_picker" };
    }
    for (const flag of ["--session=", "--resume="]) {
      if (arg?.startsWith(flag)) {
        const id = arg.slice(flag.length);
        return isMcodeSessionId(id) ? { kind: "resume_id", sessionId: id } : { kind: "resume_picker" };
      }
    }
  }
  return { kind: "fresh" };
}

/**
 * When the mcode process started, read first from mcode's own active-process marker
 * (`~/.minimax-code/.mcode-active/<pid>.json`), then from the platform source. Null when neither
 * answers, in which case the caller fails closed.
 */
export async function readActiveFileStartMs(
  pid: number,
  startMsReader: (pid: number) => Promise<number | null> = processStartMs,
): Promise<number | null> {
  try {
    const text = await readFile(join(homedir(), ".minimax-code", ".mcode-active", `${pid}.json`), "utf8");
    // SAFETY: JSON.parse of active process file returns arbitrary JSON values.
    const parsed: JsonValue = JSON.parse(text) as JsonValue;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      // SAFETY: parsed is checked to be non-null object and non-array above.
      const start = (parsed as JsonObject).startedAtMs;
      if (typeof start === "number" && Number.isFinite(start) && start > 0) return start;
    }
  } catch {
    // Fall through to the platform reader.
  }
  return startMsReader(pid);
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
      let raw = contentText(message.content);
      // The envelope carries injected plumbing (system reminders, plugin hooks) beside the operator's
      // own words; `canonicalTextRange` is mcode's own mark of where the spoken text sits in it. A
      // range that does not land inside the text is ignored, not trusted.
      const range = message.canonicalTextRange;
      if (
        range !== null &&
        typeof range === "object" &&
        !Array.isArray(range) &&
        typeof range.startOffset === "number" &&
        typeof range.endOffset === "number" &&
        range.startOffset >= 0 &&
        range.endOffset <= raw.length &&
        range.startOffset < range.endOffset
      ) {
        raw = raw.slice(range.startOffset, range.endOffset);
      }
      const text = stripAnsi(raw).trim();
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

  private readonly startMsReader: (pid: number) => Promise<number | null>;

  constructor(roots: string | readonly string[], startMsReader?: (pid: number) => Promise<number | null>) {
    this.roots = rootList(roots);
    this.startMsReader = startMsReader ?? processStartMs;
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
   * The session the pane's foreground mcode process is writing, resolved through a four-tier
   * pipeline: an open session file (`lsof`), the process's argv intent, the index bounded by the
   * process start, and finally the index bounded to the last five minutes when no process is
   * known. A fresh mcode waiting for its first prompt answers null, so no pane ever inherits a
   * past session.
   */
  async discoverSession(cwd: string, hints?: DiscoverHints): Promise<AgentSessionRef | null> {
    const targetProcs = (hints?.processes ?? []).filter((p) => {
      const name = p.argv[0]?.split(/[/\\]/).pop()?.replace(/\.exe$/i, "");
      return name === "mcode" || name === "minimax-code" || name === "node";
    });
    const pids = targetProcs
      .map((p) => p.pid)
      .filter((pid): pid is number => pid !== undefined && Number.isSafeInteger(pid) && pid > 0);
    if (pids.length > 0) {
      // Tier 1: a session file a target process holds open names the session outright.
      for (const pid of pids) {
        const { stdout } = await runLsof("lsof", ["-nP", "-p", String(pid), "-g", String(pid), "-Fn"], {
          timeout: 1000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        }).catch(() => ({ stdout: "" }));
        const paths = stdout
          .split("\n")
          .filter((line) => line.startsWith("n"))
          .map((line) => line.slice(1));
        for (const id of sessionIdsOfPaths(paths)) {
          const ref: AgentSessionRef = { kind: "id", value: id };
          if ((await this.resolve(ref)) !== null) return ref;
        }
      }
      // Tier 2: the argv says what the process meant to do, and the index answers only within it.
      const intents = targetProcs.map((p) => parseMcodeArgv(p.argv));
      for (const intent of intents) {
        if (intent.kind !== "resume_id") continue;
        const ref: AgentSessionRef = { kind: "id", value: intent.sessionId };
        if ((await this.resolve(ref)) !== null) return ref;
      }
      if (intents.some((i) => i.kind === "resume_picker")) return null;
      if (cwd.trim() === "") return null;
      if (intents.some((i) => i.kind === "continue")) {
        // --continue means the newest session in this folder, however old it is.
        for (const root of this.roots) {
          const indexed = await this.fromSqlite(root, cwd);
          if (indexed !== null) {
            const ref: AgentSessionRef = { kind: "id", value: indexed };
            if ((await this.resolve(ref)) !== null) return ref;
          }
        }
        return null;
      }
      // Fresh mcode: the session only exists once the first prompt lands, so the index may only
      // name a session created or updated since the process started (with a small slack). With no
      // readable start time, fail closed — never a past session.
      const starts = await Promise.all(pids.map((pid) => readActiveFileStartMs(pid, this.startMsReader)));
      const valid = starts.filter((s): s is number => s !== null);
      if (valid.length === 0) return null;
      const sinceMs = Math.min(...valid) - 5000;
      for (const root of this.roots) {
        const indexed = await this.fromSqlite(root, cwd, { sinceMs });
        if (indexed !== null) {
          const ref: AgentSessionRef = { kind: "id", value: indexed };
          if ((await this.resolve(ref)) !== null) return ref;
        }
      }
      return null;
    }
    // Tier 3: no process hints — the multiplexer fallback, five minutes only.
    if (hints?.shared === true) return null;
    if (cwd.trim() === "") return null;
    const maxAgeMs = 300_000;
    for (const root of this.roots) {
      const indexed = await this.fromSqlite(root, cwd, { maxAgeMs });
      if (indexed !== null) {
        const ref: AgentSessionRef = { kind: "id", value: indexed };
        if ((await this.resolve(ref)) !== null) return ref;
      }
    }
    return null;
  }

  /**
   * The newest unarchived session the index lists for `cwd`, or null. Read-only; never writes.
   *
   * mcode sets `status` to `idle` between turns and through most active use, so the status filter
   * reads the whole live set. The window is `maxAgeMs` over `updated_at_ms` OR `created_at_ms`:
   * a long session updated recently and a fresh one both count, a stale row does not.
   */
  private async fromSqlite(
    root: string,
    cwd: string,
    options?: { sinceMs?: number; maxAgeMs?: number },
  ): Promise<string | null> {
    const dbPath = join(root, "..", "sqlite", "runtime-state.sqlite");
    let db: Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      return null;
    }
    try {
      // `sinceMs` answers "since this process started"; `maxAgeMs` answers "recently"; neither
      // answers "whatever is newest", which is what --continue wants.
      const since = options?.sinceMs ?? (options?.maxAgeMs !== undefined ? Date.now() - options.maxAgeMs : null);
      const sql = since === null
        ? "SELECT session_id FROM local_runtime_sessions WHERE workspace_dir = ? AND archived = 0 AND status IN ('idle', 'started', 'running', 'interrupted') ORDER BY updated_at_ms DESC LIMIT 1"
        : "SELECT session_id FROM local_runtime_sessions WHERE workspace_dir = ? AND archived = 0 AND (updated_at_ms > ? OR created_at_ms > ?) AND status IN ('idle', 'started', 'running', 'interrupted') ORDER BY updated_at_ms DESC LIMIT 1";
      // SAFETY: `bun:sqlite`'s `.get` is typed as unknown rows; the SELECT names exactly the one
      // column this cast reads, and the shape check guards it.
      const row = (
        since === null ? db.query(sql).get(cwd) : db.query(sql).get(cwd, since, since)
      ) as { session_id?: unknown } | null;
      const id = row?.session_id;
      return typeof id === "string" && isMcodeSessionId(id) ? id : null;
    } catch {
      return null;
    } finally {
      db.close();
    }
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
    discover: (cwd, hints) => source.discoverSession(cwd, hints),
  };
}
