// Agent transcript history — the scrollback Herdr structurally cannot give us.
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
// record (`agent_session.value`). This module turns that log into a bounded, typed transcript the
// phone can page through. It is strictly BETTER than terminal scrollback would have been: real
// message boundaries, timestamps, tool calls folded together with their results, and it survives the
// pane being closed.
//
// SHAPE OF THE SOURCE (verified against Claude Code 2.1.220, 2026-07-26):
//   {"type":"user",      "message":{"role":"user","content":"..." | [ {type:"tool_result",...} ]}, ...}
//   {"type":"assistant", "message":{"role":"assistant","content":[ {type:"text"|"thinking"|"tool_use"} ]}}
//   plus bookkeeping rows we ignore (mode, permission-mode, ai-title, file-history-*, queue-operation…).
// Human turns carry a STRING content; a `user` row whose content is a LIST is tool-result traffic,
// not something the user typed — we fold those into the tool call that produced them rather than
// rendering 705 fake "user" turns. `isSidechain` marks subagent traffic (dropped by default);
// `isCompactSummary` marks the summary Claude writes when a session is compacted.
//
// SECURITY. This reads files, which nothing else in the bridge does, so the path is pinned shut:
//  - the client never supplies a path — only a pane id, which we map to a session uuid server-side;
//  - the uuid must match a strict v4-shaped pattern before it is ever concatenated into a path;
//  - the resolved file must still be inside the transcript root after symlink resolution;
//  - reads are byte-capped, so a pathological log can't balloon the bridge's memory.
// The transcript is exactly as sensitive as the pane mirror Collie already serves (it is the same
// conversation), but it reaches further back — `COLLIE_TRANSCRIPT=off` disables the feature wholesale.

import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

/** First bytes of a file — enough to find the root entry without reading a multi-megabyte log. */
async function head(path: string, bytes = 64 * 1024): Promise<string> {
  return Bun.file(path).slice(0, bytes).text();
}

/** A session uuid as Claude writes it — canonical 8-4-4-4-12 hex. Anything else never touches fs. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Most bytes we will ever pull off one transcript. Beyond this we keep the TAIL (newest turns). */
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024; // 32 MB

/** Per-tool-result cap. Tool output is unbounded (a 2 MB file read); the phone only needs a gist. */
const MAX_RESULT_CHARS = 2000;

/** Per-text-part cap. Generous — assistant prose is the thing you actually came to read. */
const MAX_TEXT_CHARS = 20_000;

/** How many parsed transcripts to keep hot. Each is re-parsed only when the file's size/mtime moves. */
const CACHE_MAX = 4;

/** One renderable piece of a turn. Deliberately small — the phone renders these as text nodes. */
export type TranscriptPart =
  | { kind: "text"; text: string; truncated?: boolean }
  /**
   * Extended-thinking text. In practice this NEVER fires: Claude Code writes `thinking` blocks whose
   * `thinking` field is an empty string, keeping only the encrypted `signature` (verified 2026-07-26:
   * 3944 of 3944 blocks across 40 session logs were empty). The branch stays because the block type is
   * real and not ours to control — if a future version persists the text, it renders instead of vanishing.
   */
  | { kind: "thinking"; text: string; truncated?: boolean }
  /** A tool call. `result` is filled in from the `tool_result` row that answers it, when one exists. */
  | {
      kind: "tool";
      name: string;
      /** One-line gist of the call's input (the file read, the command run) — never the whole input. */
      summary: string;
      result?: { text: string; truncated?: boolean; isError?: boolean };
    };

/**
 * One turn of the conversation.
 *
 * `user`/`assistant` are speech. The other two are NOT, and are rendered set apart so they can't be
 * mistaken for it: `summary` is Claude's own compaction summary, and `note` is machine-injected
 * content that still belongs on screen (a background task finishing, a local command's output).
 */
export interface TranscriptEntry {
  /** The source row's uuid — stable, and the paging cursor (`before`). */
  uuid: string;
  /** ISO timestamp from the log; empty when the row carried none. */
  ts: string;
  role: "user" | "assistant" | "summary" | "note";
  parts: TranscriptPart[];
}

/** What the history endpoint answers with. */
export interface TranscriptPage {
  paneId: string;
  /** Oldest-first, ready to render top-down. */
  entries: TranscriptEntry[];
  /** True when older turns exist before `entries[0]` — drives "load older". */
  hasMore: boolean;
  /** Total turns available in the parsed window (after sidechain filtering). */
  total: number;
  /** True when the on-disk log exceeded the byte cap and we kept only its tail. */
  fileTruncated: boolean;
}

// ── pure parsing ──────────────────────────────────────────────────────────────

/** Guard used before any path work. Exported so the route can 400 on a malformed id explicitly. */
export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

// CSI/SGR and two-character escapes. Transcript text is NOT a terminal mirror — nothing downstream
// interprets escapes, so a `\x1b[2m` left in place renders as garbage glyphs on the phone.
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_]/g;

/** Strip terminal escapes from log text. Exported for the parser's tests. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
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

function clamp(text: string, max: number): { text: string; truncated?: boolean } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}

/**
 * Collapse a tool call's input into one readable line. The well-known tools get their defining
 * argument (the path, the command, the pattern); anything else falls back to the first string-ish
 * value, so a tool this code has never heard of still reads as something rather than "{...}".
 */
export function summarizeToolInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    return undefined;
  };
  // Order matters: the MOST defining argument first. Grep carries both `pattern` and `path`, and the
  // pattern is what you actually searched for; Task carries both `description` and `prompt`, and the
  // description is already the one-line form.
  const chosen =
    pick("file_path", "command", "pattern", "query", "url", "path", "description", "prompt") ??
    // Unknown tool: first string value wins, so the line is never empty for no reason.
    Object.values(o).find((v): v is string => typeof v === "string" && v.trim() !== "");
  if (chosen === undefined) return "";
  // Tool inputs can be multi-line (a Bash heredoc); a summary is one line by definition.
  const oneLine = chosen.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/** Flatten a `tool_result.content`, which is either a plain string or a list of text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
      ? (b as { text: string }).text
      : ""))
    .filter(Boolean)
    .join("\n");
}

interface RawRow {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  message?: { role?: unknown; content?: unknown } | unknown;
}

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
export function parseTranscript(
  text: string,
  opts: { includeSidechains?: boolean } = {},
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // tool_use id → the part awaiting its result, so a `tool_result` row lands on the call that made it.
  const pendingTools = new Map<string, Extract<TranscriptPart, { kind: "tool" }>>();

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: RawRow;
    try {
      row = JSON.parse(line) as RawRow;
    } catch {
      continue; // partial trailing write, or the clipped first line of a tail read
    }
    const type = row.type;
    if (type !== "user" && type !== "assistant") continue;
    if (row.isSidechain === true && !opts.includeSidechains) continue;

    const message = row.message;
    if (message === null || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
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
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
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
            target.result = {
              ...clamp(resultText, MAX_RESULT_CHARS),
              ...(b.is_error === true ? { isError: true } : {}),
            };
          } else if (resultText.trim() !== "") {
            // Orphan result (its call fell outside a tail-read window) — keep it, unattached, so the
            // window never silently drops output.
            parts.push({
              kind: "tool",
              name: "result",
              summary: "",
              result: {
                ...clamp(resultText, MAX_RESULT_CHARS),
                ...(b.is_error === true ? { isError: true } : {}),
              },
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
 * Page a parsed transcript, newest-anchored: with no cursor you get the LAST `limit` turns (the phone
 * opens at the recent end, like the mirror it replaces); `before` walks backwards from a turn you
 * already hold. Returned entries stay oldest-first so the view renders top-down either way.
 */
export function pageEntries(
  entries: TranscriptEntry[],
  opts: { limit: number; before?: string },
): { window: TranscriptEntry[]; hasMore: boolean } {
  // An unknown cursor (log rewritten under us, or a stale client) degrades to "newest", never to an
  // empty page — the user asked for older history and must still see something.
  const end =
    opts.before === undefined
      ? entries.length
      : (() => {
          const i = entries.findIndex((e) => e.uuid === opts.before);
          return i === -1 ? entries.length : i;
        })();
  const start = Math.max(0, end - opts.limit);
  return { window: entries.slice(start, end), hasMore: start > 0 };
}

// ── fs-backed store ───────────────────────────────────────────────────────────

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
      const row = JSON.parse(line) as { uuid?: unknown };
      if (typeof row.uuid === "string" && row.uuid !== "") return row.uuid;
    } catch {
      continue; // a clipped/partial line — keep looking
    }
  }
  return null;
}

/** The fs seam. Real implementation below; tests inject a fake so no temp files are needed. */
export interface TranscriptSource {
  /** Absolute path of the log for `sessionId`, or null when it isn't on disk. */
  resolve(sessionId: string): Promise<string | null>;
  /** Tail-read a log. `complete` is false when the byte cap clipped the head. */
  load(path: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }>;
}

/**
 * Real filesystem source rooted at Claude's projects directory.
 *
 * Resolution is by UUID SCAN, not by reconstructing the mangled project-directory name from the
 * pane's cwd. The mangling is lossy (every non-alphanumeric becomes "-") and, worse, a pane's
 * reported cwd drifts as the agent works — a subdirectory cwd would derive a directory that doesn't
 * exist. Session uuids are globally unique, so scanning the project dirs for `<uuid>.jsonl` is both
 * correct and cheap (measured: ~14 ms across 306 logs, and the hit is then cached).
 */
export class ClaudeTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();

  constructor(private readonly root: string) {}

  async resolve(sessionId: string): Promise<string | null> {
    if (!isSessionId(sessionId)) return null; // never build a path from an unvalidated id
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      // Re-verify: a cached path can vanish when a session is deleted.
      //
      // The cache memoises only the EXPENSIVE part — the global scan that maps a uuid to its file,
      // which never changes. Continuation-following must still run on every call, because the
      // conversation rotates into a new file WHILE the bridge is up: caching its result would pin the
      // answer to whatever was true at the first request and go stale minutes later.
      if (await exists(cached)) return this.followContinuation(cached);
      this.pathCache.delete(sessionId);
    }

    let dirs: string[];
    try {
      dirs = await readdir(this.root);
    } catch {
      return null; // no ~/.claude/projects at all — feature simply has nothing to serve
    }
    const file = `${sessionId}.jsonl`;
    for (const dir of dirs) {
      const candidate = join(this.root, dir, file);
      if (!(await exists(candidate))) continue;
      // Containment check AFTER symlink resolution: a project dir symlinked outside the root must not
      // become a way to read arbitrary files, even though the id itself is already pattern-validated.
      const real = await realpath(candidate).catch(() => null);
      const realRoot = await realpath(this.root).catch(() => null);
      if (real === null || realRoot === null) return null;
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
      this.pathCache.set(sessionId, real);
      return this.followContinuation(real);
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
  private async followContinuation(path: string): Promise<string> {
    const dir = dirname(path);
    let self: { root: string | null; size: number; mtimeMs: number };
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
        if (conversationRoot(await head(candidate)) !== self.root) continue;
        best = { path: candidate, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        continue; // unreadable sibling — ignore it rather than fail the whole read
      }
    }
    return best.path;
  }

  async load(path: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
    const st = await stat(path);
    const size = st.size;
    const complete = size <= MAX_TRANSCRIPT_BYTES;
    const file = Bun.file(path);
    // Over the cap we keep the TAIL — the newest turns are the ones worth having. The clipped first
    // line is a partial JSON object; parseTranscript skips it by design.
    const text = complete
      ? await file.text()
      : await file.slice(size - MAX_TRANSCRIPT_BYTES).text();
    return { text, complete, size, mtimeMs: st.mtimeMs };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  complete: boolean;
  entries: TranscriptEntry[];
}

/**
 * Reads + caches parsed transcripts. History is fetched ON DEMAND (it is not on the 1.5 s poll path),
 * so the cost that matters is the repeat visit, not the first — a parse is reused until the log's
 * size or mtime moves.
 */
export class TranscriptStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly source: TranscriptSource) {}

  /** Null when this session has no log on disk (never started, or a non-Claude agent). */
  async page(
    sessionId: string,
    opts: { limit: number; before?: string },
  ): Promise<Omit<TranscriptPage, "paneId"> | null> {
    const path = await this.source.resolve(sessionId);
    if (path === null) return null;

    const { text, complete, size, mtimeMs } = await this.source.load(path);
    const cached = this.cache.get(path);
    let entries: TranscriptEntry[];
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      entries = cached.entries;
    } else {
      entries = parseTranscript(text);
      this.cache.set(path, { size, mtimeMs, complete, entries });
      if (this.cache.size > CACHE_MAX) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }

    const { window, hasMore } = pageEntries(entries, opts);
    return {
      entries: window,
      // A clipped file always has more behind it, even at the window's start.
      hasMore: hasMore || (!complete && window.length > 0 && window[0] === entries[0]),
      total: entries.length,
      fileTruncated: !complete,
    };
  }
}
