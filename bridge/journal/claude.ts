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
// Human turns carry a STRING content; a `user` row whose content is a LIST is tool-result traffic,
// not something the user typed — we fold those into the tool call that produced them rather than
// rendering 705 fake "user" turns. `isSidechain` marks subagent traffic (dropped by default);
// `isCompactSummary` marks the summary Claude writes when a session is compacted.

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { containedRealpath, exists, head, loadTail, rootList, statFile } from "./files.ts";
import { clamp, type Clamped, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
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
type ToolResult = Clamped & { isError?: boolean };

/** One row's `tool_result` payload, folded onto the call it answers. */
function toolResult(text: string, isError: boolean): ToolResult {
  const result: ToolResult = clamp(text, MAX_RESULT_CHARS);
  // Assigned, never conditionally spread: `isError` is ABSENT when false, not `false`.
  if (isError) result.isError = true;
  return result;
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
  const entries: TranscriptEntry[] = [];
  // tool_use id → the part awaiting its result, so a `tool_result` row lands on the call that made it.
  const pendingTools = new Map<string, Extract<TranscriptPart, { kind: "tool" }>>();

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction — string/number/boolean/null or
      // an array/object of those. Naming it here is what keeps every field read below checked.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      continue; // partial trailing write, or the clipped first line of a tail read
    }
    // A line that parses to a scalar (or a bare `null`, which used to reach `.type` and THROW) has
    // no row shape at all — skip it exactly as an unparseable line is skipped.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const row: RawRow = parsed;
    const type = row.type;
    if (type !== "user" && type !== "assistant") continue;
    if (row.isSidechain === true && !opts.includeSidechains) continue;

    const message = row.message;
    if (message === null || message === undefined || typeof message !== "object" || Array.isArray(message)) continue;
    const content = message.content;
    const uuid = typeof row.uuid === "string" ? row.uuid : "";
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";
    const parts: TranscriptPart[] = [];
    // Set by a `user` row whose string content turns out to be injected plumbing rather than speech.
    let roleOverride: "note" | undefined;

    if (typeof content === "string") {
      // A string content is the HUMAN-turn carrier — but Claude Code also routes injected plumbing
      // through it, so classify before believing it (see classifyUserText).
      const classified = classifyUserText(content);
      if (classified === null) continue;
      if (classified.role === "note") roleOverride = "note";
      parts.push({ kind: "text", ...clamp(classified.text, MAX_TEXT_CHARS) });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
        if (b.type === "text" && typeof b.text === "string") {
          if (b.text.trim() !== "")
            parts.push({ kind: "text", ...clamp(stripAnsi(b.text), MAX_TEXT_CHARS) });
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          if (b.thinking.trim() !== "")
            parts.push({ kind: "thinking", ...clamp(stripAnsi(b.thinking), MAX_TEXT_CHARS) });
        } else if (b.type === "tool_use") {
          const part: Extract<TranscriptPart, { kind: "tool" }> = {
            kind: "tool",
            name: typeof b.name === "string" ? b.name : "tool",
            summary: summarizeToolInput(b.input),
          };
          if (typeof b.id === "string") pendingTools.set(b.id, part);
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
            target.result = toolResult(resultText, b.is_error === true);
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

    if (parts.length === 0) continue; // bookkeeping row with nothing to show
    const role: TranscriptEntry["role"] =
      row.isCompactSummary === true
        ? "summary"
        : type === "assistant"
          ? "assistant"
          : (roleOverride ?? "user");
    entries.push({ uuid, ts, role, parts });
  }

  return entries;
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
      if (await exists(cached.path)) return this.followContinuation(cached.path, cached.root);
      this.pathCache.delete(sessionId);
    }

    const file = `${sessionId}.jsonl`;
    for (const root of this.roots) {
      let dirs: string[];
      try {
        dirs = await readdir(root);
      } catch {
        continue; // this projects dir doesn't exist — a profile that isn't on this machine
      }
      for (const dir of dirs) {
        const candidate = join(root, dir, file);
        if (!(await exists(candidate))) continue;
        const real = await containedRealpath(candidate, root);
        if (real === null) {
          // A log by this name exists here but points out of this root, so it is not this root's to
          // serve — and we do not go on to accept it under a sibling root either (files.ts header).
          // Abandoning the root rather than the whole search is the only multi-root difference: a
          // planted symlink in one profile can't blank the history of the others.
          break;
        }
        this.pathCache.set(sessionId, { path: real, root });
        return this.followContinuation(real, root);
      }
    }
    return null;
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
   *    over a directory of ~40 logs — and this route is on-demand, never on the poll loop.
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
        best = { path: real, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        continue; // unreadable sibling — ignore it rather than fail the whole read
      }
    }
    return best.path;
  }

  stat = statFile;

  load = loadTail;
}

/**
 * Claude's journal adapter. `agent` matches the Herdr snapshot's `agent` string.
 *
 * `roots` is one projects directory or several (one per `CLAUDE_CONFIG_DIR` profile), searched in
 * order.
 */
export function claudeJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "claude",
    source: new ClaudeTranscriptSource(roots),
    parse: (text) => parseClaudeTranscript(text),
  };
}
