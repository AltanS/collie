// Text handling every adapter shares: the caps that keep one pathological log from ballooning the
// bridge, and the escape-stripping that keeps a terminal's colour codes out of a view that renders
// text nodes rather than interpreting them.

import type { JsonObject, JsonValue } from "../json.ts";
import { redactText } from "../redact.ts";
import type { Hunk, ToolCall } from "./tool-call.ts";
import type { TranscriptEntry, TranscriptPart } from "./types.ts";

/** Per-tool-result cap. Tool output is unbounded (a 2 MB file read); the phone only needs a gist. */
export const MAX_RESULT_CHARS = 2000;

/** Per-text-part cap. Generous — assistant prose is the thing you actually came to read. */
export const MAX_TEXT_CHARS = 20_000;

/** Longest one-line tool summary. Past this the line stops being a summary. */
const MAX_SUMMARY_CHARS = 200;

// CSI/SGR and two-character escapes. Journal text is NOT a terminal mirror — nothing downstream
// interprets escapes, so a `\x1b[2m` left in place renders as garbage glyphs on the phone.
//
// ESC is spliced in from its code point rather than written as an escape in the literal: matching a
// control character IS the point here, and a regex literal that says so is (correctly) flagged as
// suspicious wherever it isn't.
const ESC = String.fromCodePoint(0x1b);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]`, "g");

/** Strip terminal escapes from log text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** A capped string plus the flag that says so. Shared with `TranscriptPart`'s text/result shapes. */
export type Clamped = { text: string; truncated?: boolean };

/** Cap a string, flagging the cut so the view can say so rather than silently lying. */
export function clamp(text: string, max: number): Clamped {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}

/** Collapse to a single capped line — what a tool-call summary is by definition. */
export function oneLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS)}…` : line;
}

/**
 * Collapse a tool call's input object into one readable line.
 *
 * The well-known arguments get picked by name (the path, the command, the pattern); anything else
 * falls back to the first string-ish value, so a tool this code has never heard of still reads as
 * something rather than "{...}". Shared across harnesses because tool vocabularies overlap heavily —
 * every one of them has a `read`, a `shell`, and a `grep` under some spelling.
 */
export function summarizeToolInput(input: JsonValue | undefined): string {
  if (input === null || input === undefined || typeof input !== "object") return "";
  // An ARRAY carries no named argument to pick, but its string elements still feed the fallback —
  // which is what an untyped `Object.values()` over one did before this signature was tightened.
  const named: JsonObject = Array.isArray(input) ? {} : input;
  const values: (JsonValue | undefined)[] = Array.isArray(input) ? input : Object.values(input);
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = named[k];
      if (typeof v === "string" && v.trim() !== "") return v;
      // Codex spells a shell call's `command` as an ARGV ARRAY (["bash","-lc","ls -la"]), and pi
      // passes arrays for multi-file tools — join rather than skip, or the defining argument of the
      // most common call in any log goes missing.
      if (Array.isArray(v)) {
        const joined = v.filter((x): x is string => typeof x === "string").join(" ").trim();
        if (joined !== "") return joined;
      }
    }
    return undefined;
  };
  // Order matters, and it is load-bearing: Grep carries both `pattern` and `path`, and the pattern is
  // what you actually searched for, so `pattern` MUST outrank the bare `path` (a test pins this). A
  // subagent call carries both `description`/`task` and `prompt`, and the short one is already the
  // one-line form.
  // A question call (opencode `question`, Claude `AskUserQuestion`) holds its words in a list of
  // objects, which no pick below reaches. The first question is what was asked.
  const firstQuestion = Array.isArray(named.questions) ? named.questions[0] : undefined;
  const asked =
    firstQuestion !== null && typeof firstQuestion === "object" && !Array.isArray(firstQuestion)
      ? firstQuestion.question
      : undefined;
  const chosen =
    (typeof asked === "string" && asked.trim() !== "" ? asked : undefined) ??
    pick(
      "file_path",
      "command",
      "pattern",
      "query",
      "url",
      "path",
      "description",
      "task",
      "prompt",
    ) ??
    // Unknown tool: first string value wins, so the line is never empty for no reason.
    values.find((v): v is string => typeof v === "string" && v.trim() !== "");
  return chosen === undefined ? "" : oneLine(chosen);
}

// ── SECRETS ARE MASKED BEFORE A TURN LEAVES THE BRIDGE ─────────────────────────────────────────
// The journal's own text: what the agent said, what it thought, what a tool printed, the command it
// ran and the diff it wrote. Each string goes through `bridge/redact.ts`, the same list the mirror
// and the push use, so a key masked on the screen is masked in Chat too. Line count and block order
// hold: the mask is the same length as what it hides, and no part, turn or hunk line is added or
// dropped. Ids, timestamps, paths and image URLs are left alone: they are addresses, not content,
// and a blob URL's hash must stay the hash the blob route answers to.
//
// Called by the History and Chat routes (server.ts) when `COLLIE_REDACT` is on. Never on what the
// operator sends, and never on the audit trail.

function redactHunk(hunk: Hunk): Hunk {
  return { header: hunk.header, lines: hunk.lines.map(redactText) };
}

/** The content fields of a structured tool call. Paths stay: they locate, they do not carry. */
function redactCall(call: ToolCall): ToolCall {
  switch (call.kind) {
    case "edit":
      return call.diff === undefined ? call : { ...call, diff: call.diff.map(redactHunk) };
    case "execute": {
      const out: ToolCall = { ...call, command: redactText(call.command) };
      if (call.description !== undefined) out.description = redactText(call.description);
      return out;
    }
    case "search":
      return { ...call, query: redactText(call.query) };
    case "fetch":
      return { ...call, url: redactText(call.url) };
    case "task":
    case "other":
    case "question":
      return { ...call, summary: redactText(call.summary) };
    case "read":
    case "delete":
    case "move":
      return call;
  }
}

function redactPart(part: TranscriptPart): TranscriptPart {
  switch (part.kind) {
    case "text":
    case "thinking":
      return { ...part, text: redactText(part.text) };
    case "image":
      return part;
    case "tool": {
      const out: TranscriptPart = { ...part, summary: redactText(part.summary) };
      if (part.call !== undefined) out.call = redactCall(part.call);
      if (part.result !== undefined) out.result = { ...part.result, text: redactText(part.result.text) };
      return out;
    }
  }
}

/** One turn with every content string masked. Same parts, same order, same line counts. */
export function redactEntry<T extends TranscriptEntry>(entry: T): T {
  return { ...entry, parts: entry.parts.map(redactPart) };
}
