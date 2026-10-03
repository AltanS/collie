// Muse's journal adapter.
//
// SHAPE OF THE SOURCE (verified against on-disk session logs from Muse Code 1.4.2, 2026-10-02 —
// one 101k-row session plus half a dozen siblings; the envelope and every transcript-carrying row
// below are identical across them):
//   ~/.local/share/muse/sessions/YYYY/MM/DD/<session-uuid>/session.jsonl
//   {"schema_version":1,"id":"<row-uuid>","stream":{"kind":"session","id":"<uuid>"},
//    "sequence":N,"recorded_at":<microseconds>,"record_type":"event","durability":"durable",
//    "causation_id":…,"payload_type":"…","payload_schema_version":1,"payload":{…}}
//
// WHAT CARRIES THE TRANSCRIPT, and the trap beside each:
// - user turns: `runtime.user_intent.accepted` model_messages[].content[] text blocks. NOT
//   `run/started`'s prompt: both carry the user's words (102 accepted vs 91 started here), and a
//   steer delivered mid-run never starts one — accepted fires once per message the operator sent.
// - assistant text: `run/assistant_message_committed` text. Reasoning arrives separately as
//   `run/reasoning_summary_committed` (committed summaries; the `_delta` rows are the stream, and
//   `run/reasoning_committed` carries encrypted content only — nothing renderable).
// - tool calls: `run/assistant_tool_calls_committed` tool_calls[] (name, JSON-string args, call_id),
//   several per row. Results: `run/tool_result_batch_committed` results[] keyed by tool_call_id —
//   the committed whole. NOT `task/output` chunks (the stream) and NOT `tool_batch.effect.*` (the
//   lifecycle, read only to map task ids to call ids for failure flags). 2,491 calls join 1:1 with
//   2,490 results here; the one miss is in flight at the log's end.
// - big-result side files (`tool_output_ref` → tool-outputs/*.txt) are SKIPPED on purpose: the batch
//   already carries a ~4.7 KB excerpt and results clamp to 2,000 chars, so the file adds nothing a
//   view could show.
// - compaction: `run/context_compaction_installed` replacement.summary_text → a summary entry.
// - subagent findings: `subagent.result_ready` text → a note entry (a background task finishing).
//   The parent's `subagent_read_result` calls carry only the {status, summary} envelope, so the
//   note's full text complements the tool result rather than duplicating it.
// - queue: `run/inbox_item_queued` bodies, drained by `run/inbox_item_drained`'s snapshot body.
// - skipped structural rows: retained_marker lines (omitted ephemeral records — content gone) and
//   retained_frame transaction wrappers (permission internals in record_json children).
//
// WHERE THE SESSION COMES FROM: Herdr ships no muse integration and drops custom-source session
// reports (probed 2026-10-02 on herdr 0.9.0: an explicit report-agent-session never surfaces in
// pane.get), so muse panes carry no agentSession. `discover` finds the log instead: the newest
// session.jsonl whose metadata workspace_root equals the pane's cwd. Two panes sharing one cwd can
// cross-wire (newest wins); the ref is re-derived per tap so it self-heals when one ends.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import {
  parseWith,
  createUnknownCounter,
  type KnownTypes,
  NO_CHANGE,
  QUEUE_MAX,
  type PendingTool,
  reduction,
  type Reduction,
  rememberPending,
  type RowReducer,
} from "./reduce.ts";
import { containedRealpath, exists, head, loadTail, readSinceFile, rootList, statFile } from "./files.ts";
import { resolveImageUrl } from "./pi.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** Muse names sessions with the same canonical uuid shape Claude and Codex do. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMuseSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** `recorded_at` is microseconds since the epoch; the transcript wants an ISO string. */
function usToIso(value: JsonValue | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const ms = Math.floor(value / 1000);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function isObj(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function str(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/** A tool part's answered output — {@link clamp}'s pair, plus the flags the output earns. */
type ToolResult = NonNullable<Extract<TranscriptPart, { kind: "tool" }>["result"]>;

/**
 * Unwrap a batch result's text to what the operator would recognise as the output.
 *
 * Most tools answer with a JSON envelope describing the call (`{"chunk_id", "command",
 * "exit_code", "output", …}`) rather than the output itself. When the envelope carries a string
 * `output`, that is the text and a non-zero numeric `exit_code` beside it is the error flag;
 * anything else renders verbatim. `subagent_read_result` is the second envelope: `{status,
 * summary, …}` whose `summary` is the child's findings, gated on the CALL's name so another
 * tool's `summary` field can never misfire here.
 */
interface UnwrappedResult {
  text: string;
  exitCode?: number;
}

function unwrapResultText(text: string, toolName: string): UnwrappedResult {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    return { text };
  }
  if (!isObj(parsed)) return { text };
  const output = parsed.output;
  if (typeof output === "string") {
    const code = parsed.exit_code;
    const exitCode = typeof code === "number" && Number.isFinite(code) ? code : undefined;
    return exitCode === undefined ? { text: output } : { text: output, exitCode };
  }
  if (toolName === "subagent_read_result" && typeof parsed.summary === "string") {
    return { text: parsed.summary };
  }
  return { text };
}

/**
 * Every type this adapter has MET, rendered or dropped (`reduce.ts` § "what a reducer reports about
 * what it could not read"). Anything else is counted and named.
 *
 * THREE LEVELS land in `rows`, because Muse needs three to say what a row IS: the envelope's
 * `payload_type`, the payload's own `kind`, and the `kind/event` composite inside a
 * `runtime.session` row, which is the field that says whether the row is speech, a call, a result
 * or plumbing. Content blocks land in `parts` by their `kind` (`text`, an image `asset` reference,
 * an inline `image`). Roles stay EMPTY: the format carries no role field (the claude/grok precedent
 * — an empty list is a statement, not a gap).
 *
 * Measured 2026-10-02 over one 101,565-row session (Muse Code 1.4.2), which is the whole inventory
 * it carries. Tool names are DELIBERATELY absent: the classifier renders an unknown tool
 * generically, so a new tool is not unreadable and must not trip the canary gate.
 */
const MUSE_KNOWN: KnownTypes = {
  rows: [
    // The envelope.
    "runtime.session",
    "runtime.session.task",
    "runtime.session.metadata",
    "runtime.session.route_facts",
    "runtime.retained_fact",
    "runtime.user_intent.accepted",
    "runtime.user_intent.materialized",
    "runtime.command_intake.received",
    "runtime.command_intake.settled",
    "runtime.command_intake.session_name.received",
    "run.model.configured",
    "tool_batch.effect.started",
    "tool_batch.effect.terminal",
    "subagent.control.spawn_accepted",
    "subagent.control.resume_context_recorded",
    "subagent.control.attempt_admitted",
    "subagent.control.child_session_bound",
    "subagent.control.start_attested",
    "subagent.control.status_updated",
    "subagent.control.runtime_observed",
    "subagent.control.result_ready",
    "async.owner.attempt_admitted",
    "reminder.cleanup_effect.started",
    "reminder.cleanup_effect.terminal",
    "approval_wait.effect.started",
    "approval_wait.effect.terminal",
    "session.resource_pressure.observed",
    "session.opened.observed",
    "session.startup_phases.observed",
    "session.end",
    "session.resumed",
    "session.name.changed",
    "command.invoked",
    // What a `runtime.session` payload holds.
    "run",
    "task",
    "approval",
    "agent_tree_initialized",
    // What a run event is.
    "run/task_stream_linked",
    "run/goal_usage_attribution",
    "run/hook_run_started",
    "run/hook_run_terminal",
    "run/reasoning_committed",
    "run/provider_request_options_configured",
    "run/model_input_trace_recorded",
    "run/model_response_created",
    "run/model_completed",
    "run/assistant_tool_calls_committed",
    "run/tool_result_batch_committed",
    "run/memory_reminder_child_session_linked",
    "run/reminder_proposal",
    "run/reminder_reconciler_outcome",
    "run/skill_reminder_decision",
    "run/reasoning_summary_delta",
    "run/context_block_diagnostic",
    "run/reasoning_summary_committed",
    "run/resource_usage_sampled",
    "run/started",
    "run/model_request_configured",
    "run/terminal",
    "run/assistant_message_committed",
    "run/todo_snapshot_updated",
    "run/reminder_installed",
    "run/tool_result_model_visible_content",
    "run/inbox_item_queued",
    "run/inbox_item_drained",
    "run/inbox_delivery_anomaly",
    "run/skill_read_observed",
    "run/workflow_child_lifecycle",
    "run/tool_results_cleared",
    "run/context_compaction_candidate",
    "run/context_compaction_installed",
    "run/context_projection_checkpoint",
    "run/context_projection_checkpoint_skipped",
    "run/user_input_prompt_requested",
    "run/user_input_prompt_settled",
    "run/task_backgrounded",
    "run/run_retracted",
    "run/workflow_run_launched",
    "run/workflow_launch_reconciled",
    // What a task event is.
    "task/proposed",
    "task/accepted",
    "task/scheduled",
    "task/started",
    "task/side_effect_intent",
    "task/completed",
    "task/status",
    "task/output",
    "task/rejected",
    "task/tool_output_ref",
    "task/failed",
    "task/cancelled",
    "task/timed_out",
    // What an approval event is.
    "approval/requested",
    "approval/decision_applied",
    "approval/automated_review_started",
    "approval/automated_review_completed",
  ],
  roles: [],
  parts: ["text", "asset", "image"],
};

/**
 * Parse a Muse session log into oldest-first turns. PURE — no fs, no clock.
 *
 * Unparseable lines are skipped: the log is appended to live, so the last line can be a partial
 * write, and a tail-read window starts mid-line by construction.
 */
export function parseMuseTranscript(text: string): TranscriptEntry[] {
  return parseWith(createMuseReducer(), text);
}

/**
 * The same reading, one row at a time (see `reduce.ts`).
 *
 * State the reducer keeps across rows: calls waiting for results (pendingTools), task→call
 * linkage for failure flags (taskToCall), calls refused or failed before their result row
 * (deniedCalls, failedCalls), image urls that arrived before their result did (imageForCall),
 * and the live queue. Every map is `rememberPending`-bounded — the keys all originate in a file
 * a process we do not control — and the queue keeps the newest QUEUE_MAX.
 */
export function createMuseReducer(): RowReducer {
  const pendingTools = new Map<string, PendingTool>();
  const taskToCall = new Map<string, string>();
  const failedCalls = new Map<string, true>();
  const deniedCalls = new Map<string, true>();
  const imageForCall = new Map<string, string>();
  const queue: string[] = [];
  const unknown = createUnknownCounter(MUSE_KNOWN);

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
    if (!isObj(parsed)) return NO_CHANGE;
    const payload = parsed.payload;
    // Retained markers and transaction frames carry no payload: the first marks an omitted
    // ephemeral record (content gone), the second wraps permission internals. Neither is a turn.
    if (!isObj(payload)) return NO_CHANGE;
    const rowId = str(parsed.id);
    // A transcript row without an id is unaddressable — the uuid is the paging cursor — so it is
    // skipped rather than emitted under a made-up one. The schema requires the field; every one of
    // the 98,119 payload-bearing rows measured carries it.
    if (rowId === "") return NO_CHANGE;
    const ts = usToIso(parsed.recorded_at);
    const payloadType = str(parsed.payload_type);
    // At the READ, not in the branch that declined (`reduce.ts` § `createUnknownCounter`).
    unknown.row(payloadType === "" ? undefined : payloadType);

    if (payloadType === "runtime.user_intent.accepted") {
      const texts: string[] = [];
      let assets = 0;
      const messages = payload.model_messages;
      if (Array.isArray(messages)) {
        for (const message of messages) {
          if (!isObj(message) || !Array.isArray(message.content)) continue;
          for (const block of message.content) {
            if (!isObj(block)) continue;
            const kind = str(block.kind);
            unknown.part(kind === "" ? undefined : kind);
            if (kind === "text" && typeof block.text === "string" && block.text.trim() !== "") {
              texts.push(block.text);
            } else if (kind === "asset") {
              assets += 1;
            }
          }
        }
      }
      if (texts.length === 0 && assets === 0) return NO_CHANGE;
      // An asset is a content hash, not bytes — the picture lives outside the log and the pure
      // parser cannot resolve it. A marked placeholder keeps the turn from rendering empty (or
      // vanishing, for an image-only turn) without inventing pixels.
      for (let i = 0; i < assets; i++) texts.push("[image attached]");
      entries.push({
        uuid: rowId,
        ts,
        role: "user",
        parts: [{ kind: "text", ...clamp(stripAnsi(texts.join("\n\n")), MAX_TEXT_CHARS) }],
      });
      return reduction(entries, changed);
    }

    if (payloadType === "runtime.session") {
      const kind = str(payload.kind);
      unknown.row(kind === "" ? undefined : kind);
      const event = isObj(payload.event) ? payload.event : null;
      const eventKind = event === null ? "" : str(event.kind);
      if (kind !== "" && eventKind !== "") unknown.row(`${kind}/${eventKind}`);
      if (event === null) return NO_CHANGE;

      if (kind === "run" && eventKind === "assistant_message_committed") {
        const text = str(event.text);
        if (text.trim() === "") return NO_CHANGE;
        entries.push({
          uuid: rowId,
          ts,
          role: "assistant",
          parts: [{ kind: "text", ...clamp(stripAnsi(text), MAX_TEXT_CHARS) }],
        });
        return reduction(entries, changed);
      }

      if (kind === "run" && eventKind === "reasoning_summary_committed") {
        const text = str(event.text);
        if (text.trim() === "") return NO_CHANGE;
        entries.push({
          uuid: rowId,
          ts,
          role: "assistant",
          parts: [{ kind: "thinking", ...clamp(stripAnsi(text), MAX_TEXT_CHARS) }],
        });
        return reduction(entries, changed);
      }

      if (kind === "run" && eventKind === "assistant_tool_calls_committed") {
        const calls = event.tool_calls;
        if (!Array.isArray(calls)) return NO_CHANGE;
        // ONE entry for the row's calls: they were a single assistant message, and one uuid per
        // entry keeps the paging cursor unambiguous. Each part still pairs with its own result.
        const parts: TranscriptPart[] = [];
        for (const call of calls) {
          if (!isObj(call)) continue;
          const name = str(call.name) === "" ? "tool" : str(call.name);
          const rawArgs = call.args;
          let input: JsonValue | undefined;
          if (typeof rawArgs === "string") {
            try {
              // SAFETY: `JSON.parse` output IS a JsonValue by construction.
              const parsedArgs = JSON.parse(rawArgs) as JsonValue;
              input = isObj(parsedArgs) ? parsedArgs : undefined;
            } catch {
              input = undefined;
            }
          } else if (isObj(rawArgs)) {
            input = rawArgs;
          }
          const summary =
            summarizeToolInput(input) ||
            (typeof rawArgs === "string" ? oneLine(rawArgs) : "") ||
            "";
          const part: Extract<TranscriptPart, { kind: "tool" }> = {
            kind: "tool",
            name,
            summary,
            call: classifyToolCall(name, input, summary),
          };
          const callId = str(call.call_id);
          if (callId !== "") {
            part.id = callId;
            rememberPending(pendingTools, callId, { part, uuid: rowId });
          }
          parts.push(part);
        }
        if (parts.length === 0) return NO_CHANGE;
        entries.push({ uuid: rowId, ts, role: "assistant", parts });
        return reduction(entries, changed);
      }

      if (kind === "run" && eventKind === "tool_result_batch_committed") {
        const results = event.results;
        if (!Array.isArray(results)) return NO_CHANGE;
        for (const item of results) {
          if (!isObj(item)) continue;
          const callId = str(item.tool_call_id);
          const target = callId === "" ? undefined : pendingTools.get(callId);
          const unwrapped = unwrapResultText(str(item.text), target?.part.name ?? "");
          const result: ToolResult = clamp(stripAnsi(unwrapped.text), MAX_RESULT_CHARS);
          if (unwrapped.exitCode !== undefined && unwrapped.exitCode !== 0) result.isError = true;
          if (callId !== "" && failedCalls.has(callId)) result.isError = true;
          if (callId !== "" && deniedCalls.has(callId)) result.denied = true;
          const imageUrl = callId === "" ? undefined : imageForCall.get(callId);
          if (imageUrl !== undefined) result.imageUrl = imageUrl;
          if (target !== undefined) {
            // Mutated in place — the part already sits in an emitted entry, which is exactly why
            // results attach without reordering anything. The pending entry STAYS: an image or a
            // late failure flag for the same call may still arrive, and eviction bounds the map.
            if (callId !== "") {
              failedCalls.delete(callId);
              deniedCalls.delete(callId);
              imageForCall.delete(callId);
            }
            target.part.result = result;
            if (target.part.call !== undefined && target.part.call.kind === "execute" && unwrapped.exitCode !== undefined) {
              target.part.call.exitCode = unwrapped.exitCode;
            }
            // The mutation above landed in a turn that went out rows ago. Name it.
            changed.add(target.uuid);
          } else if (result.text.trim() !== "" || result.imageUrl !== undefined) {
            // Orphan result (its call fell outside a tail-read window) — kept unattached so the
            // window never silently drops output.
            entries.push({
              uuid: rowId,
              ts,
              role: "assistant",
              parts: [{ kind: "tool", name: "result", summary: "", result }],
            });
          }
        }
        return reduction(entries, changed);
      }

      if (kind === "run" && eventKind === "tool_result_model_visible_content") {
        const callId = str(event.call_id);
        const content = event.content;
        if (callId === "" || !Array.isArray(content)) return NO_CHANGE;
        for (const block of content) {
          if (!isObj(block)) continue;
          const blockKind = str(block.kind);
          unknown.part(blockKind === "" ? undefined : blockKind);
          // Images only: this record can also carry text the batch already committed, and reading
          // that here would render it twice.
          if (blockKind !== "image" || typeof block.base64_data !== "string") continue;
          const mimeType = typeof block.media_type === "string" ? block.media_type : undefined;
          const url = resolveImageUrl(block.base64_data, mimeType);
          if (url === null) continue;
          rememberPending(imageForCall, callId, url);
          const target = pendingTools.get(callId);
          if (target !== undefined && target.part.result !== undefined && target.part.result.imageUrl === undefined) {
            target.part.result.imageUrl = url;
            changed.add(target.uuid);
          }
        }
        return reduction(entries, changed);
      }

      if (kind === "run" && eventKind === "inbox_item_queued") {
        const body = str(event.body);
        if (body.trim() === "") return NO_CHANGE;
        queue.push(body);
        // Newest win: the operator's just-typed message is the one they are looking for.
        if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
        return NO_CHANGE;
      }

      if (kind === "run" && eventKind === "inbox_item_drained") {
        const snapshot = isObj(event.delivery_snapshot) ? event.delivery_snapshot : null;
        const body = snapshot === null ? "" : str(snapshot.body);
        if (body === "") return NO_CHANGE;
        const at = queue.indexOf(body);
        // Under-reporting is the safe direction: a body that was never queued (tail started
        // mid-queue) removes nothing, and duplicate bodies drain oldest-first.
        if (at >= 0) queue.splice(at, 1);
        return NO_CHANGE;
      }

      if (kind === "run" && eventKind === "context_compaction_installed") {
        const replacement = isObj(event.replacement) ? event.replacement : null;
        // The shape is the rule: only a summary_text replacement renders as a summary, so a
        // future replacement kind cannot silently become words the agent never wrote.
        if (replacement === null || str(replacement.kind) !== "summary_text") return NO_CHANGE;
        const text = str(replacement.text);
        if (text.trim() === "") return NO_CHANGE;
        entries.push({
          uuid: rowId,
          ts,
          role: "summary",
          parts: [{ kind: "text", ...clamp(stripAnsi(text), MAX_TEXT_CHARS) }],
        });
        return reduction(entries, changed);
      }

      if (kind === "task" && eventKind === "failed") {
        const callId = taskToCall.get(str(event.task_id)) ?? "";
        if (callId === "") return NO_CHANGE;
        rememberPending(failedCalls, callId, true);
        const target = pendingTools.get(callId);
        if (target === undefined) return reduction(entries, changed);
        if (target.part.result === undefined) {
          // A stub result carries the failure's own words until the batch row overwrites it with
          // the full text (which keeps isError from the stash).
          const reason = str(event.reason);
          target.part.result = {
            ...clamp(stripAnsi(reason === "" ? "failed" : reason), MAX_RESULT_CHARS),
            isError: true,
          };
          changed.add(target.uuid);
        } else if (target.part.result.isError !== true) {
          // The failure flag arrived after the result did: same flag, no overwrite.
          target.part.result.isError = true;
          changed.add(target.uuid);
        }
        return reduction(entries, changed);
      }

      if (kind === "approval" && eventKind === "decision_applied") {
        if (str(event.decision) === "approved" || str(event.decision) === "") return NO_CHANGE;
        // Anything but an approval is a refusal (nothing went wrong, somebody said no). The call
        // never executes, so there may never be a batch row: the stub stands in for it, and a batch
        // that does arrive overwrites it with the full text (which keeps denied from the stash).
        const callId = str(event.tool_call_id);
        if (callId === "") return NO_CHANGE;
        rememberPending(deniedCalls, callId, true);
        const target = pendingTools.get(callId);
        if (target !== undefined) {
          if (target.part.result === undefined) {
            target.part.result = { text: "", denied: true };
          } else {
            target.part.result.denied = true;
          }
          changed.add(target.uuid);
        }
        return reduction(entries, changed);
      }

      return reduction(entries, changed);
    }

    if (payloadType === "tool_batch.effect.started" || payloadType === "tool_batch.effect.terminal") {
      const record = isObj(payload.record) ? payload.record : null;
      if (record === null) return NO_CHANGE;
      // The task→call linkage a `task/failed` row needs to flag its call. Both lifecycle rows
      // carry the pair; either may arrive first.
      const taskId = str(record.task_id);
      const callId = str(record.call_id);
      if (taskId !== "" && callId !== "") rememberPending(taskToCall, taskId, callId);
      return NO_CHANGE;
    }

    if (payloadType.startsWith("subagent.control.")) {
      if (payloadType === "subagent.control.result_ready") {
        const record = isObj(payload.record) ? payload.record : null;
        const text = record === null ? "" : str(record.text) || str(record.summary);
        if (text.trim() === "") return NO_CHANGE;
        entries.push({
          uuid: rowId,
          ts,
          role: "note",
          parts: [{ kind: "text", ...clamp(stripAnsi(text), MAX_TEXT_CHARS) }],
        });
      }
      return reduction(entries, changed);
    }

    // Every other row is tallied above and intentionally unread: lifecycle, telemetry, hooks,
    // reminders, approvals in flight, compaction candidates, subagent control. A gap with a name
    // is not drift.
    return reduction(entries, changed);
  }

  return {
    push,
    unknowns: unknown.tally,
    queued: () => [...queue],
  };
}

/**
 * Real filesystem source rooted at Muse's `sessions` directory.
 *
 * Resolution is a targeted walk: the uuid is a DIRECTORY name under date-partitioned directories
 * (`YYYY/MM/DD/<uuid>/session.jsonl`), walked newest-date first so a live session is found after
 * a handful of directory entries. The hit is cached; a cached path is re-verified before use,
 * since a session can be deleted while the bridge is up.
 *
 * `subagent/` subtrees are NEVER descended into: a child session's log is a session of its own,
 * and resolving a pane to one would show the operator somebody else's turn as their own.
 */
export class MuseTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();

  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isMuseSessionId(ref.value)) return null;
    const sessionId = ref.value.toLowerCase();
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      if (await exists(cached)) return cached;
      this.pathCache.delete(sessionId);
    }

    for (const root of this.roots) {
      const hit = await this.findUnder(root, sessionId);
      // A hit that failed containment is `null` too — that root has nothing it may serve for this
      // uuid either way, and the next root is asked on its own terms (files.ts header).
      if (hit === null) continue;
      this.pathCache.set(sessionId, hit);
      return hit;
    }
    return null;
  }

  /** Newest first at every level: a session being read is almost always today's. */
  private async findUnder(root: string, sessionId: string): Promise<string | null> {
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
          const hit = names.find((n) => n.toLowerCase() === sessionId);
          if (hit === undefined) continue;
          return containedRealpath(join(dir, hit, "session.jsonl"), root);
        }
      }
    }
    return null;
  }

  /**
   * Find the session running in `cwd` without a reported ref.
   *
   * Herdr reports no session for muse panes (see the header), so the history and chat routes ask
   * here when the pane names none. The rule: the newest session.jsonl whose metadata
   * workspace_root equals the cwd, read from the file's head (the metadata record sits on line 2).
   * The walk is newest-first with an early exit, so the common case costs a few directory reads;
   * the caps below bound the worst case. Subagent logs are excluded by construction — only a
   * `<uuid>/session.jsonl` at exactly that depth is ever a candidate.
   *
   * Two sessions sharing one cwd cross-wire (newest wins); the ref is re-derived per tap so it
   * self-heals when one ends. That is a documented limitation, not a guess: exactness would need
   * the agent to report, which is Herdr's integration to add.
   */
  async discoverSession(cwd: string): Promise<AgentSessionRef | null> {
    if (cwd.trim() === "") return null;
    for (const root of this.roots) {
      const hit = await this.findByRoot(root, cwd);
      if (hit === null) continue;
      return { kind: "id", value: hit };
    }
    return null;
  }

  private async findByRoot(root: string, cwd: string): Promise<string | null> {
    // Newest first, so the first few candidates are the only ones usually read. The walk stops
    // collecting past MAX_DISCOVER_CANDIDATES: past that the answer is "too many sessions to
    // tell", which reads as no session rather than as a slow one.
    const candidates: { uuid: string; path: string; mtimeMs: number }[] = [];
    const years = await descending(root);
    for (const year of years) {
      for (const month of await descending(join(root, year))) {
        for (const day of await descending(join(root, year, month))) {
          const dir = join(root, year, month, day);
          let names: string[];
          try {
            names = await readdir(dir);
          } catch {
            continue;
          }
          for (const name of names) {
            if (candidates.length >= MAX_DISCOVER_CANDIDATES) break;
            if (!isMuseSessionId(name)) continue;
            const path = join(dir, name, "session.jsonl");
            const meta = await statFile(path);
            if (meta === null) continue;
            candidates.push({ uuid: name.toLowerCase(), path, mtimeMs: meta.mtimeMs });
          }
          if (candidates.length >= MAX_DISCOVER_CANDIDATES) break;
        }
        if (candidates.length >= MAX_DISCOVER_CANDIDATES) break;
      }
      if (candidates.length >= MAX_DISCOVER_CANDIDATES) break;
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of candidates.slice(0, MAX_DISCOVER_READS)) {
      const contained = await containedRealpath(candidate.path, root);
      if (contained === null) continue;
      if ((await metadataRoot(contained)) === cwd) return candidate.uuid;
    }
    return null;
  }

  stat = statFile;

  load = loadTail;

  /**
   * The live read. Muse rows carry their own uuids, so unlike Codex there is no synthesised
   * cursor whose numbering a reset would disturb: a fresh reducer over a fresh window numbers
   * nothing at all.
   */
  readSince = readSinceFile;
}

/** Most sessions a discovery walk collects before it stops looking. */
const MAX_DISCOVER_CANDIDATES = 2000;

/** Most candidates a discovery walk head-reads. The walk is newest-first, so a live session is
 *  almost always within the first few; past this the answer is "no session", not a slow one. */
const MAX_DISCOVER_READS = 200;

/** Directory entries, newest-name first. Empty when the directory doesn't exist. */
async function descending(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).toSorted().toReversed();
  } catch {
    return [];
  }
}

/**
 * The workspace_root a session log's metadata record declares, or null when the head carries
 * none. Reads the head only — the metadata record sits on the log's second line.
 */
async function metadataRoot(path: string): Promise<string | null> {
  let text: string;
  try {
    text = await head(path);
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      continue;
    }
    if (!isObj(parsed) || str(parsed.payload_type) !== "runtime.session.metadata") continue;
    const payload = isObj(parsed.payload) ? parsed.payload : null;
    const record = payload !== null && isObj(payload.record) ? payload.record : null;
    const root = record === null ? "" : str(record.workspace_root);
    return root === "" ? null : root;
  }
  return null;
}

/**
 * Muse's journal adapter. `agent` matches the Herdr snapshot's `agent` string.
 *
 * No `cacheProbe`: the log carries usage records but Muse publishes no cache TTL Collie could
 * quote, so like grok and hermes this ships no rule.
 */
export function museJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new MuseTranscriptSource(roots);
  return {
    agent: "muse",
    source,
    parse: parseMuseTranscript,
    reducer: createMuseReducer,
    discover: (cwd: string) => source.discoverSession(cwd),
  };
}
