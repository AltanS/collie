// pi's journal adapter.
//
// SHAPE OF THE SOURCE (verified against on-disk sessions, 2026-07-29):
//   ~/.pi/agent/sessions/--<mangled-cwd>--/<ISO-ts>_<session-uuid>.jsonl
//   {"type":"session","version":3,"id":"<uuid>","timestamp":"…","cwd":"…"}      ← header, first row
//   {"type":"message","id":"…","parentId":"…","timestamp":"…","message":{ … }}
//   {"type":"model_change" | "thinking_level_change", …}                         ← bookkeeping
// Every row carries its OWN `id`, so unlike Codex there is nothing to synthesise for paging.
//
// `message.role` is one of `user` | `assistant` | `toolResult`. The first two carry a `content` list
// of `text` / `thinking` / `toolCall` blocks; a `toolResult` row is its own row (not a block inside a
// user turn, the way Claude does it) and links back by `toolCallId`. pi's `thinking` blocks carry
// REAL text — usually a short bolded title — so the thinking branch renders here.
//
// HOW HERDR NAMES THE SESSION — the one that's different. pi's integration reports
// `agent_session_path` in preference to `agent_session_id` (herdr integration `pi`, version 6:
// `withSessionRef` returns the path whenever `sessionManager.getSessionFile()` gave one). So a pi
// pane arrives as a kind-`path` ref: an ABSOLUTE PATH chosen by a process we don't control. It is
// treated as hostile input and confined to pi's own sessions root like everything else — see
// journal/files.ts. The id fallback is supported too, since the hook uses it when no file is open yet.

import { readdir } from "node:fs/promises";

import type { JsonObject, JsonValue } from "../json.ts";
import { dirname, join } from "node:path";
import {
  containedRealpath,
  containedRealpathIn,
  exists,
  loadTail,
  rootList,
  statFile,
} from "./files.ts";
import { clamp, type Clamped, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** pi's session ids are uuids (v4 and v7 both observed) — validated before any path work. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPiSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** pi / omp content-addressed blob hash: 64-hex SHA-256 digest. */
const BLOB_HASH_RE = /^[0-9a-f]{64}$/i;

export function isBlobHash(value: string): boolean {
  return BLOB_HASH_RE.test(value);
}

/** How pi names a blob inside its own log — `blob:sha256:<64 hex>`. Spelled once. */
const BLOB_REF_PREFIX = "blob:sha256:";

/** The route that serves those bytes back (`bridge/server.ts` § BLOB_ROUTE). Spelled once. */
const BLOB_ROUTE_PREFIX = "/api/blobs/";

/** Base64, with the whitespace a wrapped payload carries. A closed charset, never an escaper. */
const BASE64_PAYLOAD_RE = /^[A-Za-z0-9+/=\s]+$/;

/** Flatten a pi content list into text, keeping only `text` blocks. */
function textBlocks(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b !== null && typeof b === "object" && !Array.isArray(b) && b.type === "text" &&
      typeof b.text === "string"
        ? b.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * An image block's `data` as a URL the phone may load, or `null` when it is not one.
 *
 * TWO SHAPES ARE ALLOWED AND NOTHING ELSE: this collie's own `/api/blobs/<64 hex>` route, and a
 * `data:image/*` payload the log carried inline. A journal is an AGENT's output, so `data` is
 * untrusted content: an `http://`/`https://` value would make the phone fetch an arbitrary host on
 * the agent's word — a request the operator never made, from a page inside the tailnet — so it is
 * DROPPED rather than passed through. `resolveImageUrl` returning null is how a block with nothing
 * renderable simply produces no part.
 */
export function resolveImageUrl(data: string, mimeType?: string): string | null {
  if (data.startsWith(BLOB_REF_PREFIX)) {
    const hash = data.slice(BLOB_REF_PREFIX.length);
    return isBlobHash(hash) ? `${BLOB_ROUTE_PREFIX}${hash}` : null;
  }
  // A `data:` value is taken as written, so only an image one is taken at all — `data:text/html`
  // would be a document, not a picture.
  if (data.startsWith("data:")) return data.startsWith("data:image/") ? data : null;
  // Anything left is bare base64, which the block's own `mimeType` names. An absent or non-image
  // mime type is not guessed at: png was a guess, and a guess here is a data URL nobody declared.
  if (mimeType === undefined || !mimeType.startsWith("image/")) return null;
  // And it must actually BE base64. Without this a `mimeType: "image/png"` beside a `data` of
  // `http://evil.example/x.png` came back out as a data URL wrapping a remote address, which is the
  // http case sneaking through the branch that was meant to have dropped it.
  if (!BASE64_PAYLOAD_RE.test(data)) return null;
  return `data:${mimeType};base64,${data}`;
}

/** The first renderable image URL in a content block list, or undefined when there is none. */
function extractImageUrl(content: JsonValue | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const b of content) {
    if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
    if (b.type !== "image" || typeof b.data !== "string") continue;
    const mimeType = typeof b.mimeType === "string" ? b.mimeType : undefined;
    const url = resolveImageUrl(b.data, mimeType);
    if (url !== null) return url;
  }
  return undefined;
}

/** A session-log line, once JSON.parse has admitted it is an object at all. */
type PiRow = JsonObject;

/** A `tool` part's answered result — {@link Clamped} plus the error flag and optional image URL. */
type ToolResult = Clamped & { isError?: boolean; imageUrl?: string };

/** One row's `toolResult` payload, folded onto the call it answers. */
function toolResult(text: string, isError: boolean, imageUrl?: string): ToolResult {
  const result: ToolResult = clamp(text, MAX_RESULT_CHARS);
  // Assigned, never conditionally spread: `isError` is ABSENT when false, not `false`.
  if (isError) result.isError = true;
  if (imageUrl) result.imageUrl = imageUrl;
  return result;
}

/**
 * Parse a pi session log into oldest-first turns. PURE — no fs, no clock.
 *
 * Unparseable lines are skipped: the log is appended to live, so the last line can be a partial
 * write, and a tail-read window starts mid-line by construction.
 */
export function parsePiTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // toolCall id → the part awaiting its result, so a later `toolResult` row lands on its own call.
  const pendingTools = new Map<string, Extract<TranscriptPart, { kind: "tool" }>>();

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction — naming it keeps every field
      // read below a checked property access.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      continue;
    }
    // A line that parses to a scalar (or a bare `null`, which used to reach `.type` and THROW) has
    // no row shape — skip it exactly as an unparseable line is skipped.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const row: PiRow = parsed;
    // `session`, `model_change`, `thinking_level_change` are bookkeeping — nothing to render.
    if (row.type !== "message") continue;
    const message = row.message;
    if (message === null || message === undefined || typeof message !== "object" || Array.isArray(message)) continue;
    const m: JsonObject = message;
    const uuid = typeof row.id === "string" ? row.id : "";
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";

    if (m.role === "toolResult") {
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const target = pendingTools.get(id);
      const resultText = stripAnsi(textBlocks(m.content));
      const isError = m.isError === true;
      const imageUrl = extractImageUrl(m.content);
      if (target) {
        // Mutated in place — the part already sits in an emitted entry, which is why results attach
        // without reordering anything.
        pendingTools.delete(id);
        target.result = toolResult(resultText, isError, imageUrl);
      } else if (resultText.trim() !== "" || imageUrl) {
        // Orphan result (its call fell outside a tail-read window) — kept unattached so the window
        // never silently drops output.
        entries.push({
          uuid,
          ts,
          role: "assistant",
          parts: [
            {
              kind: "tool",
              name: typeof m.toolName === "string" ? m.toolName : "result",
              summary: "",
              result: toolResult(resultText, isError, imageUrl),
            },
          ],
        });
      }
      continue;
    }

    const role: TranscriptEntry["role"] = m.role === "assistant" ? "assistant" : "user";
    const parts: TranscriptPart[] = [];
    const content = Array.isArray(m.content) ? m.content : [];
    for (const b of content) {
      if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text.trim() !== "")
          parts.push({ kind: "text", ...clamp(stripAnsi(b.text), MAX_TEXT_CHARS) });
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        if (b.thinking.trim() !== "")
          parts.push({ kind: "thinking", ...clamp(stripAnsi(b.thinking), MAX_TEXT_CHARS) });
      } else if (b.type === "image" && typeof b.data === "string") {
        const mimeType = typeof b.mimeType === "string" ? b.mimeType : undefined;
        const url = resolveImageUrl(b.data, mimeType);
        // A reference this build refuses to load contributes NO part, rather than a broken <img>.
        // Assigned, never conditionally spread: an unnamed mime type leaves the key OFF.
        if (url !== null) {
          const part: Extract<TranscriptPart, { kind: "image" }> = { kind: "image", url };
          if (mimeType !== undefined) part.mimeType = mimeType;
          parts.push(part);
        }
      } else if (b.type === "toolCall") {
        const part: Extract<TranscriptPart, { kind: "tool" }> = {
          kind: "tool",
          name: typeof b.name === "string" ? b.name : "tool",
          // pi passes `arguments` as a real object (Codex passes a JSON string) — no parse needed.
          summary: summarizeToolInput(b.arguments),
        };
        if (typeof b.id === "string") pendingTools.set(b.id, part);
        parts.push(part);
      }
    }

    if (parts.length === 0) continue; // a row with nothing renderable
    entries.push({ uuid, ts, role, parts });
  }

  return entries;
}

/**
 * Real filesystem source rooted at pi's `sessions` directory.
 *
 * Two ref kinds, because pi's hook reports whichever it has:
 *  - `path` — the common case. Confined to the root after symlink resolution, so a path pointing
 *    anywhere else resolves to null and reads to the client as an ordinary "no log".
 *  - `id`   — the fallback. The uuid is the filename SUFFIX (`<ISO-ts>_<uuid>.jsonl`) inside a
 *    per-cwd directory, so this is a scan of the project dirs, cached after the first hit.
 */
export class PiTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();

  private readonly roots: string[];

  /** One sessions directory or several (a second `PI_CODING_AGENT_DIR`), searched in order. */
  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind === "path") {
      // No shape validation is possible on a free-form path — containment IS the validation. No root
      // built this name, so every configured root is asked whether the file is its own; the first
      // that really contains it answers (files.ts header).
      if (!ref.value.endsWith(".jsonl")) return null;
      if (!(await exists(ref.value))) return null;
      return containedRealpathIn(ref.value, this.roots);
    }

    if (!isPiSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      if (await exists(cached)) return cached;
      this.pathCache.delete(sessionId);
    }

    const suffix = `_${sessionId.toLowerCase()}.jsonl`;
    for (const root of this.roots) {
      const hit = await this.findUnder(root, suffix);
      if (hit === null) continue; // absent here, or present but not this root's to serve
      this.pathCache.set(sessionId, hit);
      return hit;
    }
    return null;
  }

  /** The log whose name ends in `suffix` under one sessions root, contained by that root. */
  private async findUnder(root: string, suffix: string): Promise<string | null> {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return null; // no sessions root at all — nothing to serve
    }
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await readdir(join(root, dir));
      } catch {
        continue;
      }
      const hit = names.find((n) => n.toLowerCase().endsWith(suffix));
      if (hit === undefined) continue;
      return containedRealpath(join(root, dir, hit), root);
    }
    return null;
  }

  stat = statFile;

  load = loadTail;
}

/** pi's journal adapter. `agent` matches the Herdr snapshot's `agent` string. */
export function piJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "pi",
    source: new PiTranscriptSource(roots),
    parse: parsePiTranscript,
  };
}

/**
 * Resolve a content-addressed blob hash to an absolute file path contained within one of the
 * configured pi/omp blob directories (sibling `blobs/` to each `sessions/` root).
 *
 * Validates that hash is a 64-character hex string and that the resolved file exists and is
 * contained within one of the derived blob roots.
 */
export async function resolveBlobPath(
  hash: string,
  sessionRoots: readonly string[],
): Promise<string | null> {
  if (!isBlobHash(hash)) return null;
  const blobRoots = sessionRoots.map((r) => join(dirname(r), "blobs"));
  for (const blobDir of blobRoots) {
    const candidate = join(blobDir, hash);
    if (!(await exists(candidate))) continue;
    const real = await containedRealpathIn(candidate, blobRoots);
    if (real !== null) return real;
  }
  return null;
}
