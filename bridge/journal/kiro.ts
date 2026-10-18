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
import { createKiroDiscovery } from "./kiro-discovery.ts";
import { KiroTranscriptSource } from "./kiro-sessions.ts";
import { createUnknownCounter, NO_CHANGE, noQueue, parseWith, reduction, rememberPending, type KnownTypes, type PendingTool, type Reduction, type RowReducer } from "./reduce.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type { JournalAdapter, TranscriptEntry, TranscriptPart } from "./types.ts";

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
  let row: JsonObject | null;
  try {
    // SAFETY: JSON.parse returns JSON values; asRecord checks the object boundary.
    row = asRecord(JSON.parse(line) as JsonValue);
  } catch {
    return null;
  }
  const payload = asRecord(row?.payload);
  const id = asText(row?.id) ?? "";
  if (row === null || payload === null || id === "") return null;
  return { id, ts: asText(row.timestamp) ?? "", type: asText(payload.type) ?? "", payload };
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

/** The tool card a tool_call row shows, classified from the tool's name and arguments. */
function toolCallPart(payload: JsonObject): ToolPart {
  const input = asRecord(payload.args) ?? {};
  const name = oneLine(asText(payload.toolName) ?? "") || "tool";
  const summary = summarizeToolInput(input) || oneLine(asText(payload.title) ?? "");
  const part: ToolPart = { kind: "tool", id: asText(payload.toolCallId) ?? "", name, summary, call: classifyToolCall(name, input, summary) };
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
    unknown.part(operation);
    // A reply that took a steering message ends `[STEERING <id>: <note>]`; the TUI shows the note only.
    const content = (asText(row.payload.content) ?? "").replace(STEERING_NOTE, "$1");
    if (content === "" || (operation !== "Say" && operation !== "Summary")) return NO_CHANGE;
    return addEntry(entryFor(row, operation === "Summary" ? "summary" : "assistant", [textPart(content)]));
  }

  function onToolCall(row: KiroRow): Reduction {
    const key = asText(row.payload.toolCallId) ?? "";
    if (key === "") return NO_CHANGE;
    const part = toolCallPart(row.payload);
    const entry = entryFor(row, "assistant", [part]);
    rememberPending(calls, key, { part, uuid: entry.uuid });
    return addEntry(entry);
  }

  function onToolResult(row: KiroRow): Reduction {
    const key = asText(row.payload.toolCallId) ?? "";
    if (key === "" || typeof row.payload.content !== "string") return NO_CHANGE;
    const result = toolResultFrom(row.payload.content);
    if (row.payload.success === false) result.isError = true;
    const pending = calls.get(key);
    calls.delete(key);
    return attachResult(pending, result, () => entryFor(row, "assistant", [{ kind: "tool", id: key, name: "result", summary: "", result }]));
  }

  function onSubAgentStart(row: KiroRow): Reduction {
    const key = asText(row.payload.subSessionId) ?? "";
    if (key === "") return NO_CHANGE;
    const explanation = oneLine(asText(row.payload.explanation) ?? "");
    const part: ToolPart = { kind: "tool", id: row.id, name: "subagent", summary: explanation, call: { kind: "task", agent: oneLine(asText(row.payload.subAgentName) ?? ""), summary: explanation } };
    const entry = entryFor(row, "assistant", [part]);
    rememberPending(subAgents, key, { part, uuid: entry.uuid });
    return addEntry(entry);
  }

  function onSubAgentComplete(row: KiroRow): Reduction {
    const key = asText(row.payload.subSessionId) ?? "";
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
    unknown.row(row.type);
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

/** Read-only Kiro V3 journal over the configured sessions roots, normally ~/.kiro/sessions. */
export function kiroJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new KiroTranscriptSource(roots);
  return {
    agent: "kiro",
    source,
    discover: createKiroDiscovery(source.roots, source),
    parse: parseKiroTranscript,
    reducer: createKiroReducer,
  };
}
