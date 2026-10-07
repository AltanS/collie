// Text handling every adapter shares: the caps that keep one pathological log from ballooning the
// bridge, and the escape-stripping that keeps a terminal's colour codes out of a view that renders
// text nodes rather than interpreting them.

import type { JsonObject, JsonValue } from "../json.ts";
import { redactText } from "../redact.ts";
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
// ran, the diff it wrote, and the question it asked with its options and the answers. Each string
// goes through `bridge/redact.ts`, the same list the mirror and the push use, so a key masked on the
// screen is masked in Chat too. Line count and block order hold: the mask is the same length as what
// it hides, and no part, turn or hunk line is added or dropped.
//
// THE MASK IS STRUCTURAL, NOT A FIELD LIST. A tool part is walked whole, its `call` included, and
// EVERY string in it is masked unless its key is in {@link UNMASKED_KEYS}. Until 1.18.0 this was a
// switch that named the content fields per call kind, and the `question` kind's words (each question,
// header, option label and description, and the answers) went out in clear because nobody named them.
// A field added to `ToolCall` or to the tool part later is masked from its first day, with no edit
// here: forgetting to list a field now leaves an address masked, which is visible and harmless,
// never a secret in clear. `text.test.ts` pins every field of every call kind.
//
// Three keys are skipped, because they are labels the bridge itself wrote, never an agent's words:
// `kind`, `id` and `mimeType`. Everything else is masked BY SHAPE, paths included (`path`, `to`, a
// search's `where`) and image URLs too: the mask replaces only the known secret shapes in
// `bridge/redact.ts`, so an ordinary path or URL comes back unchanged, and a path that does hold a
// key is masked like any other text. A masked path then simply does not link on the phone (its
// `files/exist` check asks for the masked string and finds nothing), which is the price and an
// acceptable one. An image URL in one of the two shapes `resolveImageUrl` (journal/pi.ts) produces,
// `/api/blobs/<64 hex>` or a `data:image/*;base64,` payload, is left whole: neither shape can hold a
// secret in text, a blob's hash must stay the hash the blob route answers to, and a vendor-key shape
// can turn up by chance inside megabytes of base64 and would break the picture. Any other image URL
// is masked by shape. The entry's own `uuid`, `ts` and `role` are never walked. Numbers and flags
// are not strings and pass as they are.
//
// Called by the History and Chat routes (server.ts) when `COLLIE_REDACT` is on. Never on what the
// operator sends, and never on the audit trail.

/** Keys whose string values the bridge wrote itself, left unmasked wherever they sit inside a part. */
const UNMASKED_KEYS: ReadonlySet<string> = new Set(["kind", "id", "mimeType"]);

/**
 * The two image URL shapes `resolveImageUrl` (journal/pi.ts) produces: this collie's blob route by
 * a 64-hex hash, and an inline base64 image payload (with the whitespace a wrapped payload carries).
 * Spelled here rather than imported, because pi.ts imports this module.
 */
const IMAGE_ADDRESS = /^(?:\/api\/blobs\/[0-9a-f]{64}|data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]*)$/i;

/** An image URL, masked by shape unless it is one of the two {@link IMAGE_ADDRESS} shapes. */
function maskImageUrl(url: string): string {
  return IMAGE_ADDRESS.test(url) ? url : redactText(url);
}

/**
 * The reviver that does the walk: every string is masked by shape unless its own key is one of
 * {@link UNMASKED_KEYS}. An array element's key is its index, so a list of strings (hunk lines,
 * options, answers) is masked whole.
 */
function maskReviver(key: string, value: JsonValue): JsonValue {
  if (typeof value !== "string" || UNMASKED_KEYS.has(key)) return value;
  return key === "imageUrl" ? maskImageUrl(value) : redactText(value);
}

function redactPart(part: TranscriptPart): TranscriptPart {
  // An image part is a URL and its type, and the URL is masked by shape like a tool's `imageUrl`.
  if (part.kind === "image") return { ...part, url: maskImageUrl(part.url) };
  // SAFETY: a TranscriptPart is plain JSON (strings, numbers, booleans, arrays and objects, with no
  // dates, functions or cycles), so the round trip rebuilds the same value, and the reviver swaps a
  // string only for a string of the same length. A key holding `undefined` drops out, which is how
  // this module spells "absent" anyway.
  return JSON.parse(JSON.stringify(part), maskReviver) as TranscriptPart;
}

/** One turn with every content string masked. Same parts, same order, same line counts. */
export function redactEntry<T extends TranscriptEntry>(entry: T): T {
  return { ...entry, parts: entry.parts.map(redactPart) };
}
