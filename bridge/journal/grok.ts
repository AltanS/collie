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

import { containedRealpath, exists, loadTail, rootList, statFile } from "./files.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
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

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
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

interface GrokRow {
  type?: unknown;
  content?: unknown;
  prompt_index?: unknown;
  synthetic_reason?: unknown;
  id?: unknown;
  summary?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  kind?: unknown;
}

/**
 * Parse a Grok `chat_history.jsonl` into oldest-first turns. PURE — no fs, no clock.
 * Unparseable lines are skipped (live append, tail-read window).
 */
export function parseGrokTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const pendingTools = new Map<string, Extract<TranscriptPart, { kind: "tool" }>>();
  const seen = new Map<string, number>();
  let heldThinking: string | null = null;

  const flushThinking = (parts: TranscriptPart[]) => {
    if (heldThinking !== null && heldThinking.trim() !== "") {
      parts.unshift({ kind: "thinking", ...clamp(heldThinking, MAX_TEXT_CHARS) });
    }
    heldThinking = null;
  };

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: GrokRow;
    try {
      row = JSON.parse(line) as GrokRow;
    } catch {
      continue;
    }
    const type = row.type;
    const uuid =
      typeof row.id === "string" && row.id !== "" ? row.id : grokCursor(line, seen);

    if (type === "reasoning") {
      const summary = row.summary;
      let textOut = "";
      if (Array.isArray(summary)) {
        textOut = summary
          .map((s) =>
            s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string"
              ? (s as { text: string }).text
              : "",
          )
          .filter(Boolean)
          .join("\n");
      }
      if (textOut.trim() !== "") heldThinking = stripAnsi(textOut);
      continue;
    }

    if (type === "user") {
      if (typeof row.synthetic_reason === "string") continue;
      const raw = stripAnsi(contentText(row.content));
      const query = extractUserQuery(raw);
      const spoken = query ?? (typeof row.prompt_index === "number" ? raw.trim() : null);
      if (spoken === null || spoken === "") continue;
      entries.push({
        uuid,
        ts: "",
        role: "user",
        parts: [{ kind: "text", ...clamp(spoken, MAX_TEXT_CHARS) }],
      });
      continue;
    }

    if (type === "assistant") {
      const parts: TranscriptPart[] = [];
      flushThinking(parts);
      const body = typeof row.content === "string" ? stripAnsi(row.content) : contentText(row.content);
      if (body.trim() !== "") parts.push({ kind: "text", ...clamp(body, MAX_TEXT_CHARS) });
      if (Array.isArray(row.tool_calls)) {
        for (const call of row.tool_calls) {
          if (call === null || typeof call !== "object") continue;
          const c = call as { id?: unknown; name?: unknown; arguments?: unknown };
          const part: Extract<TranscriptPart, { kind: "tool" }> = {
            kind: "tool",
            name: typeof c.name === "string" ? c.name : "tool",
            summary: summarizeToolInput(parseArgs(c.arguments)),
          };
          if (typeof c.id === "string") pendingTools.set(c.id, part);
          parts.push(part);
        }
      }
      if (parts.length === 0) continue;
      entries.push({ uuid, ts: "", role: "assistant", parts });
      continue;
    }

    if (type === "backend_tool_call") {
      const kind = row.kind;
      let name = "tool";
      let summary = "";
      if (kind && typeof kind === "object") {
        const k = kind as { tool_type?: unknown; action?: unknown };
        if (typeof k.tool_type === "string") name = k.tool_type;
        if (k.action && typeof k.action === "object") {
          summary = summarizeToolInput(k.action);
        }
      }
      entries.push({
        uuid,
        ts: "",
        role: "assistant",
        parts: [{ kind: "tool", name, summary }],
      });
      continue;
    }

    if (type === "tool_result") {
      const id = typeof row.tool_call_id === "string" ? row.tool_call_id : "";
      const resultText = stripAnsi(contentText(row.content));
      const target = pendingTools.get(id);
      if (target) {
        pendingTools.delete(id);
        target.result = { ...clamp(resultText, MAX_RESULT_CHARS) };
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
  }

  return entries;
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
}

export function grokJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "grok",
    source: new GrokTranscriptSource(roots),
    parse: parseGrokTranscript,
  };
}
