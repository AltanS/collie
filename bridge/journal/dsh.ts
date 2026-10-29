// DeepSeek Harness session events, read into transcript entries, and the dsh-tui journal adapter.
//
// A session log holds a header row ({type: "session", version, id, cwd, …}) and then one durable
// event per row, {type, seq, time, data}. What a reader shows:
//  - `user/message` whose source is the user. dsh writes several machine messages with the user
//    role (the time, the skill catalog, agent instructions, a compaction checkpoint); those carry
//    another `source.kind` and are not speech. A finished background job (`tool-jobs`) is a note.
//  - `assistant/message`: reasoning, text and tool-call blocks, in the order the model wrote them.
//  - `tool/result`, answering a tool-call block by its id. The `tool/call` row repeats a call the
//    assistant row already carries, so it is not read.
//  - `approval/decided` with outcome `rejected` marks the call it answers as denied.
//  - `compaction/summary`, the summary that replaces the turns before it in the model's context.
//  - `command/done`, the result of a slash command the user ran (`/permission workspace-write`),
//    named by its `command/run` row. It is a note: it changed the session, but nobody said it.
// Rows may carry `surfaceOp: {op: "replace", …}`. That edits what the MODEL sees next (a new system
// prompt, the compaction checkpoint over the turns it summarised) and never rewrites a turn the
// person saw, so it is not applied here. Observed on dsh session format v4.
//
// Where the sessions live and how a log is read, compressed or not: dsh-sessions.ts. Which session
// a pane shows when the pane names none: dsh-discovery.ts, by the lock its writer holds.

import type { JsonObject, JsonValue } from "../json.ts";
import { asRecord, asText } from "./cache-probe.ts";
import { createDshDiscovery } from "./dsh-discovery.ts";
import { DshTranscriptSource } from "./dsh-sessions.ts";
import { createUnknownCounter, NO_CHANGE, noQueue, parseWith, reduction, rememberPending, type KnownTypes, type PendingTool, type Reduction, type RowReducer } from "./reduce.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type { JournalAdapter, TranscriptEntry, TranscriptPart } from "./types.ts";

/** Event types dsh writes that carry nothing a reader shows. */
const SILENT_ROWS = [
  "session",
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "tool/call",
  "approval/asked",
  "approval/policy",
  "permission/preset",
  "sandbox/mode",
  "system/message",
  "developer/message",
  "request/header",
  "request/context",
  "session/title",
  "session/title-llm-request",
  "session/end-seed",
  "agent/inbox/spliced",
  "job/registered",
  "job/settled",
  "todo/write",
  "deliverables/presented",
  "compaction/start",
  "compaction/end",
];

const DSH_KNOWN: KnownTypes = {
  rows: ["user/message", "assistant/message", "tool/result", "approval/decided", "compaction/summary", "command/run", "command/done", ...SILENT_ROWS],
  roles: [],
  parts: ["text", "reasoning", "tool-call"],
};

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
type ToolResult = NonNullable<ToolPart["result"]>;

/** One event row: its sequence number, its time and its data. The header row has no data. */
interface DshRow {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly data: JsonObject;
}

/** One event row, or null for a line that is not an object with a type. */
function parseRow(line: string): DshRow | null {
  let row: JsonObject | null;
  try {
    // SAFETY: JSON.parse returns JSON values; asRecord checks the object boundary.
    row = asRecord(JSON.parse(line) as JsonValue);
  } catch {
    return null;
  }
  const type = asText(row?.type) ?? "";
  if (row === null || type === "") return null;
  const seq = typeof row.seq === "number" ? row.seq : -1;
  const time = typeof row.time === "number" && Number.isFinite(row.time) ? new Date(row.time) : null;
  return { seq, ts: time === null || Number.isNaN(time.getTime()) ? "" : time.toISOString(), type, data: asRecord(row.data) ?? {} };
}

/** The entry's id: the message's own id where it has one, else the row's sequence number. */
function uuidFor(row: DshRow, message: JsonObject | null): string {
  return asText(message?.id) ?? `seq-${row.seq}`;
}

/** The text blocks of a content list, joined, with ANSI removed. */
function textOf(content: JsonValue | undefined): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text") texts.push(asText(record.text) ?? "");
  }
  return stripAnsi(texts.join("\n"));
}

/** A text part for something said, cut to the text cap. */
function textPart(text: string): TranscriptPart {
  return { kind: "text", ...clamp(text, MAX_TEXT_CHARS) };
}

/** The tool card a tool-call block shows. dsh writes the arguments as a JSON string. */
function toolCallPart(block: JsonObject): ToolPart {
  let input: JsonValue = {};
  const raw = block.arguments;
  if (typeof raw === "string") {
    try {
      // SAFETY: JSON.parse returns JSON values.
      input = JSON.parse(raw) as JsonValue;
    } catch {
      input = {};
    }
  } else if (raw !== undefined) {
    input = raw;
  }
  const name = oneLine(asText(block.name) ?? "") || "tool";
  const summary = summarizeToolInput(input);
  return { kind: "tool", id: asText(block.id) ?? "", name, summary, call: classifyToolCall(name, input, summary) };
}

/** The reducer's answer for one new entry, or no change when there is none. */
function addEntry(entry: TranscriptEntry | null): Reduction {
  return entry === null ? NO_CHANGE : reduction([entry], new Set());
}

/** A fresh reducer for one dsh session's event rows (see `JournalAdapter.reducer`). */
export function createDshReducer(): RowReducer {
  const unknown = createUnknownCounter(DSH_KNOWN);
  // tool-call id → the call's card, so the result row that follows lands on it.
  const calls = new Map<string, PendingTool>();
  // approval id → the tool-call id it asked about, so a rejection lands on that call.
  const approvals = new Map<string, string>();
  // command id → the command line the user typed, so its result names it.
  const commands = new Map<string, string>();

  function onUser(row: DshRow): Reduction {
    const source = asText(asRecord(row.data.source)?.kind) ?? "";
    const text = textOf(row.data.content);
    if (text.trim() === "") return NO_CHANGE;
    const entry = { uuid: uuidFor(row, row.data), ts: row.ts, parts: [textPart(text)] };
    if (source === "user") return addEntry({ ...entry, role: "user" });
    if (source === "tool-jobs") return addEntry({ ...entry, role: "note" });
    return NO_CHANGE;
  }

  function onAssistant(row: DshRow): Reduction {
    const message = asRecord(row.data.message);
    const content = message?.content;
    if (message === null || !Array.isArray(content)) return NO_CHANGE;
    const uuid = uuidFor(row, message);
    const parts: TranscriptPart[] = [];
    for (const item of content) {
      const block = asRecord(item);
      if (block === null) continue;
      unknown.part(block.type);
      if (block.type === "text") {
        const text = stripAnsi(asText(block.text) ?? "");
        if (text.trim() !== "") parts.push(textPart(text));
      } else if (block.type === "reasoning") {
        const text = stripAnsi(asText(block.text) ?? "");
        if (text.trim() !== "") parts.push({ kind: "thinking", ...clamp(text, MAX_TEXT_CHARS) });
      } else if (block.type === "tool-call") {
        const part = toolCallPart(block);
        parts.push(part);
        if (part.id !== undefined && part.id !== "") rememberPending(calls, part.id, { part, uuid });
      }
    }
    return parts.length === 0 ? NO_CHANGE : addEntry({ uuid, ts: row.ts, role: "assistant", parts });
  }

  function onToolResult(row: DshRow): Reduction {
    const message = asRecord(row.data.message);
    const key = asText(message?.toolCallId) ?? "";
    if (message === null || key === "") return NO_CHANGE;
    const result: ToolResult = clamp(textOf(message.content), MAX_RESULT_CHARS);
    if (message.isError === true) result.isError = true;
    const pending = calls.get(key);
    calls.delete(key);
    if (pending === undefined) {
      return addEntry({ uuid: uuidFor(row, message), ts: row.ts, role: "assistant", parts: [{ kind: "tool", id: key, name: "result", summary: "", result }] });
    }
    pending.part.result = pending.part.result?.denied === true ? { ...result, denied: true } : result;
    return reduction([], new Set([pending.uuid]));
  }

  function onApprovalAsked(row: DshRow): void {
    const id = asText(row.data.id) ?? "";
    const callId = asText(row.data.callId) ?? "";
    if (id !== "" && callId !== "") rememberPending(approvals, id, callId);
  }

  function onApprovalDecided(row: DshRow): Reduction {
    const id = asText(row.data.id) ?? "";
    const callId = approvals.get(id);
    approvals.delete(id);
    if (row.data.outcome !== "rejected" || callId === undefined) return NO_CHANGE;
    const pending = calls.get(callId);
    if (pending === undefined) return NO_CHANGE;
    pending.part.result = { ...(pending.part.result ?? { text: "" }), denied: true };
    return reduction([], new Set([pending.uuid]));
  }

  function onCommandRun(row: DshRow): void {
    const id = asText(row.data.commandId) ?? "";
    const name = oneLine(asText(row.data.name) ?? "");
    if (id !== "" && name !== "") rememberPending(commands, id, oneLine(`/${name}${asText(row.data.args) ?? ""}`));
  }

  function onCommandDone(row: DshRow): Reduction {
    const id = asText(row.data.commandId) ?? "";
    const line = commands.get(id);
    commands.delete(id);
    const result = stripAnsi(asText(row.data.text) ?? "").trim();
    const text = [line, result].filter((part) => part !== undefined && part !== "").join("\n");
    if (text === "") return NO_CHANGE;
    return addEntry({ uuid: id === "" ? `seq-${row.seq}` : id, ts: row.ts, role: "note", parts: [textPart(text)] });
  }

  function onSummary(row: DshRow): Reduction {
    const text = textOf(row.data.summary);
    if (text.trim() === "") return NO_CHANGE;
    return addEntry({ uuid: asText(row.data.compactionId) ?? `seq-${row.seq}`, ts: row.ts, role: "summary", parts: [textPart(text)] });
  }

  function push(line: string): Reduction {
    const row = parseRow(line);
    if (row === null) return NO_CHANGE;
    unknown.row(row.type);
    switch (row.type) {
      case "user/message": return onUser(row);
      case "assistant/message": return onAssistant(row);
      case "tool/result": return onToolResult(row);
      case "approval/asked": onApprovalAsked(row); return NO_CHANGE;
      case "approval/decided": return onApprovalDecided(row);
      case "compaction/summary": return onSummary(row);
      case "command/run": onCommandRun(row); return NO_CHANGE;
      case "command/done": return onCommandDone(row);
      default: return NO_CHANGE;
    }
  }

  return { push, unknowns: unknown.tally, queued: noQueue };
}

/** Parse a dsh session log's rows into oldest-first turns. Pure: no fs, no clock. */
export function parseDshTranscript(log: string): TranscriptEntry[] {
  return parseWith(createDshReducer(), log);
}

/** Read-only dsh journal over the configured sessions roots, normally ~/.dsh/sessions. */
export function dshJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new DshTranscriptSource(roots);
  return {
    agent: "dsh-tui",
    source,
    discover: createDshDiscovery(source.roots, source),
    parse: parseDshTranscript,
    reducer: createDshReducer,
  };
}
