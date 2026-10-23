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
// - slash commands: `command.invoked` record.command, a bare `/name` with no args or output field
//   in any sampled row, rendered once as the operator's line. It never also appears as an accepted
//   prompt, so there is nothing to dedupe against. NOT `runtime.command_intake.*` (session
//   plumbing: session_start, queue submits), which stays unread.
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
// pane.get; herdr 0.9.4 still lists no muse integration), so muse panes carry no agentSession.
// `discover` finds the log instead: a `muse resume <uuid>` in the pane's foreground argv names it
// exactly; otherwise the newest session.jsonl whose metadata workspace_root equals the pane's cwd.
// That walk cannot tell two panes in one folder apart, so with another muse pane in the folder an
// unnamed pane reads NO session rather than maybe its neighbour's (#508). Nothing else per pane
// is known to name the session: Herdr gives argv and pid only, and no pid or lock file beside a
// Muse log is known that a pid could be matched against.

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
import { RENAME_TITLE_MAX, shortLine } from "../mux/durable/clean.ts";
import { containedRealpath, exists, head, loadTail, readSinceFile, rootList, statFile } from "./files.ts";
import { isBlobHash, resolveImageUrl } from "./pi.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import { parseUnifiedDiff } from "./diff.ts";
import { answerLabels, classifyToolCall, questionKey, type ToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  DiscoverHints,
  ForegroundProcess,
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

/** argv0 spellings the Muse launcher is observed with: `muse`, versioned `muse-bin-*` binaries,
 *  and either with a Windows `.exe` suffix. Compared case-insensitively after the suffix strip. */
function isMuseArgv0(argv0: string): boolean {
  const base = argv0.split(/[/\\]/).pop() ?? "";
  const stem = base.toLowerCase().replace(/\.exe$/, "");
  return stem === "muse" || stem.startsWith("muse-bin");
}

/**
 * The session a pane's foreground argv names, or null when none does. Only the exact `resume
 * <uuid>` form counts: a fresh `muse`, `resume --last`, and anything run under a wrapper fall
 * through to the cwd walk, where the just-started session is the newest and still wins. First
 * match wins — the foreground group holds one TUI, and a uuid that names no log resolves to
 * nothing downstream anyway.
 */
function sessionFromArgv(processes: readonly ForegroundProcess[] | undefined): string | null {
  if (processes === undefined) return null;
  for (const proc of processes) {
    const argv = proc.argv;
    if (argv.length < 3 || !isMuseArgv0(argv[0]!) || argv[1] !== "resume") continue;
    if (isMuseSessionId(argv[2]!)) return argv[2]!.toLowerCase();
  }
  return null;
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
 *
 * A plain-text result carries no exit code anywhere else either: the batch item is exactly
 * `{tool_call_index, tool_call_id, text}` and no sampled row records a number beside it (failure
 * state elsewhere is categorical — `task/failed` and kin — never numeric). So none is invented.
 * What a plain-text result CAN carry is the harness's own verdict prefix: a refused call answers
 * `tool denied: …` (nothing went wrong, somebody said no) and a failed one answers `tool failed:
 * …`. Those prefixes read as `denied`/`failed` — the same categorical flags the lifecycle rows
 * already set — so Chat and History stop drawing a refusal or a failure as a success.
 */
interface UnwrappedResult {
  text: string;
  exitCode?: number;
  /** The harness refused the call (`tool denied: …`); never an error, never read out of prose. */
  denied?: true;
  /** The harness failed the call (`tool failed: …`); the categorical flag, with no code beside it. */
  failed?: true;
}

function unwrapResultText(text: string, toolName: string): UnwrappedResult {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    // Plain text: only the harness's own verdict prefix earns a flag. Anything else — a file's
    // first line, a command's bare output — renders verbatim with no state, as before.
    if (text.startsWith("tool denied:")) return { text, denied: true };
    if (text.startsWith("tool failed:")) return { text, failed: true };
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
 * Fold what a batch result proves about its call onto the classified call, in place.
 *
 * Two kinds carry anything here, both measured over the on-disk corpus on 2026-10-18:
 *
 * - an `edit_file` success answers `edited` / `changed lines: …` / `--- original` /
 *   `+++ updated` / a bare `@@`, then only `-`/`+` lines (3,060 of 3,114 results) — a
 *   unified diff the shared reader already parses. Counts can undercount where Muse
 *   itself elided the diff (107 of 3,114 carry an ellipsis/truncation marker); that is
 *   the log's own clipping, reported as written. `write_file` answers only
 *   `wrote N bytes to <path>` — no diff, and nothing anywhere tells a create from an
 *   overwrite — so neither `diff` nor `created` is ever set for it.
 * - a `request_user_input` answer is JSON `{status, answers}` whose entries are keyed
 *   by question ID (`selected_label`, `selected_labels`, or `free_text`). The same
 *   answers are duplicated in `run/user_input_prompt_settled`; the batch copy is read
 *   because it is already joined to the call. An `interrupted` status, or any question
 *   left unanswered, sets nothing — `answers` means the call completed with answers.
 */
function enrichCallFromBatch(
  call: ToolCall | undefined,
  questionIds: readonly (string | undefined)[] | undefined,
  rawText: string,
  unwrappedText: string,
): void {
  if (call === undefined) return;
  if (call.kind === "edit") {
    if (!unwrappedText.startsWith("edited")) return;
    const fold = parseUnifiedDiff(unwrappedText);
    if (fold.hunks.length === 0) return;
    call.diff = fold.hunks;
    call.added = fold.added;
    call.removed = fold.removed;
    return;
  }
  if (call.kind !== "question") return;
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    parsed = JSON.parse(rawText) as JsonValue;
  } catch {
    return;
  }
  if (!isObj(parsed) || !Array.isArray(parsed.answers)) return;
  if (parsed.status !== undefined && parsed.status !== "answered") return;
  const byId = new Map<string, string[]>();
  for (const answer of parsed.answers) {
    if (!isObj(answer) || typeof answer.id !== "string") continue;
    const multi = answerLabels(answer.selected_labels);
    const single = answerLabels(answer.selected_label);
    const labels = multi.length > 0 ? multi : single.length > 0 ? single : answerLabels(answer.free_text);
    if (labels.length > 0) byId.set(answer.id, labels);
  }
  const chosen: string[][] = [];
  for (let i = 0; i < call.questions.length; i++) {
    const id = questionIds?.[i];
    const labels = id === undefined ? undefined : byId.get(id);
    if (labels === undefined) return;
    chosen.push(labels);
  }
  call.answers = chosen;
}

/**
 * A question call's question ids, aligned with its classified questions.
 *
 * `ToolQuestion` carries no id — the shared card does not need one — but Muse keys its
 * answers by it, so the adapter holds the ids beside the pending call. Alignment walks
 * the raw questions in order matching on the classified question text (via the
 * classifier's own {@link questionKey} clamp), because the classifier may have dropped
 * a malformed entry the raw list still holds.
 */
function questionIdsFor(call: ToolCall, input: JsonValue | undefined): (string | undefined)[] | undefined {
  if (call.kind !== "question" || !isObj(input) || !Array.isArray(input.questions)) return undefined;
  const raw = input.questions.filter(isObj);
  const ids: (string | undefined)[] = [];
  let at = 0;
  for (const question of call.questions) {
    let id: string | undefined;
    while (at < raw.length) {
      const entry = raw[at++]!;
      if (questionKey(entry.question) !== question.question) continue;
      id = typeof entry.id === "string" && entry.id !== "" ? entry.id : undefined;
      break;
    }
    ids.push(id);
  }
  return ids;
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
 * a question call's question ids for its id-keyed answers (questionIdsByCall),
 * and the live queue. Every map is `rememberPending`-bounded — the keys all originate in a file
 * a process we do not control — and the queue keeps the newest QUEUE_MAX.
 */
export function createMuseReducer(): RowReducer {
  const pendingTools = new Map<string, PendingTool>();
  const taskToCall = new Map<string, string>();
  const failedCalls = new Map<string, true>();
  const deniedCalls = new Map<string, true>();
  const imageForCall = new Map<string, string>();
  const questionIdsByCall = new Map<string, (string | undefined)[]>();
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
      const images: Extract<TranscriptPart, { kind: "image" }>[] = [];
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
            } else if (kind === "asset" && isObj(block.asset)) {
              // A content hash, not bytes: measured logs carry only the digest (plus
              // dimensions), no pixels and no retrievable path, and this collie's
              // /api/blobs route serves only pi/omp attachments — a Muse digest has
              // nowhere to load from. So the deficit stays marked in words (the
              // "[image attached]" marker), never as a broken image. Muse's own
              // `[Image #n]` markers already in the text stay verbatim: they are the
              // log's own words, not invented ones. A non-image mime contributes
              // nothing. An image mime keeps its marker even when the digest is
              // missing or malformed: the picture was attached either way.
              const mediaType =
                typeof block.asset.media_type === "string" ? block.asset.media_type : undefined;
              if (mediaType !== undefined && !mediaType.startsWith("image/")) continue;
              // No mime type at all still needs a well-formed digest to count as a picture.
              if (mediaType === undefined && !isBlobHash(str(block.asset.digest))) continue;
              assets += 1;
            } else if (kind === "image") {
              // An inline picture beside the asset references: base64 the log carried, so the
              // pixels ARE here. A reference this build will not load contributes no part,
              // rather than a broken <img> (the tool-image precedent below).
              const raw =
                typeof block.base64_data === "string"
                  ? block.base64_data
                  : typeof block.data === "string"
                    ? block.data
                    : "";
              if (raw === "") continue;
              const mediaType =
                typeof block.media_type === "string"
                  ? block.media_type
                  : typeof block.mimeType === "string"
                    ? block.mimeType
                    : undefined;
              const url = resolveImageUrl(raw, mediaType);
              if (url === null) continue;
              const part: Extract<TranscriptPart, { kind: "image" }> = { kind: "image", url };
              if (mediaType !== undefined) part.mimeType = mediaType;
              images.push(part);
            }
          }
        }
      }
      if (texts.length === 0 && assets === 0 && images.length === 0) return NO_CHANGE;
      // Only the deficit is marked: Muse's own text already carries an `[Image #n]`
      // placeholder per pasted picture (every asset turn in the measured corpus), and
      // naming it twice is noise.
      const alreadyNamed = texts.join("\n\n").split("[Image").length - 1;
      for (let i = alreadyNamed; i < assets; i++) texts.push("[image attached]");
      const parts: TranscriptEntry["parts"] = [];
      if (texts.length > 0) {
        parts.push({ kind: "text", ...clamp(stripAnsi(texts.join("\n\n")), MAX_TEXT_CHARS) });
      }
      parts.push(...images);
      entries.push({ uuid: rowId, ts, role: "user", parts });
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
            const questionIds = part.call === undefined ? undefined : questionIdsFor(part.call, input);
            if (questionIds !== undefined) rememberPending(questionIdsByCall, callId, questionIds);
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
          if (unwrapped.failed === true) result.isError = true;
          if (unwrapped.denied === true) result.denied = true;
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
            enrichCallFromBatch(
              target.part.call,
              callId === "" ? undefined : questionIdsByCall.get(callId),
              str(item.text),
              unwrapped.text,
            );
            if (callId !== "") questionIdsByCall.delete(callId);
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

    if (payloadType === "command.invoked") {
      // A slash command the operator ran: `record.command` is a bare `/name` in every sampled row
      // (no args field, no output field), and it never also arrives as an accepted prompt, so it
      // renders once, as the operator's own line — the claude.ts precedent for `/x args`. The
      // shape is the rule: anything but a slash-prefixed string is not a typed command. NOT
      // `runtime.command_intake.*` — that is session plumbing (session_start, queue submits).
      const record = isObj(payload.record) ? payload.record : null;
      const command = record === null ? "" : str(record.command).trim();
      if (!command.startsWith("/")) return NO_CHANGE;
      entries.push({
        uuid: rowId,
        ts,
        role: "user",
        parts: [{ kind: "text", ...clamp(stripAnsi(command), MAX_TEXT_CHARS) }],
      });
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
   * here when the pane names none. Three rules, in order. First, the pane's own foreground argv:
   * a `muse … resume <uuid>` there names the session exactly, so two tabs in one workspace each
   * read their own transcript. Second, when another muse pane shares the folder (`hints.shared`),
   * NO session: the walk below would hand both panes the same newest log, and one of them would
   * read the other's conversation as its own (#508). Otherwise — no argv, a fresh `muse` with no
   * resume, or a multiplexer that offers none — the newest session.jsonl whose metadata
   * workspace_root equals the cwd, read from the file's head (the metadata record sits on line 2). The walk is
   * newest-first with an early exit, so the common case costs a few directory reads; the caps
   * below bound the worst case. Subagent logs are excluded by construction — only a
   * `<uuid>/session.jsonl` at exactly that depth is ever a candidate.
   *
   * The argv match still goes through the same `resolve` and containment as any other ref: a
   * uuid that names no log on disk resolves to nothing, so a stale or foreign argv entry reads
   * as no session rather than as someone else's.
   */
  async discoverSession(
    cwd: string,
    hints?: DiscoverHints,
  ): Promise<AgentSessionRef | null> {
    const named = sessionFromArgv(hints?.processes);
    if (named !== null) return { kind: "id", value: named };
    if (hints?.shared === true) return null;
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
// ── The name the operator gave the session (MUSE-36) ───────────────────────
//
// Muse paints no session name anywhere: the label slot in its input-box rule carries the voice
// hint ("Voice input (⌥ + v to start)"), and the automatic name every session gets at birth
// (`icy-chromosphere` and friends) is never painted or titled either. The one proven home of a
// USER-given name is this log: `session.name.changed` rows, whose payload is flat
// `{session_id, previous_name, new_name, source: "automatic" | "user"}`. The session's current
// display name is the LAST such row's `new_name` — and it is only a name worth showing when that
// change was the user's. Folding every row in order (a user change sets it, any later automatic
// change clears it) gives exactly that, with no separate "was it ever renamed" state to drift.

/**
 * Fold one raw log line into the running user-given name. Lines that cannot carry a name change
 * for THIS session — another payload type, unparseable, a row naming a different session, a
 * change from a source this reader does not know — leave the running value untouched, so a shape
 * Muse adds tomorrow degrades to "the last name we understood", never to a wrong one.
 */
function foldNameLine(current: string | null, line: string, sessionId: string): string | null {
  if (!line.includes("session.name.changed")) return current;
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    parsed = JSON.parse(line) as JsonValue;
  } catch {
    return current;
  }
  if (!isObj(parsed) || str(parsed.payload_type) !== "session.name.changed") return current;
  const payload = isObj(parsed.payload) ? parsed.payload : null;
  if (payload === null) return current;
  const owner = str(payload.session_id);
  if (owner !== "" && owner.toLowerCase() !== sessionId) return current;
  const source = str(payload.source);
  if (source === "automatic") return null;
  if (source !== "user") return current;
  return sessionNameOf(str(payload.new_name)) ?? null;
}

/**
 * The name as a person may read it. The log row is agent-written text, and it reaches the pane
 * header, the dashboard and a push title, so it gets a pane title's cleaning: terminal escapes out
 * first (their tails would read as `[31m`), whitespace runs as one space, then `shortLine` drops every
 * other control and invisible character and cuts to the pane title cap with `…`. Before this a
 * 30000-character name with an escape and a newline went through whole (refines #533).
 */
function sessionNameOf(raw: string): string | undefined {
  return shortLine(stripAnsi(raw).replace(/\s+/gu, " "), RENAME_TITLE_MAX);
}

/** One session log's incremental name scan: where it got to, and the name folded so far. */
interface NameScan {
  path: string;
  /** File bytes consumed so far — `rest` included, so the next read starts exactly here. */
  offset: number;
  /** Consumed bytes after the last newline: a row still being written, held until it completes. */
  rest: Uint8Array;
  name: string | null;
}

/**
 * How much of a log one scan step reads. A first scan walks the whole log — a rename can sit
 * thousands of rows back, so no tail window can promise to hold it — and session logs measured
 * on a real herd run past 100 MB (files.ts), so the walk is chunked and only the one partial
 * row at the live edge is ever held in memory. After the first walk a scan is incremental:
 * each call folds only what was appended since the last.
 */
const NAME_SCAN_CHUNK = 1024 * 1024;

async function scanNew(scan: NameScan, sessionId: string, size: number): Promise<void> {
  while (scan.offset < size) {
    const to = Math.min(size, scan.offset + NAME_SCAN_CHUNK);
    const chunk = new Uint8Array(await Bun.file(scan.path).slice(scan.offset, to).arrayBuffer());
    scan.offset = to;
    let joined = chunk;
    if (scan.rest.length > 0) {
      joined = new Uint8Array(scan.rest.length + chunk.length);
      joined.set(scan.rest);
      joined.set(chunk, scan.rest.length);
    }
    // Rows are only ever folded whole: everything after the last newline is a row Muse is
    // still writing, held in `rest` until its newline lands (the live read's torn-line rule,
    // files.ts `readSinceFile`, in miniature).
    const end = joined.lastIndexOf(0x0a);
    if (end === -1) {
      scan.rest = joined;
      continue;
    }
    scan.rest = joined.slice(end + 1);
    const text = new TextDecoder().decode(joined.subarray(0, end));
    for (const line of text.split("\n")) scan.name = foldNameLine(scan.name, line, sessionId);
  }
}

/**
 * The user-given name of the Muse session in one pane, for the state engine's pane naming.
 *
 * Returns the name; `null` when the pane's own session is known exactly and carries no
 * user-given name; `undefined` when nothing can be said either way. The pane binds to a log
 * ONLY exactly — a reported session ref, or a `resume <uuid>` in its foreground argv (the same
 * two facts {@link MuseTranscriptSource.discoverSession} trusts before its cwd walk) — and
 * never by that walk: it resolves two panes sharing a folder to the one newest log, and a name
 * lifted from a neighbour's session would outrank the pane's own tab name and title
 * (bridge/pane-name.ts), which is a worse answer than no name. A fresh `muse` binds by neither
 * fact today, so it reads `undefined` and keeps its fallbacks byte-identical.
 *
 * Stateful per session: the first call for a session folds its whole log once; later calls
 * fold only appended bytes, so a poll loop pays a stat and (usually) no read at all.
 */
export type MuseSessionNameReader = (
  ref: AgentSessionRef | undefined,
  processes: readonly ForegroundProcess[] | undefined,
) => Promise<string | null | undefined>;

export function museSessionNameReader(roots: string | readonly string[]): MuseSessionNameReader {
  const source = new MuseTranscriptSource(roots);
  const scans = new Map<string, NameScan>();
  return async (ref, processes) => {
    const sessionId =
      ref !== undefined && ref.kind === "id" && isMuseSessionId(ref.value)
        ? ref.value.toLowerCase()
        : sessionFromArgv(processes);
    if (sessionId === null) return undefined;
    const path = await source.resolve({ kind: "id", value: sessionId });
    if (path === null) return undefined;
    let scan = scans.get(sessionId);
    if (scan === undefined || scan.path !== path) {
      scan = { path, offset: 0, rest: new Uint8Array(), name: null };
      scans.set(sessionId, scan);
    }
    const st = await statFile(path);
    if (st === null) return undefined;
    // A log that shrank under the scan was truncated or replaced: refold from the start rather
    // than trust a name folded out of bytes that are no longer the log's.
    if (st.size < scan.offset) {
      scan.offset = 0;
      scan.rest = new Uint8Array();
      scan.name = null;
    }
    try {
      await scanNew(scan, sessionId, st.size);
    } catch {
      return undefined;
    }
    return scan.name;
  };
}

export function museJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new MuseTranscriptSource(roots);
  return {
    agent: "muse",
    source,
    parse: parseMuseTranscript,
    reducer: createMuseReducer,
    discover: (cwd: string, hints?: DiscoverHints) => source.discoverSession(cwd, hints),
    sharedFolderBlind: true,
  };
}
