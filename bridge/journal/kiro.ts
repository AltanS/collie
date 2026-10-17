// Kiro V3 storage: <sessions>/<workspace-set-hash>/<opaque-id>/{session.json,messages.jsonl}.
// V3 describes the storage layout, not schemaVersion: current saved sessions
// use "1.0.0" and dataModelVersion 1. Message rows carry {id,timestamp,payload}.
// The bucket hashes frozen workspacePaths, not the growing rootPaths membership list.
// No cwd/newest-session discovery: several panes can share either list of folders.
// A missing native report can be discovered only through the foreground TUI's V3 lock.
// Only the parent log is read. Child sub-executions and workflow sessions have their
// own histories; the parent's sub_agent_start/complete rows carry its visible cards.

import { opendir, stat as nodeStat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { JsonObject, JsonValue } from "../json.ts";
import { asRecord } from "./cache-probe.ts";
import { decodeCursor, encodeCursor, NO_CURSOR, type Cursor, type ReadSince } from "./cursor.ts";
import { containedRealpath, FIRST_TAIL_BYTES, head, MAX_TRANSCRIPT_BYTES, readSinceFile, rootList, statFile } from "./files.ts";
import { createKiroDiscovery, isKiroSessionId, KIRO_BUCKET } from "./kiro-discovery.ts";
import { createUnknownCounter, NO_CHANGE, noQueue, parseWith, reduction, rememberPending, type Reduction, type RowReducer } from "./reduce.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry, TranscriptPart, TranscriptSource } from "./types.ts";

const MAX_BUCKET_ENTRIES = 4096;
const MAX_METADATA_BYTES = 256 * 1024;
const HISTORY_ROWS = 8192;
const ACP_TOOL_KINDS: ReadonlySet<string> = new Set(["execute", "read", "edit", "search", "fetch", "delete", "move"]);

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
type ToolResult = NonNullable<ToolPart["result"]>;

function text(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function parseObject(line: string): JsonObject | null {
  if (line.length > MAX_TRANSCRIPT_BYTES) return null;
  try {
    // SAFETY: JSON.parse returns JSON values; asRecord checks the object boundary.
    return asRecord(JSON.parse(line) as JsonValue);
  } catch {
    return null;
  }
}

function kiroMeta(payload: JsonObject): JsonObject | null {
  return asRecord(asRecord(payload._meta)?.kiro);
}

function identity(value: JsonValue | undefined): string {
  const valueText = text(value);
  return valueText.length <= 512 ? valueText : "";
}

function toolKey(payload: JsonObject): string {
  return JSON.stringify([identity(payload.subExecutionId), identity(payload.toolCallId)]);
}

function speechPart(content: string, kind: "text" | "thinking" = "text"): TranscriptPart {
  return { kind, ...clamp(stripAnsi(content), MAX_TEXT_CHARS) };
}

// Use Kiro's persisted kind when the shared name table has not met its spelling.
// raw arguments never leave the parser; the classifier receives only capped fields.
function toolPart(payload: JsonObject): ToolPart {
  const args = asRecord(payload.args) ?? {};
  const input: JsonObject = {};
  for (const [key, value] of Object.entries(args).slice(0, 64)) {
    if (typeof value === "string") input[key] = clamp(stripAnsi(value), MAX_TEXT_CHARS).text;
    else if (typeof value === "number" || typeof value === "boolean") input[key] = value;
  }
  if (input.path === undefined && typeof input.file === "string") input.path = input.file;
  if (input.path === undefined && typeof payload.filePath === "string") input.path = clamp(payload.filePath, MAX_TEXT_CHARS).text;
  const name = oneLine(text(payload.toolName)) || "tool";
  const summary = summarizeToolInput(input) || oneLine(text(payload.title));
  const byName = classifyToolCall(name, input, summary);
  // Only ACP's tool kinds fall back, all of them names the shared table knows. Other persisted
  // kind words ("write", "task") are not ACP kinds and must not type an unknown tool.
  const kind = text(payload.kind);
  const byKind = byName.kind === "other" && ACP_TOOL_KINDS.has(kind) ? classifyToolCall(kind, input, summary) : byName;
  return { kind: "tool", id: text(payload.toolCallId), name, summary, call: byKind.kind === "other" ? byName : byKind };
}

interface ToolTarget {
  entry: TranscriptEntry;
  part: ToolPart;
  denied: boolean;
}

interface HistoryRow {
  id: string;
  // An update can change an earlier entry. A checkpoint must undo that change,
  // not merely hide entries created after its boundary.
  undo: () => void;
  touched: readonly string[];
}

function createKiroReducer(): RowReducer {
  const unknown = createUnknownCounter({
    rows: ["user", "assistant", "tool_call", "tool_result", "tool_revert", "system", "agent_note", "error", "mode_change", "session_event", "sub_agent_start", "sub_agent_complete", "sub_agent_progress", "steering_inclusion", "turn_start", "turn_end", "tombstone", "usage_summary", "ContextualHookInvoked", "pending_interaction", "interaction_resolved", "session_metadata", "session_start", "legacy_reasoning_replay", "model_route"],
    roles: [],
    parts: ["Say", "Reasoning", "Print", "Summary"],
  });
  const entriesById = new Map<string, TranscriptEntry>();
  const tools = new Map<string, ToolTarget>();
  const subtasks = new Map<string, ToolTarget>();
  const turnIds = new Map<string, true>();
  const summaries = new Map<string, { entry: TranscriptEntry; executionId: string; tombstoneId: string; active: boolean; nested: boolean }>();
  // Same bounded retention principle as pi's branch chain. Old links fall off;
  // a checkpoint whose target fell outside this window cannot remove its prefix.
  const history: HistoryRow[] = [];
  let previous: JsonObject | undefined;
  let recap: TranscriptEntry | undefined;

  function push(line: string): Reduction {
    const row = parseObject(line);
    const payload = asRecord(row?.payload);
    const id = text(row?.id);
    if (row === null || payload === null || id === "" || id.length > 512) return NO_CHANGE;
    const type = text(payload.type);
    unknown.row(clamp(type, 200).text);
    const changed = new Set<string>();
    const added: TranscriptEntry[] = [];
    const undos: (() => void)[] = [];
    const ts = text(row.timestamp);

    function emit(role: TranscriptEntry["role"], parts: TranscriptPart[]): TranscriptEntry {
      const existing = entriesById.get(id);
      if (existing !== undefined) {
        const oldParts = existing.parts;
        const oldRole = existing.role;
        const oldTs = existing.ts;
        existing.parts = parts;
        existing.role = role;
        existing.ts = ts;
        changed.add(existing.uuid);
        undos.push(() => { existing.parts = oldParts; existing.role = oldRole; existing.ts = oldTs; });
        return existing;
      }
      const entry: TranscriptEntry = { uuid: id, ts, role, parts };
      rememberPending(entriesById, id, entry);
      added.push(entry);
      undos.push(() => { entry.abandoned = true; entriesById.delete(id); });
      return entry;
    }

    function setResult(target: ToolTarget, result: ToolResult): void {
      const oldResult = target.part.result;
      target.part.result = result;
      changed.add(target.entry.uuid);
      undos.push(() => {
        if (oldResult === undefined) delete target.part.result;
        else target.part.result = oldResult;
      });
    }

    function putTool(map: Map<string, ToolTarget>, key: string, target: ToolTarget): void {
      const old = map.get(key);
      rememberPending(map, key, target);
      undos.push(() => { if (old === undefined) map.delete(key); else map.set(key, old); });
    }

    const executionId = type === "session_event" && payload.category === "session_pause"
      ? text(asRecord(payload.context)?.executionId)
      : ["turn_start", "turn_end", "usage_summary"].includes(type) ? text(payload.executionId) : "";
    if (executionId !== "" && executionId.length <= 512) {
      // Nested compactions are dropped before checkpoint reverts are resolved,
      // so even a later-reverted turn marker remains evidence of its scope.
      rememberPending(turnIds, executionId, true);
      for (const candidate of summaries.values()) {
        const nested = !turnIds.has(candidate.executionId);
        candidate.nested = nested;
        if (!candidate.active) continue;
        if (nested === (candidate.entry.abandoned === true)) continue;
        if (nested) candidate.entry.abandoned = true;
        else delete candidate.entry.abandoned;
        changed.add(candidate.entry.uuid);
      }
    }

    if (type === "tombstone" && payload.kind === "checkpoint_revert") {
      const targetId = text(payload.effectiveFromMessageId);
      // A dropped nested compaction takes both of its rows with it.
      const droppedTarget = [...summaries.values()].some((candidate) => candidate.nested &&
        (candidate.entry.uuid === targetId || candidate.tombstoneId === targetId));
      const at = droppedTarget ? -1 : history.findLastIndex((item) => item.id === targetId);
      // An unknown or already-removed target reverts nothing. Do not guess a boundary.
      if (at >= 0) {
        for (const item of history.splice(at).toReversed()) {
          item.undo();
          for (const uuid of item.touched) changed.add(uuid);
        }
      }
      previous = { id, type: payload.type, kind: payload.kind };
      return reduction(added, changed);
    }

    if (type === "user") {
      const meta = kiroMeta(payload);
      // Presence, including malformed values, proves agent-authored provenance.
      // contextItems/documents are model attachments, never the user's speech.
      if (meta === null || !Object.hasOwn(meta, "syntheticUserMessageReason")) {
        const content = typeof meta?.displayText === "string" ? meta.displayText : text(payload.content);
        const notification = meta?.notification !== undefined || payload.kind !== undefined ||
          (payload.source === "steer" && /^\s*\[notification\/(info|success|warning|error)\]/.test(content));
        const parts: TranscriptPart[] = content === "" ? [] : [speechPart(content)];
        if (Array.isArray(payload.images) && payload.images.length > 0) parts.push(speechPart("[image attached]"));
        if (Array.isArray(payload.documents) && payload.documents.length > 0) parts.push(speechPart("[document attached]"));
        if (parts.length > 0) emit(notification ? "note" : "user", parts);
      }
    } else if (type === "assistant") {
      unknown.part(clamp(text(payload.operationType), 200).text);
      const operation = text(payload.operationType);
      const content = text(payload.content);
      // Never expose signatures, redacted envelopes, summaryReasoning or msg0.
      if (content !== "" && !(operation === "Reasoning" && content === "...") &&
          ["", "Say", "Print", "Summary", "Reasoning"].includes(operation)) {
        const entry = emit(operation === "Summary" ? "summary" : "assistant", [speechPart(content, operation === "Reasoning" ? "thinking" : "text")]);
        const summaryExecution = text(payload.executionId);
        if (operation === "Summary" && summaryExecution !== "" && summaryExecution.length <= 512 && previous?.type === "tombstone" && previous.kind === "summarization") {
          const candidate = { entry, executionId: summaryExecution, tombstoneId: text(previous.id), active: true, nested: turnIds.size > 0 && !turnIds.has(summaryExecution) };
          rememberPending(summaries, id, candidate);
          if (candidate.nested) entry.abandoned = true;
          undos.push(() => { candidate.active = false; });
        }
      }
    } else if (type === "tool_call" && identity(payload.toolCallId) !== "" && text(payload.subExecutionId).length <= 512 && text(payload.toolName) !== "" && asRecord(payload.args) !== null && ["pending", "awaiting_approval", "approved", "denied", "executing", "completed", "failed"].includes(text(payload.status))) {
      const key = toolKey(payload);
      const part = toolPart(payload);
      const denied = payload.status === "denied" || asRecord(kiroMeta(payload)?.policyDenial)?.effect === "deny";
      let target = tools.get(key);
      if (target !== undefined) {
        const old = target;
        const saved = { ...old.part };
        const oldDenied = old.denied;
        Object.assign(old.part, part);
        old.denied = denied;
        undos.push(() => { Object.assign(old.part, saved); old.denied = oldDenied; });
        changed.add(old.entry.uuid);
      } else {
        target = { entry: emit("assistant", [part]), part, denied };
        putTool(tools, key, target);
      }
      if (denied || payload.status === "failed") setResult(target, { ...target.part.result, text: target.part.result?.text ?? "", ...(denied ? { denied: true } : { isError: true }) });
    } else if (type === "tool_result" && identity(payload.toolCallId) !== "" && text(payload.subExecutionId).length <= 512 && typeof payload.content === "string" && typeof payload.success === "boolean") {
      const key = toolKey(payload);
      const target = tools.get(key);
      // Older revert badges reuse tool_result. They must not overwrite output.
      if (asRecord(payload.metadata)?.reverted !== true) {
        const result: ToolResult = clamp(stripAnsi(payload.content), MAX_RESULT_CHARS);
        if (!payload.success) result.isError = true;
        if (target?.denied === true) result.denied = true;
        if (target !== undefined) setResult(target, result);
        else {
          const part: ToolPart = { kind: "tool", id: text(payload.toolCallId), name: "result", summary: "", result };
          putTool(tools, key, { entry: emit("assistant", [part]), part, denied: false });
        }
      }
    } else if (type === "sub_agent_start" && identity(payload.subSessionId) !== "") {
      const part: ToolPart = { kind: "tool", id, name: "subagent", summary: oneLine(text(payload.explanation)), call: { kind: "task", agent: oneLine(text(payload.subAgentName)), summary: oneLine(text(payload.explanation)) } };
      putTool(subtasks, text(payload.subSessionId), { entry: emit("assistant", [part]), part, denied: false });
    } else if (type === "sub_agent_complete") {
      const target = subtasks.get(text(payload.subSessionId));
      const content = text(payload.response) || text(payload.errorMessage);
      const result: ToolResult = clamp(stripAnsi(content), MAX_RESULT_CHARS);
      if (payload.status === "error" || payload.status === "cancelled") result.isError = true;
      if (target !== undefined) setResult(target, result);
      else if (content !== "") emit("note", [speechPart(content)]);
    } else if (type === "session_metadata") {
      const value = asRecord(payload.value);
      const key = text(payload.key);
      if (key === "displayError" && text(value?.message) !== "") emit("note", [speechPart(text(value?.message))]);
      if (key === "summaryMessage" && text(value?.content) !== "") emit("summary", [speechPart(text(value?.content))]);
      if (key === "recap" && text(value?.text) !== "") {
        const old = recap;
        if (old !== undefined) { old.abandoned = true; changed.add(old.uuid); }
        recap = emit("note", [speechPart(text(value?.text))]);
        undos.push(() => { recap = old; if (old !== undefined) { delete old.abandoned; } });
      }
    } else if (type === "model_route" && text(payload.notification) !== "") {
      emit("note", [speechPart(text(payload.notification))]);
    }
    // Everything else is intentionally silent, just as client replay is: system,
    // agent_note, steering bodies, lifecycle/usage state and raw error details.
    previous = { id, type: payload.type, kind: payload.kind };
    history.push({ id, touched: [...new Set([...changed, ...added.map((entry) => entry.uuid)])], undo: () => { for (const undo of undos.toReversed()) undo(); } });
    if (history.length > HISTORY_ROWS) history.shift();
    return reduction(added, changed);
  }

  return { push, unknowns: unknown.tally, queued: noQueue };
}

interface LocatedSession {
  root: string;
  path: string;
  id: string;
}

interface ReadAnchor {
  first: string;
  last: string;
  size: number;
  mtimeMs: number;
}

class KiroTranscriptSource implements TranscriptSource {
  private readonly roots: string[];
  private readonly sessions = new Map<string, LocatedSession>();
  private readonly paths = new Map<string, LocatedSession>();
  private readonly anchors = new Map<Cursor, ReadAnchor>();

  constructor(roots: readonly string[]) {
    this.roots = rootList(roots).filter(isAbsolute).slice(0, 32);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isKiroSessionId(ref.value)) return null;
    const cached = this.sessions.get(ref.value);
    if (cached !== undefined && await this.checked(cached).catch(() => null) !== null) {
      rememberPending(this.paths, cached.path, cached);
      return cached.path;
    }
    this.sessions.delete(ref.value);
    for (const root of this.roots) {
      // opendir streams entries; readdir would allocate an unbounded root listing.
      const realRoot = await containedRealpath(root, root);
      if (realRoot === null) continue;
      try {
        const directory = await opendir(realRoot);
        let visited = 0;
        for await (const bucket of directory) {
          if (++visited > MAX_BUCKET_ENTRIES) break;
          if (!KIRO_BUCKET.test(bucket.name) || bucket.name.trim() !== bucket.name) continue;
          const located = { root, id: ref.value, path: join(root, bucket.name, ref.value, "messages.jsonl") };
          if (await this.checked(located).catch(() => null) === null) continue;
          rememberPending(this.sessions, ref.value, located);
          rememberPending(this.paths, located.path, located);
          return located.path;
        }
      } catch {
        // Missing/inaccessible root is an ordinary absent session, not a fallback.
      }
    }
    return null;
  }

  private async checked(located: LocatedSession): Promise<string | null> {
    const sessionDir = dirname(located.path);
    if (await containedRealpath(sessionDir, located.root) === null) return null;
    const metadata = await containedRealpath(join(sessionDir, "session.json"), located.root);
    if (metadata === null || await containedRealpath(metadata, sessionDir) === null) return null;
    const stamp = await nodeStat(metadata);
    if (!stamp.isFile() || stamp.size > MAX_METADATA_BYTES) return null;
    // Bounded even when metadata grows between the size probe and read.
    const parsed = parseObject(await head(metadata, MAX_METADATA_BYTES + 1));
    if (parsed?.id !== located.id || parsed.schemaVersion !== "1.0.0" || !Array.isArray(parsed.workspacePaths) || !parsed.workspacePaths.every((value) => typeof value === "string")) return null;
    const real = await containedRealpath(located.path, located.root);
    if (real === null || await containedRealpath(real, sessionDir) === null) return null;
    // Bun.file can also name a special file; never read a pipe/device as a log.
    return (await nodeStat(real)).isFile() ? real : null;
  }

  private async readable(path: string): Promise<string | null> {
    const located = this.paths.get(path);
    if (located === undefined) return null;
    try { return await this.checked(located); } catch { return null; }
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const real = await this.readable(path);
    return real === null ? null : statFile(real);
  }

  async load(path: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
    const real = await this.readable(path);
    if (real === null) throw new Error("Kiro session is unavailable");
    const stamp = await statFile(real);
    if (stamp === null) throw new Error("Kiro session is unavailable");
    // Use the shared row-boundary reader for History too: a valid JSON object
    // without its final newline can still be an unfinished append.
    const tail = await readSinceFile(real, NO_CURSOR, MAX_TRANSCRIPT_BYTES);
    return { text: tail.lines.join("\n"), complete: tail.fromStart, ...stamp };
  }

  private async anchor(path: string, position: number): Promise<ReadAnchor | null> {
    const real = await this.readable(path);
    if (real === null) return null;
    const file = Bun.file(real);
    const first = await file.slice(0, Math.min(position, 256)).text();
    // Re-check before the second disk read, including paths previously resolved.
    const again = await this.readable(path);
    if (again === null) return null;
    const last = await Bun.file(again).slice(Math.max(0, position - 256), position).text();
    const stamp = await statFile(again);
    return stamp === null ? null : { first, last, ...stamp };
  }

  async readSince(path: string, cursor: Cursor): Promise<ReadSince> {
    const absent: ReadSince = { lines: [], cursor, reset: false, fromStart: false };
    try {
      const real = await this.readable(path);
      if (real === null) return absent;
      const st = await nodeStat(real).catch(() => null);
      if (st === null) return absent;
      // A replacement file can be larger than the old one. File identity catches
      // that case; boundary samples catch ordinary in-place rewrites of the log.
      const fileIdentity = `${path}\0${st.dev}:${st.ino}:${st.birthtimeMs}`;
      const position = decodeCursor(cursor, "bytes", fileIdentity);
      const held = this.anchors.get(cursor);
      let resume = NO_CURSOR;
      if (position !== null && held !== undefined && position <= st.size &&
          !(st.size <= held.size && st.mtimeMs !== held.mtimeMs)) {
        const current = await this.anchor(path, position);
        if (current?.first === held.first && current?.last === held.last) resume = encodeCursor("bytes", real, position);
      }
      const checked = await this.readable(path);
      if (checked === null) return absent;
      const result = await readSinceFile(checked, resume, FIRST_TAIL_BYTES);
      const next = decodeCursor(result.cursor, "bytes", checked);
      if (next === null) return absent;
      const nextCursor = encodeCursor("bytes", fileIdentity, next);
      const sample = await this.anchor(path, next);
      if (sample !== null) rememberPending(this.anchors, nextCursor, sample);
      return { ...result, cursor: nextCursor };
    } catch {
      return absent;
    }
  }
}

/** Read-only Kiro V3 journal for explicitly configured sessions roots, normally ~/.kiro/sessions. */
export function kiroJournal(roots: readonly string[]): JournalAdapter {
  const source = new KiroTranscriptSource(roots);
  return { agent: "kiro", source, discover: createKiroDiscovery(roots, source), parse: (input): TranscriptEntry[] => parseWith(createKiroReducer(), input), reducer: createKiroReducer };
}
