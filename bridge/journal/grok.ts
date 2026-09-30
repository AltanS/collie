// Grok Build's journal adapter.
//
// SHAPE OF THE SOURCE (verified against on-disk sessions, 2026-08-21):
//   $GROK_HOME/sessions/<urlencoded-cwd>/<session-uuid>/chat_history.jsonl
//   {"type":"system","content":"…"}                          ← dropped
//   {"type":"user","content":[{type:"text",text:"…"}], "prompt_index": N}
//   {"type":"user","content":[…], "synthetic_reason":"system_reminder"}  ← dropped
//   {"type":"reasoning","id":"rs_…","summary":[{type:"summary_text",text:"…"}], "encrypted_content":"…"}
//   {"type":"assistant","content":"…","tool_calls":[{id,name,arguments}]}
//   {"type":"backend_tool_call","kind":{tool_type, action:{query|…}}}
//   {"type":"tool_result","tool_call_id":"…","content":"…"}
//
// User speech is wrapped in `<user_query>…</user_query>` inside a content list. The same `user`
// type also carries injected plumbing (`user_info`, skills lists, MCP banners) — those rows have
// no `prompt_index` and no user_query tag, and rendering them as "You" would dump the system prompt
// onto the phone. We only keep a user row that yields a user_query (or is otherwise a prompt_index
// turn whose text we can extract).
//
// Reasoning rows carry a short summary AND an encrypted blob. The blob never leaves the disk; we
// take the summary as a `thinking` part on the following assistant turn.
//
// Where Herdr's id comes from: the grok integration reports `session_id` (kind `id`) matching the
// session directory name — a UUID, v7 observed. It needs `herdr integration install grok`.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import {
  NO_CHANGE,
  parseWith,
  reduction,
  rememberPending,
  type PendingTool,
  type Reduction,
  type RowReducer,
} from "./reduce.ts";
import { containedRealpath, exists, loadTail, readSinceFile, rootList, statFile } from "./files.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGrokSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** Inner text of the first `<user_query>…</user_query>`, trimmed; null when the tag isn't present. */
export function extractUserQuery(text: string): string | null {
  const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  if (!m) return null;
  const inner = (m[1] ?? "").trim();
  return inner === "" ? null : inner;
}

/** Flatten a Grok content list (`{type,text}` blocks) into plain text. */
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

/** `arguments` arrives as a JSON string, not an object — parse before summarising. */
function parseArgs(raw: JsonValue | undefined): JsonValue | undefined {
  if (typeof raw !== "string") return raw;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction — naming it keeps the summariser's
    // field reads checked property accesses rather than further assertions.
    return JSON.parse(raw) as JsonValue;
  } catch {
    return raw;
  }
}

function grokCursor(line: string, seen: Map<string, number>): string {
  let hash = 5381;
  for (let i = 0; i < line.length; i++) hash = ((hash << 5) + hash + line.charCodeAt(i)) | 0;
  const key = (hash >>> 0).toString(36);
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  return n === 0 ? `gk-${key}` : `gk-${key}-${n}`;
}

/** A `chat_history.jsonl` line, once JSON.parse has admitted it is an object at all. */
type GrokRow = JsonObject;

/**
 * Parse a Grok `chat_history.jsonl` into oldest-first turns. PURE — no fs, no clock.
 * Unparseable lines are skipped (live append, tail-read window).
 */
export function parseGrokTranscript(text: string): TranscriptEntry[] {
  return parseWith(createGrokReducer(), text);
}

/**
 * The same reading, one row at a time (see `reduce.ts`).
 *
 * The loop this replaces was already a reducer wearing a `for`: it carried `pendingTools`, `seen`
 * and `heldThinking` across rows, and a `tool_result` row MUTATED a part inside a turn the loop had
 * already pushed. So the state below is the state the loop always kept, and the only genuinely new
 * thing is that the mutation gets REPORTED — under a tail that turn is on somebody's screen.
 */
export function createGrokReducer(): RowReducer {
  // `tool_calls[].id` → the part awaiting its result and the turn it went out in, so a `tool_result`
  // row lands on the call that made it and can name where that call is drawn.
  const pendingTools = new Map<string, PendingTool>();
  // Row hash → how many times that exact row has been seen, which is what gives two IDENTICAL rows
  // two different uuids (`grokCursor`). DELIBERATELY UNBOUNDED, and not the same kind of growth as
  // `pendingTools`: evicting an entry resets a count to 0, so a later identical row would reuse an
  // earlier row's uuid, and a duplicate identity is worse than the memory. Its size is bounded by
  // the window a reader feeds the reducer — one clamped tail read — not by the session.
  const seen = new Map<string, number>();
  // A `reasoning` row's summary, held for the assistant turn that follows it.
  let heldThinking: string | null = null;

  const flushThinking = (parts: TranscriptPart[]) => {
    if (heldThinking !== null && heldThinking.trim() !== "") {
      parts.unshift({ kind: "thinking", ...clamp(heldThinking, MAX_TEXT_CHARS) });
    }
    heldThinking = null;
  };

  // A nested `function` rather than a method on the returned object: the body below is the old loop
  // body at the indentation it always had, so this refactor is readable as the move it is.
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
    // A line that parses to a scalar (or a bare `null`, which would THROW on `.type`) has no row
    // shape — skip it exactly as an unparseable line is skipped.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return NO_CHANGE;
    const row: GrokRow = parsed;
    const type = row.type;
    const uuid =
      typeof row.id === "string" && row.id !== "" ? row.id : grokCursor(line, seen);

    if (type === "reasoning") {
      const summary = row.summary;
      let textOut = "";
      if (Array.isArray(summary)) {
        textOut = summary
          .map((s) =>
            s !== null && typeof s === "object" && !Array.isArray(s) && typeof s.text === "string"
              ? s.text
              : "",
          )
          .filter(Boolean)
          .join("\n");
      }
      if (textOut.trim() !== "") heldThinking = stripAnsi(textOut);
      // The assignment above is CARRIED state, not a turn: nothing has been emitted yet, so there is
      // nothing a caller holds and nothing to name. `NO_CHANGE` is the whole truth of this row.
      return NO_CHANGE;
    }

    if (type === "user") {
      if (typeof row.synthetic_reason === "string") return NO_CHANGE;
      const raw = stripAnsi(contentText(row.content));
      const query = extractUserQuery(raw);
      const spoken = query ?? (typeof row.prompt_index === "number" ? raw.trim() : null);
      if (spoken === null || spoken === "") return NO_CHANGE;
      entries.push({
        uuid,
        ts: "",
        role: "user",
        parts: [{ kind: "text", ...clamp(spoken, MAX_TEXT_CHARS) }],
      });
      return reduction(entries, changed);
    }

    if (type === "assistant") {
      const parts: TranscriptPart[] = [];
      flushThinking(parts);
      const body = typeof row.content === "string" ? stripAnsi(row.content) : contentText(row.content);
      if (body.trim() !== "") parts.push({ kind: "text", ...clamp(body, MAX_TEXT_CHARS) });
      if (Array.isArray(row.tool_calls)) {
        for (const call of row.tool_calls) {
          // A `continue` over the BLOCK, not the row: the other calls of this turn still count.
          if (call === null || typeof call !== "object" || Array.isArray(call)) continue;
          const c: JsonObject = call;
          const name = typeof c.name === "string" ? c.name : "tool";
          const input = parseArgs(c.arguments);
          const summary = summarizeToolInput(input);
          const part: Extract<TranscriptPart, { kind: "tool" }> = {
            kind: "tool",
            name,
            summary,
            // Classified from the input alone, which is ALL grok's log allows — see the note at
            // `tool_result` below for what it does not carry.
            call: classifyToolCall(name, input, summary),
          };
          if (typeof c.id === "string") {
            part.id = c.id;
            // The turn is named here, before it exists, because `uuid` is read off the row above and
            // the part is already the object the turn will carry. `rememberPending` is what keeps an
            // orphan call from growing this map for the life of a session.
            rememberPending(pendingTools, c.id, { part, uuid });
          }
          parts.push(part);
        }
      }
      // A row with nothing to SHOW, which is not the same as a row that did nothing — so the answer
      // is built rather than assumed. `reduction` here cannot lose a report: an assistant row folds
      // no result, so `changed` is still empty. In grok the fold sits in the `tool_result` branch,
      // which builds no `parts` and leaves through the bottom of `push` instead of this guard.
      if (parts.length === 0) return reduction(entries, changed);
      entries.push({ uuid, ts: "", role: "assistant", parts });
      return reduction(entries, changed);
    }

    if (type === "backend_tool_call") {
      const kind = row.kind;
      let name = "tool";
      let summary = "";
      let action: JsonValue | undefined;
      if (kind !== null && kind !== undefined && typeof kind === "object" && !Array.isArray(kind)) {
        const k: JsonObject = kind;
        if (typeof k.tool_type === "string") name = k.tool_type;
        if (k.action !== null && typeof k.action === "object") {
          action = k.action;
          summary = summarizeToolInput(k.action);
        }
      }
      entries.push({
        uuid,
        ts: "",
        role: "assistant",
        // The action object IS the input here — a server-side tool's arguments arrive already
        // parsed, so the same classifier reads it. A backend row carries no call id, so there is
        // nothing to put in `id` and no result row ever addresses it.
        parts: [{ kind: "tool", name, summary, call: classifyToolCall(name, action, summary) }],
      });
      return reduction(entries, changed);
    }

    if (type === "tool_result") {
      // NO `enrichCall` HERE, and that is the honest answer rather than a gap. A grok result row is
      // `{type,tool_call_id,content}` and nothing else (the header's row inventory, verified on
      // disk): no exit code, no patch or diff, no hit count, and no error or refusal flag — which is
      // also why `result` below carries neither `isError` nor `denied`. So the call stays exactly as
      // the input classified it, which still names the kind, the path and the command. Fold
      // something in the day grok's log records what a call DID.
      const id = typeof row.tool_call_id === "string" ? row.tool_call_id : "";
      const resultText = stripAnsi(contentText(row.content));
      const target = pendingTools.get(id);
      if (target) {
        pendingTools.delete(id);
        target.part.result = { ...clamp(resultText, MAX_RESULT_CHARS) };
        // The mutation above landed in a turn that went out rows ago. Name it. The uuid is the one
        // the assistant row was emitted with — grok's assistant rows carry no `id`, so in practice
        // it is that row's `grokCursor` hash, which is never empty.
        changed.add(target.uuid);
      } else if (resultText.trim() !== "") {
        entries.push({
          uuid,
          ts: "",
          role: "assistant",
          parts: [
            {
              kind: "tool",
              name: "result",
              summary: "",
              result: { ...clamp(resultText, MAX_RESULT_CHARS) },
            },
          ],
        });
      }
    }

    // The `tool_result` branch and an unknown row type both leave here: one may have folded a result
    // into an earlier turn, the other did nothing at all, and `reduction` tells those two apart.
    return reduction(entries, changed);
  }

  return { push };
}

/**
 * Scan `$GROK_HOME/sessions/<cwd-dir>/<uuid>/chat_history.jsonl`. Session uuids are unique, so
 * scanning cwd dirs for a matching directory name is both correct and cheap. A path-kind ref is
 * not something we've seen from Herdr's grok integration and is refused rather than invented.
 */
export class GrokTranscriptSource implements TranscriptSource {
  // The scan that maps a uuid onto its file is the expensive part and never changes; the ROOT it
  // was resolved through has to travel with it, because a later containment check is per-root
  // (files.ts header). exists() is not that check: stat follows a symlink, so a file replaced by
  // an outward link after the first resolve would otherwise be served. CLAUDE.md requires every
  // path — including one we already accepted — to go through containedRealpath on the real paths.
  private readonly pathCache = new Map<string, { path: string; root: string }>();
  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isGrokSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      const real = await containedRealpath(cached.path, cached.root);
      if (real !== null) {
        if (real !== cached.path) this.pathCache.set(sessionId, { path: real, root: cached.root });
        return real;
      }
      this.pathCache.delete(sessionId);
    }

    for (const root of this.roots) {
      const hit = await this.findUnder(root, sessionId);
      if (hit === null) continue;
      this.pathCache.set(sessionId, { path: hit, root });
      return hit;
    }
    return null;
  }

  private async findUnder(root: string, sessionId: string): Promise<string | null> {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return null;
    }
    for (const dir of dirs) {
      const candidate = join(root, dir, sessionId, "chat_history.jsonl");
      if (!(await exists(candidate))) continue;
      return containedRealpath(candidate, root);
    }
    return null;
  }

  stat = statFile;
  load = loadTail;

  /** The live read, byte-counted like every harness that writes a JSONL file. */
  readSince = readSinceFile;
}

export function grokJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "grok",
    source: new GrokTranscriptSource(roots),
    parse: parseGrokTranscript,
    reducer: createGrokReducer,
  };
}
