// Kiro V3's session rows, read into transcript entries, and the Kiro journal adapter.
//
// A session's messages.jsonl holds one row per line, each {id, timestamp, payload}. Each tool call
// is one row with its final status, then one result row; no row is rewritten. A sub-agent's
// sub_agent_start/complete rows carry its card. /rewind forks into a new session and /compact
// appends a summary, so neither changes rows already read. Observed on kiro-cli 2.32.0
// (fixtures/kiro/README.md says how the fixtures were made).
//
// Where the sessions live and how a session ID becomes a log: kiro-sessions.ts. Which session a pane
// shows when the pane names none: kiro-discovery.ts, by the lock its foreground TUI holds. There is
// no cwd or newest-session guess, because several panes can share one folder.

import type { JsonObject, JsonValue } from "../json.ts";
import { asRecord, asText } from "./cache-probe.ts";
import { MAX_TRANSCRIPT_BYTES } from "./files.ts";
import { createKiroDiscovery } from "./kiro-discovery.ts";
import { KiroSessionTree, KiroTranscriptSource } from "./kiro-sessions.ts";
import { createUnknownCounter, NO_CHANGE, noQueue, parseWith, reduction, rememberPending, type KnownTypes, type PendingTool, type Reduction, type RowReducer } from "./reduce.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type { JournalAdapter, ProcessIdentityProbe, TranscriptEntry, TranscriptPart } from "./types.ts";

/** An id longer than this is not one Kiro writes, and is not trusted as a map key. */
const MAX_ID_CHARS = 512;
// ACP's tool kinds (agentclientprotocol.com), all names the shared classifier knows. Kiro also
// writes kinds such as "other", which must not type an unknown tool.
const ACP_TOOL_KINDS: ReadonlySet<string> = new Set(["execute", "read", "edit", "search", "fetch", "delete", "move"]);

/**
 * Row types kiro-cli 2.32.0 writes that carry nothing a reader shows: lifecycle and usage state,
 * context the agent adds for the model, the approval prompt (the call's own row records the
 * outcome), and the compaction marker (the summary row after it is shown).
 */
const SILENT_ROWS = ["agent_note", "session_start", "session_metadata", "session_event", "turn_start", "turn_end", "usage_summary", "pending_interaction", "interaction_resolved", "tombstone"];

const KIRO_KNOWN: KnownTypes = {
  rows: ["user", "assistant", "tool_call", "tool_result", "sub_agent_start", "sub_agent_complete", ...SILENT_ROWS],
  roles: [],
  // An assistant row's `operationType`: `Say` is a reply, `Summary` the text /compact writes.
  parts: ["Say", "Summary"],
};

const STEERING_NOTE = /\[STEERING steer-[A-Za-z0-9-]{1,64}: ([^\]\n]{0,2000})\]/g;

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
type ToolResult = NonNullable<ToolPart["result"]>;

/** One messages.jsonl row: its id, its time and the payload that says what it is. */
interface KiroRow {
  readonly id: string;
  readonly ts: string;
  readonly type: string;
  readonly payload: JsonObject;
}

/** One messages.jsonl row, or null for a line that is not a row with an id and a payload. */
function parseRow(line: string): KiroRow | null {
  if (line.length > MAX_TRANSCRIPT_BYTES) return null;
  let row: JsonObject | null;
  try {
    // SAFETY: JSON.parse returns JSON values; asRecord checks the object boundary.
    row = asRecord(JSON.parse(line) as JsonValue);
  } catch {
    return null;
  }
  const payload = asRecord(row?.payload);
  const id = trustedId(row?.id);
  if (row === null || payload === null || id === "") return null;
  return { id, ts: asText(row.timestamp) ?? "", type: asText(payload.type) ?? "", payload };
}

/** The id `value` holds, or "" when it is missing or too long to trust as a map key. */
function trustedId(value: JsonValue | undefined): string {
  const text = asText(value) ?? "";
  return text.length <= MAX_ID_CHARS ? text : "";
}

/** A text part for something said (a prompt, a reply, a summary): ANSI removed, cut to the text cap. */
function textPart(content: string): TranscriptPart {
  return { kind: "text", ...clamp(stripAnsi(content), MAX_TEXT_CHARS) };
}

/** The transcript entry for `row`: its id and time, with `role` and `parts`. */
function entryFor(row: KiroRow, role: TranscriptEntry["role"], parts: TranscriptPart[]): TranscriptEntry {
  return { uuid: row.id, ts: row.ts, role, parts };
}

/** A tool card's result from a tool's output text: ANSI removed, cut to the result cap. */
function toolResultFrom(content: string): ToolResult {
  return clamp(stripAnsi(content), MAX_RESULT_CHARS);
}

/**
 * The tool card a tool_call row shows. Only string, number and boolean arguments reach the
 * classifier, capped; the raw arguments never leave the parser.
 */
function toolCallPart(payload: JsonObject): ToolPart {
  const args = asRecord(payload.args) ?? {};
  const input: JsonObject = {};
  for (const [key, value] of Object.entries(args).slice(0, 64)) {
    if (typeof value === "string") input[key] = clamp(stripAnsi(value), MAX_TEXT_CHARS).text;
    else if (typeof value === "number" || typeof value === "boolean") input[key] = value;
  }
  if (input.path === undefined && typeof payload.filePath === "string") input.path = clamp(payload.filePath, MAX_TEXT_CHARS).text;
  const name = oneLine(asText(payload.toolName) ?? "") || "tool";
  const summary = summarizeToolInput(input) || oneLine(asText(payload.title) ?? "");
  const byName = classifyToolCall(name, input, summary);
  const kind = asText(payload.kind) ?? "";
  const byKind = byName.kind === "other" && ACP_TOOL_KINDS.has(kind) ? classifyToolCall(kind, input, summary) : byName;
  const part: ToolPart = { kind: "tool", id: trustedId(payload.toolCallId), name, summary, call: byKind.kind === "other" ? byName : byKind };
  // The call row carries its final status; a result row follows with the output.
  if (payload.status === "denied") part.result = { text: "", denied: true };
  return part;
}

/** A user row as the user wrote it, or null for one the agent wrote (a steering hand-off) or an empty one. */
function userEntry(row: KiroRow): TranscriptEntry | null {
  const meta = asRecord(asRecord(row.payload._meta)?.kiro);
  if (meta !== null && Object.hasOwn(meta, "syntheticUserMessageReason")) return null;
  const content = asText(row.payload.content) ?? "";
  return content.trim() === "" ? null : entryFor(row, "user", [textPart(content)]);
}

/** The reducer's answer for one new entry, or no change when there is none. */
function addEntry(entry: TranscriptEntry | null): Reduction {
  return entry === null ? NO_CHANGE : reduction([entry], new Set());
}

/** Put `result` on the card emitted for its call, or emit `fallback` when there is no such card. */
function attachResult(pending: PendingTool | undefined, result: ToolResult, fallback: () => TranscriptEntry | null): Reduction {
  if (pending === undefined) return addEntry(fallback());
  pending.part.result = pending.part.result?.denied === true ? { ...result, denied: true } : result;
  return reduction([], new Set([pending.uuid]));
}

/** A fresh reducer for one Kiro session's message rows (see `JournalAdapter.reducer`). */
export function createKiroReducer(): RowReducer {
  const unknown = createUnknownCounter(KIRO_KNOWN);
  // toolCallId → the call's card, so the result row that follows lands on it.
  const calls = new Map<string, PendingTool>();
  // subSessionId → the sub-agent's card, so its completion lands on it.
  const subAgents = new Map<string, PendingTool>();

  function onAssistant(row: KiroRow): Reduction {
    const operation = asText(row.payload.operationType) ?? "";
    unknown.part(clamp(operation, 200).text);
    // A reply that took a steering message ends `[STEERING <id>: <note>]`; the TUI shows the note only.
    const content = (asText(row.payload.content) ?? "").replace(STEERING_NOTE, "$1");
    if (content === "" || (operation !== "Say" && operation !== "Summary")) return NO_CHANGE;
    return addEntry(entryFor(row, operation === "Summary" ? "summary" : "assistant", [textPart(content)]));
  }

  function onToolCall(row: KiroRow): Reduction {
    const key = trustedId(row.payload.toolCallId);
    if (key === "") return NO_CHANGE;
    const part = toolCallPart(row.payload);
    const entry = entryFor(row, "assistant", [part]);
    rememberPending(calls, key, { part, uuid: entry.uuid });
    return addEntry(entry);
  }

  function onToolResult(row: KiroRow): Reduction {
    const key = trustedId(row.payload.toolCallId);
    if (key === "" || typeof row.payload.content !== "string") return NO_CHANGE;
    const result = toolResultFrom(row.payload.content);
    if (row.payload.success === false) result.isError = true;
    const pending = calls.get(key);
    calls.delete(key);
    return attachResult(pending, result, () => entryFor(row, "assistant", [{ kind: "tool", id: key, name: "result", summary: "", result }]));
  }

  function onSubAgentStart(row: KiroRow): Reduction {
    const key = trustedId(row.payload.subSessionId);
    if (key === "") return NO_CHANGE;
    const explanation = oneLine(asText(row.payload.explanation) ?? "");
    const part: ToolPart = { kind: "tool", id: row.id, name: "subagent", summary: explanation, call: { kind: "task", agent: oneLine(asText(row.payload.subAgentName) ?? ""), summary: explanation } };
    const entry = entryFor(row, "assistant", [part]);
    rememberPending(subAgents, key, { part, uuid: entry.uuid });
    return addEntry(entry);
  }

  function onSubAgentComplete(row: KiroRow): Reduction {
    const key = trustedId(row.payload.subSessionId);
    const content = asText(row.payload.response) ?? asText(row.payload.errorMessage) ?? "";
    const result = toolResultFrom(content);
    if (row.payload.status !== "success") result.isError = true;
    const pending = subAgents.get(key);
    subAgents.delete(key);
    return attachResult(pending, result, () => (content === "" ? null : entryFor(row, "note", [textPart(content)])));
  }

  function push(line: string): Reduction {
    const row = parseRow(line);
    if (row === null) return NO_CHANGE;
    unknown.row(clamp(row.type, 200).text);
    switch (row.type) {
      case "user": return addEntry(userEntry(row));
      case "assistant": return onAssistant(row);
      case "tool_call": return onToolCall(row);
      case "tool_result": return onToolResult(row);
      case "sub_agent_start": return onSubAgentStart(row);
      case "sub_agent_complete": return onSubAgentComplete(row);
      default: return NO_CHANGE;
    }
  }

  return { push, unknowns: unknown.tally, queued: noQueue };
}

/** Parse a Kiro `messages.jsonl` into oldest-first turns. Pure: no fs, no clock. */
export function parseKiroTranscript(log: string): TranscriptEntry[] {
  return parseWith(createKiroReducer(), log);
}

/**
 * Read-only Kiro V3 journal over the configured sessions roots, normally ~/.kiro/sessions.
 *
 * `processes` answers discovery's questions about a pane's foreground process; bridge/index.ts
 * passes the /proc probe from bridge/proc-identity.ts. Pass NO_PROCESS_IDENTITY (registry.ts) where
 * no process can be seen: discovery then finds nothing, and a session the pane names still
 * resolves.
 */
export function kiroJournal(roots: string | readonly string[], processes: ProcessIdentityProbe): JournalAdapter {
  const tree = new KiroSessionTree(roots);
  const source = new KiroTranscriptSource(tree);
  return {
    agent: "kiro",
    source,
    discover: createKiroDiscovery(tree, source, processes),
    parse: parseKiroTranscript,
    reducer: createKiroReducer,
  };
}
