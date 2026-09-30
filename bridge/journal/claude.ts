// Claude Code's journal adapter.
//
// WHY THIS EXISTS. A pane running Claude sits on the terminal's ALTERNATE SCREEN, and the alternate
// screen has no scrollback ring — Herdr's terminal core (Ghostty) keeps nothing behind the viewport.
// Empirically: every claude pane reports `scroll.max_offset_from_bottom: 0`, and `pane.read` returns
// exactly `viewport_rows + 1` lines no matter how many you ask for (200, 600, 5000, 10000 — all 52).
// A plain bash pane on the primary screen, by contrast, reports 6895 and pages fine. So "load older"
// against a Claude pane can never work: the bytes were never retained. This is upstream terminal
// behaviour, not a Collie bug and not a config knob.
//
// The history does exist, though — Claude Code writes every turn to its own session log at
// `~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl`, and Herdr hands us that uuid on the pane
// record (`agent_session.value`, kind `id`). It is strictly BETTER than terminal scrollback would
// have been: real message boundaries, timestamps, tool calls folded together with their results, and
// it survives the pane being closed.
//
// SHAPE OF THE SOURCE (verified against Claude Code 2.1.220, 2026-07-26):
//   {"type":"user",      "message":{"role":"user","content":"..." | [ {type:"tool_result",...} ]}, ...}
//   {"type":"assistant", "message":{"role":"assistant","content":[ {type:"text"|"thinking"|"tool_use"} ]}}
//   plus bookkeeping rows we ignore (mode, permission-mode, ai-title, file-history-*, queue-operation…).
// Human turns carry a STRING content; a `user` row whose content is a LIST is usually tool-result
// traffic, not something the user typed — we fold those into the tool call that produced them rather
// than rendering fake "user" turns. `isMeta` marks a row the operator did not write. Most are
// addressed to the model (a skill body, an attached image's source path, the local-command caveat)
// and are dropped; a prompt Claude sent on its own (`promptSource: "system"`) becomes a note.
// `isSidechain` marks subagent traffic (dropped by default); `isCompactSummary` marks the summary
// Claude writes when a session is compacted.

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { observedClaim, type Sourced } from "../cache/claims.ts";
import type { CacheProbe } from "../cache/engine.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import {
  createUnknownCounter,
  type KnownTypes,
  QUEUE_MAX,
  NO_CHANGE,
  noteBlockTypes,
  parseWith,
  reduction,
  rememberPending,
  type PendingTool,
  type Reduction,
  type RowReducer,
} from "./reduce.ts";
import { asRecord, asText, probeTail, tokenCount } from "./cache-probe.ts";
import { claudeResets, lastTwoTurns } from "./claude-resets.ts";
// The shared guard on what an image block may become. It lives in pi's adapter because it also
// resolves pi's `blob:sha256:` refs against pi's own store, and `bridge/server.ts` reaches for it
// from there for the same reason. The rule it enforces is not pi's, though: a journal is an AGENT's
// output, so an `http://` value in a block never becomes a fetch the phone makes.
import { resolveImageUrl } from "./pi.ts";
import {
  containedRealpath,
  exists,
  head,
  loadTail,
  readSinceFile,
  rootList,
  statFile,
  tailBytes,
} from "./files.ts";
import { clamp, type Clamped, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall, type Hunk, type ToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** A session uuid as Claude writes it — canonical 8-4-4-4-12 hex. Anything else never touches fs. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guard used before any path work. Exported so tests can pin the shape the fs layer relies on. */
export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** Inner text of the first `<tag>…</tag>`, trimmed; null when the tag isn't present. */
function inner(tag: string, text: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? (m[1] ?? "").trim() : null;
}

/** True when the content IS this envelope (rather than merely mentioning the tag in prose). */
function isEnvelope(tag: string, text: string): boolean {
  return text.trimStart().startsWith(`<${tag}>`);
}

/**
 * Classify a `user` row's string content.
 *
 * Only about half of these are things a human typed — Claude Code reuses the user role as the
 * carrier for injected plumbing. Measured across 60 session logs: 1196 string-content user rows, of
 * which 359 `task-notification`, 82 `local-command-caveat`, 82 `command-name`, 78
 * `local-command-stdout` and 21 `system-reminder` were envelopes rather than speech. Rendering those
 * verbatim as "You" would be actively wrong, so each is handled on its merits:
 *
 *  - `system-reminder` / `local-command-caveat` → DROPPED. Both are addressed to the model, never
 *    shown to the operator in the TUI (the caveat literally says "DO NOT respond to these").
 *  - `command-name` → a slash command the user really did run; shown as `/compact`, args included.
 *  - `local-command-stdout` → that command's output. Real, but not speech → a `note`.
 *  - `task-notification` → a background agent finishing. Reduced to its `<summary>` line → a `note`.
 *
 * Returns null for "drop this row entirely".
 */
export function classifyUserText(
  raw: string,
): { role: "user" | "note"; text: string } | null {
  const text = stripAnsi(raw);

  if (isEnvelope("system-reminder", text)) return null;
  if (isEnvelope("local-command-caveat", text)) return null;

  if (isEnvelope("command-name", text)) {
    const name = inner("command-name", text) ?? "";
    const args = inner("command-args", text) ?? "";
    const line = `${name} ${args}`.trim();
    return line === "" ? null : { role: "user", text: line };
  }

  if (isEnvelope("local-command-stdout", text)) {
    const stdout = inner("local-command-stdout", text) ?? "";
    return stdout === "" ? null : { role: "note", text: stdout };
  }

  if (isEnvelope("task-notification", text)) {
    const summary = inner("summary", text);
    return summary ? { role: "note", text: summary } : null;
  }

  return text.trim() === "" ? null : { role: "user", text };
}

/** Flatten a `tool_result.content`, which is either a plain string or a list of text blocks. */
function toolResultText(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b !== null && typeof b === "object" && !Array.isArray(b) && typeof b.text === "string"
      ? b.text
      : ""))
    .filter(Boolean)
    .join("\n");
}

/** A `tool` part's answered result — {@link Clamped} plus the error flag the result row carried. */
type ToolResult = Clamped & { isError?: boolean; denied?: boolean };

/**
 * An error result that is a REFUSAL, not a failure.
 *
 * Claude marks both with `is_error: true`, so the flag alone cannot tell "the command exited 1" from
 * "the person said no". Only the text can, and these are the phrasings observed in real logs (Claude
 * Code 2.1.146 to 2.1.284). A phrasing this misses degrades to `isError`, which is the old behaviour.
 */
const REFUSED =
  /The user doesn't want to proceed|Request interrupted by user for tool use|user rejected|was rejected|dismissed the question/i;

/** One row's `tool_result` payload, folded onto the call it answers. */
function toolResult(text: string, isError: boolean): ToolResult {
  const result: ToolResult = clamp(text, MAX_RESULT_CHARS);
  // Assigned, never conditionally spread: `isError` is ABSENT when false, not `false`.
  if (isError) result.isError = true;
  if (isError && REFUSED.test(text)) result.denied = true;
  return result;
}

/**
 * Enrich a classified call from the row's `toolUseResult`, which is where Claude records what the
 * call actually DID rather than what it was asked to do.
 *
 * Only an edit and a command carry anything worth reading there: `structuredPatch` is the diff Claude
 * computed against the file it wrote, and it is strictly better than anything reconstructable from
 * the input. The function MUTATES `call`, which already sits in an emitted entry — the same
 * in-place fold the result text uses, and for the same reason.
 */
function enrichCall(call: ToolCall, raw: JsonValue | undefined): void {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
  if (call.kind === "edit") {
    const patch = raw.structuredPatch;
    if (Array.isArray(patch) && patch.length > 0) {
      const hunks: Hunk[] = [];
      for (const h of patch) {
        if (h === null || typeof h !== "object" || Array.isArray(h)) continue;
        const lines = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === "string") : [];
        if (lines.length === 0) continue;
        hunks.push({
          header: `@@ -${String(h.oldStart ?? 0)},${String(h.oldLines ?? 0)} +${String(h.newStart ?? 0)},${String(h.newLines ?? 0)} @@`,
          lines,
        });
      }
      if (hunks.length > 0) {
        const all = hunks.flatMap((h) => h.lines);
        call.diff = hunks;
        call.added = all.filter((l) => l.startsWith("+")).length;
        call.removed = all.filter((l) => l.startsWith("-")).length;
      }
    }
    // A Write against nothing is a NEW file. `originalFile` absent or empty says so, and it is the
    // only signal here: the input looks identical either way.
    if (typeof raw.originalFile !== "string" || raw.originalFile === "") call.created = true;
  } else if (call.kind === "execute") {
    const code = raw.exitCode ?? raw.exit_code ?? raw.returnCode;
    if (typeof code === "number" && Number.isFinite(code)) call.exitCode = code;
  }
}

/** A log line, once JSON.parse has admitted it is an object at all. */
type RawRow = JsonObject;

/** What {@link ClaudeTranscriptSource.followContinuation} compares candidate siblings against. */
type LogStamp = { root: string | null; size: number; mtimeMs: number };

/**
 * Parse a Claude session log into oldest-first turns.
 *
 * PURE — no fs, no clock — so the whole grammar is unit-testable (`bun test`). Unparseable lines are
 * skipped rather than thrown on: a log is appended to live, so the final line can be a partial write,
 * and a tail-read window starts mid-line by construction.
 *
 * `includeSidechains` defaults false: subagent traffic is a different conversation and would swamp
 * the thread you opened.
 */
export function parseClaudeTranscript(
  text: string,
  opts: { includeSidechains?: boolean } = {},
): TranscriptEntry[] {
  return parseWith(createClaudeReducer(opts), text);
}

/**
 * A machine envelope the operator never typed, matched even when it carries attributes.
 *
 * {@link isEnvelope} is an exact `<tag>` test, which is all a `user` row's content needed: the four
 * envelopes that reach THAT branch carry none. The QUEUE carries two that do —
 * `<cross-session-message from="uds:/run/…">` and `<agent-message from="…">` — so it needs the wider
 * test. Both are plumbing Claude Code enqueues on its own behalf.
 */
function opensEnvelope(tag: string, text: string): boolean {
  const open = text.trimStart();
  return open.startsWith(`<${tag}>`) || open.startsWith(`<${tag} `);
}

/**
 * Envelopes that may sit in the queue and are NOT the operator's words.
 *
 * Counted over the 400 newest sessions on one host, 2026-10-01: of 5,738 `enqueue` rows,
 * `<task-notification>` is 4,906, `<cross-session-message …>` 513 and `<agent-message …>` about 16.
 * **286 are plain text** — the human's own. So 95 in 100 queued messages are Claude Code talking to
 * itself, and a queue drawn without this list is a screen of plumbing.
 *
 * A DENY list rather than an allow list, deliberately. An allow list of "what a human types" has no
 * end. If Claude Code adds a seventh envelope, one plumbing line appears in the queue row, which is
 * visible and fixable; an allow list would instead hide the operator's own message, which is not.
 */
const QUEUE_ENVELOPES = [
  "task-notification",
  "cross-session-message",
  "agent-message",
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "command-name",
] as const;

/**
 * The operator's own queued words, or null for anything else.
 *
 * `classifyUserText` is not reused here and the reason is worth stating: it MAPS plumbing onto
 * something showable — a `task-notification` becomes a `note` carrying its summary, which is right
 * for a turn that already happened and wrong for a queue. Nothing in the queue is a turn yet. The
 * only question is "did the operator type this", and the answer is yes or it is nothing.
 */
function queuedText(content: JsonValue | undefined): string | null {
  if (typeof content !== "string") return null;
  const text = stripAnsi(content).trim();
  if (text === "") return null;
  if (QUEUE_ENVELOPES.some((tag) => opensEnvelope(tag, text))) return null;
  return clamp(text, MAX_QUEUED_CHARS).text;
}

/**
 * How much of one queued message the wire carries.
 *
 * Short on purpose, and shorter than {@link MAX_TEXT_CHARS}: this is a reminder of what is waiting,
 * drawn on one row under a working mark, not the message itself. The message arrives as a real turn
 * the moment the agent starts on it, and that turn carries the whole thing.
 */
const MAX_QUEUED_CHARS = 200;

/**
 * THE MESSAGE QUEUE, as Claude Code records it. `RowReducer.queued`'s one real implementation.
 *
 * FOUR OPERATIONS, and the row shapes are measured over 11,181 `queue-operation` rows in the 400
 * newest sessions here (2026-10-01):
 *
 *   `enqueue` (5,602)  `content` — the message. Every row carries one.
 *   `dequeue` (2,931)  NO `content` at all. It says one came off, never which.
 *   `remove`  (2,647)  `content` and a `reason`: `absorbed_mid_turn` (2,546) or
 *                      `delivered_to_agent` (200). Both mean it left the queue.
 *   `popAll`  (1)      the whole queue is gone.
 *
 * `dequeue` carrying nothing is what makes this a FIFO and not a set: the front is the only item a
 * contentless "one came off" can mean. Replayed over those 400 files, a `dequeue` never once arrived
 * on an empty queue, so the front really is the answer. A `remove` asked for something not on the
 * list 107 times, which is the tail-read window starting after an enqueue, so a miss is ordinary and
 * costs nothing.
 *
 * WHAT THIS GETS WRONG, AND IN WHICH DIRECTION. A window that opened between an enqueue and its
 * dequeue pops the wrong front, so the answer can be short. It can never be long: every item on it
 * came off an `enqueue` row this reducer actually read. See `RowReducer.queued` for why short is the
 * side to be wrong on.
 */
interface QueueTracker {
  /** Fold one `queue-operation` row in. Anything unrecognised leaves the queue alone. */
  readonly apply: (row: JsonObject) => void;
  /** A SNAPSHOT, so a later `push` cannot change what a caller is holding. */
  readonly queued: () => readonly string[];
}

function createQueueTracker(): QueueTracker {
  let queue: string[] = [];
  return {
    apply(row) {
      const op = row.operation;
      if (op === "enqueue") {
        const text = queuedText(row.content);
        if (text === null) return;
        queue.push(text);
        // Oldest off, unlike `rememberPending`: the newest queued message is the one the operator
        // just typed and is looking for (see QUEUE_MAX).
        if (queue.length > QUEUE_MAX) queue.shift();
      } else if (op === "dequeue") {
        queue.shift();
      } else if (op === "remove") {
        const text = queuedText(row.content);
        // `indexOf`, so a message queued twice loses ONE copy. A filter would drop both.
        const at = text === null ? -1 : queue.indexOf(text);
        if (at !== -1) queue.splice(at, 1);
      } else if (op === "popAll") {
        queue = [];
      }
    },
    queued: () => [...queue],
  };
}

/**
 * Every row type and content-block type this adapter has MET, rendered or dropped (`reduce.ts` §
 * "what a reducer reports about what it could not read"). Anything else is counted and named.
 *
 * Measured on 2026-09-30 over the 500 newest session files in `~/.claude/projects`, which is the
 * whole inventory those files carry; `continued-in` and `summary` are added from the grammar above,
 * which reads both and which older logs carry.
 *
 * `image` is READ, into the same `TranscriptPart` place pi's adapter fills, so a pasted picture now
 * reaches the phone. It was listed here while it was dropped, which is why the tally never counted it.
 *
 * There is no role list: Claude decides a row's kind with the row's own `type`, and `message.role`
 * merely repeats it (measured: `user` and `assistant`, nothing else, in 84,525 rows). Nothing here
 * dispatches on it, so there is nothing it could fail to recognise.
 */
const CLAUDE_KNOWN: KnownTypes = {
  rows: [
    // Speech, and the two rows the grammar above reads for something other than speech.
    "user",
    "assistant",
    "continued-in",
    "summary",
    // Bookkeeping, in the order the 2026-09-30 sweep counted it.
    "attachment",
    "queue-operation",
    "last-prompt",
    "atis-latch",
    "system",
    "mode",
    "permission-mode",
    "custom-title",
    "agent-name",
    "ai-title",
    "file-history-snapshot",
    "file-history-delta",
    "cost-state",
    "fork-context-ref",
    "started",
    "result",
    "launched",
  ],
  roles: [],
  parts: ["text", "thinking", "tool_use", "tool_result", "image"],
};

/**
 * The same reading, one row at a time (see `reduce.ts`).
 *
 * The loop this replaces was already a reducer wearing a `for`: `pendingTools` was carried across
 * rows, and a `tool_result` MUTATED a part inside a turn the loop had already pushed. So the state a
 * reducer needs is the state the loop always kept, and the only genuinely new thing here is that the
 * mutation gets REPORTED — under a tail that turn is on somebody's screen.
 */
export function createClaudeReducer(opts: { includeSidechains?: boolean } = {}): RowReducer {
  // tool_use id → the part awaiting its result and the turn it went out in, so a `tool_result` row
  // lands on the call that made it and can name where that call is drawn.
  const pendingTools = new Map<string, PendingTool>();
  // What this reducer met and had no branch for, asked for once per session by the canary.
  const unknown = createUnknownCounter(CLAUDE_KNOWN);
  // The message queue, which is state and not a turn — one per generation, thrown away with the
  // reducer when a window resets (`journal/live.ts` § rebuild).
  const queue = createQueueTracker();

  // A nested `function` rather than a method on the returned object: the body below is the old loop
  // body at the indentation it always had, so this refactor is readable as the move it is.
  function push(line: string): Reduction {
    const entries: TranscriptEntry[] = [];
    const changed = new Set<string>();
    if (line.trim() === "") return NO_CHANGE;
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction — string/number/boolean/null or
      // an array/object of those. Naming it here is what keeps every field read below checked.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      return NO_CHANGE; // partial trailing write, or the clipped first line of a tail read
    }
    // A line that parses to a scalar (or a bare `null`, which used to reach `.type` and THROW) has
    // no row shape at all — skip it exactly as an unparseable line is skipped.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return NO_CHANGE;
    const row: RawRow = parsed;
    // `isMeta`: the operator did not write this row. Measured on Claude Code 2.1.146 to 2.1.283, a
    // meta row that also carries `promptSource: "system"` is a prompt Claude sent on its own: another
    // session's message, a scheduled or /loop wake-up, the continuation after a usage limit. The
    // turn after it answers it, so it stays, as a note and never as "You". Every other meta row is
    // addressed to the model (a skill body, an image's source path, a caveat) and is dropped.
    if (row.isMeta === true && row.promptSource !== "system") return NO_CHANGE;
    const type = row.type;
    // At the READ, not in the branch that declined: `CLAUDE_KNOWN.rows` holds every name below and
    // the counter drops those, so a type nobody has listed is the one thing that lands in the tally.
    unknown.row(type);
    // The one bookkeeping row that is READ rather than merely counted, and it makes no turn: what the
    // operator has typed and the agent has not started on. See {@link createQueueTracker}.
    if (type === "queue-operation") {
      queue.apply(row);
      return NO_CHANGE;
    }
    // EVERYTHING ELSE IS BOOKKEEPING, and it is a long list. Measured over 462 real session files on
    // 2026-09-30: `attachment`, `last-prompt`, `atis-latch`, `file-history-snapshot`, `mode`,
    // `permission-mode`, `ai-title`, `cost-state`, and `system` with subtypes
    // `turn_duration` and `stop_hook_summary`. None of it is conversation and all of it would be
    // noise on a phone. That list is a sample of the kinds; the COMPLETE inventory, including the
    // rows the 2026-09-30 sweep found and this sentence predates, is `CLAUDE_KNOWN` above.
    //
    // The one row anybody has argued for is `system` / `subtype: "compact_boundary"`, 281 of them
    // across those files, which is where Claude's own UI draws its compaction divider. It stays
    // dropped, and the reason is the pairing: those 281 boundaries come with exactly 281 `user` rows
    // carrying `isCompactSummary`, which this reducer keeps and gives `role: "summary"`. So a
    // compaction is already visible and already set apart from speech; the boundary row would add a
    // second mark for the same event, and widening this gate to admit it means admitting a subtype
    // test into the one line that keeps 1,060 `attachment` rows off the screen.
    if (type !== "user" && type !== "assistant") return NO_CHANGE;
    if (row.isSidechain === true && !opts.includeSidechains) return NO_CHANGE;

    const message = row.message;
    if (message === null || message === undefined || typeof message !== "object" || Array.isArray(message)) return NO_CHANGE;
    const content = message.content;
    // The block walk below is an `else if` chain over four types; this is where a fifth is counted.
    noteBlockTypes(unknown, content);
    const uuid = typeof row.uuid === "string" ? row.uuid : "";
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";
    const parts: TranscriptPart[] = [];
    // Set by a `user` row that is not the operator's speech: a prompt Claude sent on its own (the
    // only meta row left here), or string content that turns out to be injected plumbing.
    let roleOverride: "note" | undefined = row.isMeta === true ? "note" : undefined;

    if (typeof content === "string") {
      // A string content is the HUMAN-turn carrier — but Claude Code also routes injected plumbing
      // through it, so classify before believing it (see classifyUserText).
      const classified = classifyUserText(content);
      if (classified === null) return NO_CHANGE;
      if (classified.role === "note") roleOverride = "note";
      parts.push({ kind: "text", ...clamp(classified.text, MAX_TEXT_CHARS) });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        // A `continue` over the BLOCK, not the row: the other blocks of this turn still count.
        if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
        if (b.type === "text" && typeof b.text === "string") {
          if (b.text.trim() !== "")
            parts.push({ kind: "text", ...clamp(stripAnsi(b.text), MAX_TEXT_CHARS) });
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          if (b.thinking.trim() !== "")
            parts.push({ kind: "thinking", ...clamp(stripAnsi(b.thinking), MAX_TEXT_CHARS) });
        } else if (b.type === "image") {
          // Claude's own image shape, measured over 17 blocks in the 500 newest sessions here:
          // `{ type: "image", source: { type: "base64", media_type, data } }`, png or jpeg. It is
          // NOT pi's `{ data, mimeType }`, which is why the shared resolver is fed the two fields
          // rather than the block. A `source.type` of `url` is refused for pi's reason: a reference
          // this build will not load contributes no part, rather than a broken <img>.
          const source = b.source;
          const src = source !== null && typeof source === "object" && !Array.isArray(source) ? source : {};
          const mimeType = typeof src.media_type === "string" ? src.media_type : undefined;
          const url = src.type === "base64" && typeof src.data === "string" ? resolveImageUrl(src.data, mimeType) : null;
          if (url !== null) {
            // Assigned, never conditionally spread: an unnamed mime type leaves the key OFF.
            const part: Extract<TranscriptPart, { kind: "image" }> = { kind: "image", url };
            if (mimeType !== undefined) part.mimeType = mimeType;
            parts.push(part);
          }
        } else if (b.type === "tool_use") {
          const name = typeof b.name === "string" ? b.name : "tool";
          const summary = summarizeToolInput(b.input);
          const part: Extract<TranscriptPart, { kind: "tool" }> = {
            kind: "tool",
            name,
            summary,
            call: classifyToolCall(name, b.input, summary),
          };
          if (typeof b.id === "string") {
            part.id = b.id;
            // The turn is named here, before it exists, because `uuid` is read off the row above and
            // the part is already the object the turn will carry. `rememberPending` is what keeps an
            // orphan call from growing this map for the life of a session.
            rememberPending(pendingTools, b.id, { part, uuid });
          }
          parts.push(part);
        } else if (b.type === "tool_result") {
          // Fold onto the call that produced it. The awaited part is MUTATED in place — it already
          // sits in an emitted entry, which is exactly why results attach without reordering anything.
          const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
          const target = pendingTools.get(id);
          // Tool output routinely carries colour codes (any command run through a shell) — strip
          // them, since this view renders text nodes rather than interpreting escapes.
          const resultText = stripAnsi(toolResultText(b.content));
          if (target) {
            pendingTools.delete(id);
            target.part.result = toolResult(resultText, b.is_error === true);
            // `toolUseResult` rides on the ROW, not on the content block: it is Claude's own record of
            // what the call did, and it is the only place a diff or an exit code ever appears.
            if (target.part.call) enrichCall(target.part.call, row.toolUseResult);
            // The mutation above landed in a turn that went out rows ago. Name it.
            changed.add(target.uuid);
          } else if (resultText.trim() !== "") {
            // Orphan result (its call fell outside a tail-read window) — keep it, unattached, so the
            // window never silently drops output.
            parts.push({
              kind: "tool",
              name: "result",
              summary: "",
              result: toolResult(resultText, b.is_error === true),
            });
          }
        }
      }
    }

    // A row with nothing to SHOW, which is not the same as a row that did nothing: the common case
    // here is a `tool_result` row whose result folded onto a call in an earlier turn, so it adds no
    // turn of its own and has still changed one. `NO_CHANGE` here would drop that report on the floor
    // and leave the folded result invisible to a tail, which is the one fault this spec exists to fix.
    if (parts.length === 0) return reduction(entries, changed);
    const role: TranscriptEntry["role"] =
      row.isCompactSummary === true
        ? "summary"
        : type === "assistant"
          ? "assistant"
          : (roleOverride ?? "user");
    entries.push({ uuid, ts, role, parts });
    return reduction(entries, changed);
  }

  return { push, unknowns: unknown.tally, queued: queue.queued };
}

/**
 * The uuid of a log's first entry — its conversation ROOT.
 *
 * Claude Code does not keep one file per conversation. Resuming a session (and `/fork`, and
 * promotion to a background job) COPIES the whole thread into a fresh `<new-uuid>.jsonl` and
 * continues there, while Herdr keeps reporting whichever id the agent last announced. Observed live:
 * Herdr named a log frozen at 18:12 while the conversation had been continuing in a different file
 * until 20:59 — nearly three hours of history simply invisible.
 *
 * Every copy preserves the original first entry, so the root uuid identifies the lineage: three logs
 * of one conversation all began `bcb07539-…`, while unrelated sessions in the same directory each had
 * their own. Exported for the tests.
 */
export function conversationRoot(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      // SAFETY: JSON.parse output is a JsonValue by construction (see parseClaudeTranscript).
      const row = JSON.parse(line) as JsonValue;
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      if (typeof row.uuid === "string" && row.uuid !== "") return row.uuid;
    } catch {
      continue; // a clipped/partial line — keep looking
    }
  }
  return null;
}

/** Enough hops for any real chain of hand-overs; a bound so a cycle, or a planted chain, cannot spin a poll. */
const MAX_HAND_OVERS = 8;

/**
 * How much of a log's END is read to find a hand-over. The record is the old log's last word, followed
 * at most by a few bookkeeping rows (one `cost-state` of about 1 KB in the case on record).
 */
const HAND_OVER_TAIL_BYTES = 64 * 1024;

/**
 * The session a log was HANDED OVER to, if its end says so, or null. PURE.
 *
 * Claude Code can move a live conversation into a new session file and leave
 * `{"type":"continued-in","continuedInSessionId":…}` as the last word of the old one, while Herdr keeps
 * reporting the OLD id. Walked newest-first, and an assistant turn met before the record means the old
 * log is live again (a resumed session writes turns after it), so there is no hand-over to follow.
 * Only a canonical session uuid is returned, because the id becomes a file name.
 *
 * Unlike {@link conversationRoot}'s heuristic this is Claude Code's own statement, so it needs no
 * guard on size or mtime: the old log goes on being written after the hand-over (its `cost-state`),
 * and a fresh continuation can be both smaller and older than it.
 */
export function handedOverTo(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]?.trim();
    if (raw === undefined || raw === "") continue;
    // Cheap first: most rows are neither, and this runs on the poll loop.
    if (!raw.includes('"assistant"') && !raw.includes('"continued-in"')) continue;
    let row: JsonValue;
    try {
      // SAFETY: JSON.parse output is a JsonValue by construction (see parseClaudeTranscript).
      row = JSON.parse(raw) as JsonValue;
    } catch {
      continue; // a clipped first line, or a partial write at the end
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    if (row.type === "assistant" && row.isSidechain !== true) return null;
    if (row.type !== "continued-in") continue;
    const id = row.continuedInSessionId;
    return typeof id === "string" && isSessionId(id) ? id : null;
  }
  return null;
}

/**
 * Real filesystem source rooted at Claude's projects directory.
 *
 * Resolution is by UUID SCAN, not by reconstructing the mangled project-directory name from the
 * pane's cwd. The mangling is lossy (every non-alphanumeric becomes "-") and, worse, a pane's
 * reported cwd drifts as the agent works — a subdirectory cwd would derive a directory that doesn't
 * exist. Session uuids are globally unique, so scanning the project dirs for `<uuid>.jsonl` is both
 * correct and cheap (measured: ~14 ms across 306 logs, and the hit is then cached).
 *
 * MORE THAN ONE ROOT is normal here: `CLAUDE_CONFIG_DIR` gives each Claude profile its own projects
 * tree, and a herd can hold panes from several (issue #92). The roots are searched IN ORDER and the
 * first one holding the uuid wins — and that is not a heuristic, it is the same global uniqueness the
 * scan already relies on: two roots cannot disagree about who a uuid belongs to. No profile detection
 * exists or is needed. The root that produced a hit is remembered with it, because everything after
 * resolution (continuation-following, and the containment check that guards it) must stay inside THAT
 * root rather than whichever root happened to be configured first.
 */
export class ClaudeTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, { path: string; root: string }>();

  /**
   * What each log's end said about a hand-over, stamped with the size and mtime it was read at. The
   * tracker resolves every floor tick, and a log that has not moved cannot have said anything new.
   */
  private readonly handOvers = new Map<string, { size: number; mtimeMs: number; next: string | null }>();

  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    // Claude always reports an id. A path-kind ref for this agent is not something we've ever seen,
    // and inventing a meaning for it would widen the fs surface for no gain.
    if (ref.kind !== "id" || !isSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      // Re-verify: a cached path can vanish when a session is deleted.
      //
      // The cache memoises only the EXPENSIVE part — the global scan that maps a uuid to its file,
      // which never changes. Continuation-following must still run on every call, because the
      // conversation rotates into a new file WHILE the bridge is up: caching its result would pin the
      // answer to whatever was true at the first request and go stale minutes later.
      if (await exists(cached.path)) return this.follow(cached.path, cached.root);
      this.pathCache.delete(sessionId);
    }

    for (const root of this.roots) {
      const real = await this.scanRoot(sessionId, root);
      if (real === null) continue;
      this.pathCache.set(sessionId, { path: real, root });
      return this.follow(real, root);
    }
    return null;
  }

  /**
   * One root's projects directories, searched for `<sessionId>.jsonl`. The contained real path, or null.
   *
   * Null covers both "not here" and "here, but pointing out of this root": the caller moves on to the
   * next root either way.
   */
  private async scanRoot(sessionId: string, root: string): Promise<string | null> {
    const file = `${sessionId}.jsonl`;
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return null; // this projects dir doesn't exist — a profile that isn't on this machine
    }
    for (const dir of dirs) {
      const candidate = join(root, dir, file);
      if (!(await exists(candidate))) continue;
      // A log by this name exists here but points out of this root, so it is not this root's to serve —
      // and we do not go on to accept it under a sibling root either (files.ts header). Abandoning the
      // root rather than the whole search is the only multi-root difference: a planted symlink in one
      // profile can't blank the history of the others.
      return containedRealpath(candidate, root);
    }
    return null;
  }

  /**
   * Everything that runs after a uuid has been mapped to its file, on EVERY call: first Claude Code's
   * own hand-over record, then the conversation-root heuristic from wherever that landed.
   */
  private async follow(path: string, root: string): Promise<string> {
    return this.followContinuation(await this.followHandOver(path, root), root);
  }

  /**
   * Follow `continued-in` records to the log the conversation moved to, at most {@link MAX_HAND_OVERS}
   * hops, and never outside the root the chain started in.
   *
   * This is the resolve seam, so the cache probe, the tracker's stat and the history route all read the
   * log that is still being written, not the one Herdr keeps naming.
   */
  private async followHandOver(path: string, root: string): Promise<string> {
    const visited = new Set([path]);
    let current = path;
    for (let hop = 0; hop < MAX_HAND_OVERS; hop++) {
      const next = await this.handOverOf(current);
      if (next === null) break;
      const found = await this.locate(next, root, dirname(current));
      // A cycle, or a hand-over to a file that is not there (yet): stay on the last log that exists.
      if (found === null || visited.has(found)) break;
      visited.add(found);
      this.pathCache.set(next, { path: found, root });
      current = found;
    }
    return current;
  }

  /** What `path`'s end says about a hand-over, read once per size and mtime. Null on any failure. */
  private async handOverOf(path: string): Promise<string | null> {
    const st = await statFile(path);
    if (st === null) return null;
    const known = this.handOvers.get(path);
    if (known !== undefined && known.size === st.size && known.mtimeMs === st.mtimeMs) return known.next;
    let next: string | null = null;
    try {
      const read = await tailBytes(path, HAND_OVER_TAIL_BYTES);
      const lines = read.text.split("\n");
      next = handedOverTo(read.complete ? lines : lines.slice(1));
    } catch {
      next = null;
    }
    this.handOvers.set(path, { size: st.size, mtimeMs: st.mtimeMs, next });
    return next;
  }

  /**
   * Where a handed-over session's log lives: beside the log that named it first, since a hand-over
   * stays in one project, then the rest of the SAME root. Containment is checked on the real path
   * either way, so a sibling symlinked out of the root is never read.
   */
  private async locate(sessionId: string, root: string, beside: string): Promise<string | null> {
    const sibling = join(beside, `${sessionId}.jsonl`);
    if (await exists(sibling)) {
      const real = await containedRealpath(sibling, root);
      if (real !== null) return real;
    }
    return this.scanRoot(sessionId, root);
  }

  /**
   * Follow a rotated conversation to the log it actually continues in.
   *
   * The id Herdr reports can name a FROZEN PREFIX (see {@link conversationRoot}), so serving it
   * verbatim silently drops everything since the rotation. We look for siblings sharing this log's
   * root uuid and prefer the most recently written one.
   *
   * Two guards keep this from making things worse:
   *  - a candidate must be at least as large as the log we already have, so following can never show
   *    LESS history than not following;
   *  - only the first line of each sibling is read (plus a stat), so the scan is a few milliseconds
   *    over a directory of ~40 logs. That matters, because `resolve` runs on the cache tracker's
   *    floor tick as well as on a History tap.
   *
   * A sibling whose own end records a hand-over is never picked: {@link handedOverTo} is Claude
   * Code's statement that the conversation left it, and that outranks a guess from size and mtime.
   *
   * Known limit: a `/fork` of the same conversation shares the root too, so a fork being written more
   * recently than the pane's own session would win. That needs a per-pane session id Herdr doesn't
   * expose; showing the freshest branch of the right conversation beats showing a stale one.
   */
  private async followContinuation(path: string, root: string): Promise<string> {
    const dir = dirname(path);
    let self: LogStamp;
    try {
      const st = await stat(path);
      self = { root: conversationRoot(await head(path)), size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return path;
    }
    if (self.root === null) return path;

    let best = { path, size: self.size, mtimeMs: self.mtimeMs };
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return path;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const candidate = join(dir, name);
      if (candidate === path) continue;
      try {
        const st = await stat(candidate);
        if (st.mtimeMs <= best.mtimeMs || st.size < self.size) continue;
        // Containment AGAIN, before a byte of the candidate is read. The directory got here from a
        // path `resolve` already validated, but a sibling INSIDE it can still be a symlink out of the
        // root — and anything that writes into the projects tree can plant one. Following it would
        // read a file the journal never owned, which is exactly what files.ts promises it can't.
        const real = await containedRealpath(candidate, root);
        if (real === null) continue;
        if (conversationRoot(await head(real)) !== self.root) continue;
        // A log that ends in a hand-over is dead by its own account, however new and big it looks: the
        // old process goes on appending to it after the move, which is exactly what made this
        // heuristic walk back into it from the live log.
        if ((await this.handOverOf(real)) !== null) continue;
        best = { path: real, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        continue; // unreadable sibling — ignore it rather than fail the whole read
      }
    }
    return best.path;
  }

  stat = statFile;

  load = loadTail;

  /**
   * The live read, and the hand-over comes free with it.
   *
   * `resolve` already follows `continued-in` to the log the conversation moved to, so a hand-over
   * shows up here as the KEY changing under a cursor taken on the old one. The cursor carries a hash
   * of the key it was taken on, so it stops matching, and the read resets — which is the truth: the
   * new log is a new file with its own byte offsets, and the turns in it are not an append to the
   * turns in the old one. No hand-over code lives in this method, and none should.
   */
  readSince = readSinceFile;
}

/**
 * Claude's journal adapter. `agent` matches the Herdr snapshot's `agent` string.
 *
 * `roots` is one projects directory or several (one per `CLAUDE_CONFIG_DIR` profile), searched in
 * order.
 */
export function claudeJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new ClaudeTranscriptSource(roots);
  return {
    agent: "claude",
    source,
    parse: (text) => parseClaudeTranscript(text),
    reducer: () => createClaudeReducer(),
    cacheProbe: (ref) => claudeCacheProbe(source, ref),
  };
}

// ── The prompt-cache probe ───────────────────────────────────────────────────
//
// Claude is the best-served harness here for the same reason it is the best-served journal: every
// assistant entry carries `message.usage`, and that one object answers BOTH questions the cache chip
// exists for.
//
//   cache_read_input_tokens = 0 with a real write behind it  → the turn MISSED
//   cache_creation.ephemeral_1h_input_tokens > 0             → this session is on the ONE-HOUR TTL
//
// The second is why no pane ever shows a guessed number for Claude. The same entry that gives
// `lastRequestAt` says which window was written, so the FIRST reading is already measured — there is
// no one-turn-wrong answer to live through (ADR 0041, Decision 1). Ported from herdr-cache-alert
// `src/harness/claude.ts:269-291`.

/** Claude's `usage.cache_creation` split, as far as the probe cares. */
function ttlFromUsage(usage: JsonObject, path: string): Sourced<number> | undefined {
  const split = asRecord(usage.cache_creation);
  if (split === null) return undefined;
  const hour = tokenCount(split.ephemeral_1h_input_tokens) ?? 0;
  const fiveMin = tokenCount(split.ephemeral_5m_input_tokens) ?? 0;
  if (hour > 0) return observedClaim(3600, `${String(hour)} tokens written to the 1h cache in ${path}`);
  if (fiveMin > 0) return observedClaim(300, `${String(fiveMin)} tokens written to the 5m cache in ${path}`);
  return undefined;
}

/**
 * The newest turn's reading, plus every reset event around it.
 *
 * One walk of the same 128 KB tail finds the newest turn and the turn before it
 * (`claude-resets.ts` § lastTwoTurns). The newest answers the clock and the telemetry, as it always
 * has; the two stretches around it answer "did an action drop the cache" (issue #236). A subagent's
 * record and a `<synthetic>` notice are not turns, because neither is a request on this cache.
 */
async function claudeCacheProbe(
  source: ClaudeTranscriptSource,
  ref: AgentSessionRef,
): Promise<CacheProbe | null> {
  const tail = await probeTail(source, ref);
  if (tail === null) return null;
  const turns = lastTwoTurns(tail.lines);
  // The tail held no assistant turn at all — a session that has only just started, or one turn larger
  // than the window. The tracker keeps whatever the last successful probe left behind.
  if (turns === null) return null;
  const { entry, message, at, stamp } = turns.newest;
  const usage = asRecord(message.usage) ?? {};
  const probe: CacheProbe = {
    lastRequestAt: at,
    turnId: asText(message.id) ?? asText(entry.uuid) ?? String(at),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: tokenCount(usage.cache_creation_input_tokens) ?? 0,
    measuredAt: tail.mtimeMs,
    evidence: `${tail.path} (${stamp})`,
  };
  const observed = ttlFromUsage(usage, tail.path);
  if (observed !== undefined) probe.observedTtlSeconds = observed;
  const model = asText(message.model);
  if (model !== undefined) probe.model = model;
  const resets = claudeResets(turns, tail.path);
  if (resets.length > 0) probe.resets = resets;
  return probe;
}
