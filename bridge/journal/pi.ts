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

import { lstat, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";

import type { CacheProbe } from "../cache/engine.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { asRecord, asText, FileSum, probeTail, tokenCount, walkBack } from "./cache-probe.ts";
import { processStartMs } from "./process-start.ts";
import { type MeasuredContext, piAgentDirLookups, WindowCatalog } from "./model-window.ts";
import {
  containedRealpath,
  containedRealpathIn,
  exists,
  head as fileHead,
  loadTail,
  readSinceFile,
  rootList,
  statFile,
} from "./files.ts";
import {
  parseWith,
  createUnknownCounter,
  type KnownTypes,
  NO_CHANGE,
  noQueue,
  noteBlockTypes,
  type PendingTool,
  reduction,
  type Reduction,
  rememberPending,
  type RowReducer,
  type UnknownCounter,
} from "./reduce.ts";
import { clamp, type Clamped, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import { parseUnifiedDiff } from "./diff.ts";
import { answerLabels, classifyToolCall, planTasks, questionKey, type ToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
  DiscoverHints,
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

/**
 * The most characters of ONE inline picture (`data:` URL or bare base64) a journal part may carry.
 *
 * This measures the base64 TEXT, not decoded bytes: base64 spends four characters on three bytes, so
 * 4 MiB of text is about 3 MB of picture. That covers a phone screenshot saved as PNG, and is well
 * under the 10 MB upload limit (`DEFAULT_MAX_UPLOAD_MB`, uploads.ts).
 *
 * An inline picture rides in every journal page and live frame the phone loads, so a huge one would
 * bloat each of them. Text is clamped for the same reason (`MAX_RESULT_CHARS`); a picture cannot be
 * cut mid-payload, so one over this cap is LEFT OUT and its tool card or message keeps everything
 * else, plus one line saying a picture was left out ({@link imageTooLargeNote}). A
 * `/api/blobs/<hash>` reference is a short URL and is not counted: the bytes stay on disk and the
 * phone fetches them on demand.
 */
export const MAX_INLINE_IMAGE_CHARS = 4 * 1024 * 1024;

/**
 * The line that stands in for an inline picture over {@link MAX_INLINE_IMAGE_CHARS}, so the person
 * sees that something was left out. English only: it is a journal note written by the bridge, not a
 * string of the web catalogs. The size is the picture's decoded size, from the base64 text length.
 */
export function imageTooLargeNote(chars: number): string {
  const megabytes = ((chars * 3) / 4 / (1024 * 1024)).toFixed(1);
  return `Picture too large to show here (${megabytes} MB)`;
}

/** What an image value comes to: a URL the phone may load, or the note that stands in for one it may not. */
export type InlineImage = { readonly url: string } | { readonly note: string };

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
 * renderable simply produces no part. An inline picture over {@link MAX_INLINE_IMAGE_CHARS} gives no
 * URL either; {@link resolveImage} is the form that also says so.
 */
export function resolveImageUrl(data: string, mimeType?: string): string | null {
  const image = resolveImage(data, mimeType);
  return image !== null && "url" in image ? image.url : null;
}

/**
 * {@link resolveImageUrl}, but an inline picture over {@link MAX_INLINE_IMAGE_CHARS} that looks like
 * a picture (a `data:image/` value, or bare base64 beside an `image/` mime type) comes back as the
 * {@link imageTooLargeNote} instead of `null`. A huge value that is no picture is still `null`.
 */
export function resolveImage(data: string, mimeType?: string): InlineImage | null {
  if (data.startsWith(BLOB_REF_PREFIX)) {
    const hash = data.slice(BLOB_REF_PREFIX.length);
    return isBlobHash(hash) ? { url: `${BLOB_ROUTE_PREFIX}${hash}` } : null;
  }
  if (data.length > MAX_INLINE_IMAGE_CHARS) {
    // Only the head is looked at: a value this size is not scanned.
    const head = data.slice(0, 256);
    const pictureLike = data.startsWith("data:")
      ? data.startsWith("data:image/")
      : mimeType !== undefined && mimeType.startsWith("image/") && BASE64_PAYLOAD_RE.test(head);
    return pictureLike ? { note: imageTooLargeNote(data.length) } : null;
  }
  // A `data:` value is taken as written, so only an image one is taken at all — `data:text/html`
  // would be a document, not a picture.
  if (data.startsWith("data:")) return data.startsWith("data:image/") ? { url: data } : null;
  // Anything left is bare base64, which the block's own `mimeType` names. An absent or non-image
  // mime type is not guessed at: png was a guess, and a guess here is a data URL nobody declared.
  if (mimeType === undefined || !mimeType.startsWith("image/")) return null;
  // And it must actually BE base64. Without this a `mimeType: "image/png"` beside a `data` of
  // `http://evil.example/x.png` came back out as a data URL wrapping a remote address, which is the
  // http case sneaking through the branch that was meant to have dropped it.
  if (!BASE64_PAYLOAD_RE.test(data)) return null;
  return { url: `data:${mimeType};base64,${data}` };
}

/** What a tool result's picture blocks come to: the first renderable URL, and a note for each one left out for size. */
interface ResultImage {
  readonly url?: string;
  readonly notes: readonly string[];
}

/** The first renderable image URL in a content block list, and a note for every picture over the cap. */
function extractImage(content: JsonValue | undefined): ResultImage {
  const notes: string[] = [];
  let url: string | undefined;
  if (!Array.isArray(content)) return { notes };
  for (const b of content) {
    if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
    if (b.type !== "image" || typeof b.data !== "string") continue;
    const mimeType = typeof b.mimeType === "string" ? b.mimeType : undefined;
    const image = resolveImage(b.data, mimeType);
    if (image === null) continue;
    if ("note" in image) notes.push(image.note);
    else if (url === undefined) url = image.url;
  }
  return url === undefined ? { notes } : { url, notes };
}

/** A session-log line, once JSON.parse has admitted it is an object at all. */
type PiRow = JsonObject;

/** A `tool` part's answered result — {@link Clamped} plus the error flag and optional image URL. */
type ToolResult = Clamped & { isError?: boolean; imageUrl?: string; denied?: boolean };

/**
 * An error result that is a REFUSAL, not a failure — pi's OWN wording, and only pi's.
 *
 * pi core has no permission dialog of its own: a gate is an extension returning `{block, reason}`
 * from `onBeforeToolCall`, and pi then writes `reason || "Tool execution was blocked"` as the error
 * result (read out of pi-coding-agent's own bundle, 2026-09-29). The fallback is therefore the one
 * phrasing pi itself is on the hook for, so it is the only one matched here. An extension's own
 * `reason` is arbitrary prose — including the `Denied at the desk` / `Blocked by …` lines the
 * session-stream prototype's extension writes, which are that extension's words and not pi's — so it
 * degrades to plain `isError`, which is the behaviour this adapter had before.
 *
 * NOT treated as a refusal: `Operation aborted`, `Command aborted` and `Command timed out after N
 * seconds`, pi's three interrupt/timeout results. An interrupt is the operator stopping a call in
 * flight, not the operator saying no to it, and a view that draws the two alike misreports the
 * session — the same reason `denied` is separate from `isError` at all.
 */
const PI_BLOCKED = /^Tool execution was blocked/;

/** One row's `toolResult` payload, folded onto the call it answers. */
function toolResult(text: string, isError: boolean, image: ResultImage = { notes: [] }): ToolResult {
  const result: ToolResult = clamp(text, MAX_RESULT_CHARS);
  // The note rides after the clamp, so a long result never cuts it off.
  if (image.notes.length > 0) result.text = [result.text, ...image.notes].filter((line) => line !== "").join("\n");
  // Assigned, never conditionally spread: `isError` is ABSENT when false, not `false`.
  if (isError) result.isError = true;
  if (image.url !== undefined) result.imageUrl = image.url;
  if (isError && PI_BLOCKED.test(text)) result.denied = true;
  return result;
}

/**
 * How pi ends a failed `bash` result — the status line it appends after the output.
 *
 * Verified in pi's own bundle: a non-zero exit throws `<output>\n\nCommand exited with code <n>`,
 * or that line alone when the command printed nothing, and a zero exit returns the output with no
 * status line at all. So the ABSENCE of this line on a non-error result is what says "exited 0";
 * `Command aborted` and `Command timed out after N seconds` take the same slot and carry no code,
 * which is why the number is required to match.
 */
const PI_EXIT_STATUS = /(?:^|\n)Command exited with code (\d+)\s*$/;

/** A line inside a hunk body carries its own marker — context, added, removed, or the no-eol note. */

/**
 * Enrich a classified call from the result row that answered it — what the call DID, rather than
 * what it was asked to do. MUTATES `call`, the same in-place fold the result text uses.
 *
 * pi splits that knowledge across two places, unlike Claude's single `toolUseResult`, so both are
 * passed: `raw` is the row's `details` object, `text` its flattened result text.
 *
 * WHAT IS VERIFIED against real on-disk sessions (44 logs, 973 result rows, 2026-09-29):
 *  - `details.patch` on an `edit` is a real unified diff string (33 rows). It is OPTIONAL — 157
 *    `edit` results carried `details.diff` and no `patch`, and that `diff` is a LINE-NUMBERED display
 *    string (`+172   text`), not a unified diff, so it is deliberately not read here: parsing it
 *    would invent hunk headers pi never wrote.
 *  - `details.answer` on the collie extension's `ask_user` (6 rows), beside `question`, `options`
 *    and `by`.
 *  - the `Command exited with code N` tail on a failed `bash` (18 distinct occurrences), confirmed
 *    against pi's own bundle as well.
 * WHAT IS TAKEN ON THE PROTOTYPE'S WORD (experiments/session-stream/adapters/pi.ts): nothing that
 * reaches an output field. The prototype named `details.patch` and `details.answer` first, and both
 * were then read off real rows before being used here.
 *
 * NOT filled, on purpose: `created` on an edit. pi's `write` results carry no details at all and say
 * only `Successfully wrote N bytes to <path>`, so "the file was new" is not knowable here, and
 * guessing it would claim a creation that may have been an overwrite.
 */
function enrichCall(
  call: ToolCall,
  raw: JsonValue | undefined,
  text: string,
  isError: boolean,
  questionIds?: ReadonlyMap<string, string>,
): void {
  const details: JsonObject | undefined =
    raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
  if (call.kind === "edit") {
    const patch = details?.patch;
    if (typeof patch === "string" && patch !== "") {
      const parsed = parseUnifiedDiff(patch);
      if (parsed.hunks.length > 0) {
        call.diff = parsed.hunks;
        call.added = parsed.added;
        call.removed = parsed.removed;
      }
    }
    return;
  }
  if (call.kind === "plan") {
    // Gentle Shell's `todo` result holds the WHOLE list whatever the action was (277 of 277 local
    // results, 2026-10-16); the input of an `update` holds one task. An empty or absent list leaves
    // what the input said.
    const gentle = details?.gentleTodo;
    const tasks = gentle !== null && typeof gentle === "object" && !Array.isArray(gentle) ? planTasks(gentle.tasks) : [];
    if (tasks.length > 0) call.tasks = tasks;
    return;
  }
  if (call.kind === "execute") {
    // A background start answers before the command ran: no status line is no exit code YET, and the
    // end notice gives the real one (see `endNotice`).
    if (call.background) return;
    const status = PI_EXIT_STATUS.exec(text);
    if (status !== null) call.exitCode = Number(status[1]);
    else if (!isError) call.exitCode = 0;
    return;
  }
  if (call.kind === "question") {
    // Gentle Shell's `ask_user_choice` writes the pick as `details.selection.label` and collie's own
    // `ask_user` as `details.answer`, both for a one-question call. A dismissal
    // (`details.cancelled`) carries neither and fills nothing.
    const selection = details?.selection;
    const picked =
      selection !== null && typeof selection === "object" && !Array.isArray(selection) ? selection.label : details?.answer;
    if (call.questions.length === 1 && typeof picked === "string" && picked.trim() !== "") {
      const labels = answerLabels(picked);
      if (labels.length > 0) {
        call.answers = [labels];
        return;
      }
    }
    // One list of chosen labels per question, in question order (`[["Blue"]]`), the shape the
    // question card reads. pi's own log does not write it; OpenClaw's `ask_user` answers do, once
    // its normaliser has put them in order (journal/openclaw.ts). Anything of another shape is left
    // unread rather than guessed at.
    const answers = details?.answers;
    if (
      Array.isArray(answers) &&
      answers.length === call.questions.length &&
      answers.every((a) => Array.isArray(a) && a.every((l) => typeof l === "string"))
    ) {
      // SAFETY: every element was just checked to be an array of strings.
      call.answers = answers as string[][];
      return;
    }
    // OmO records `details.answers` beside `status: "answered"`, in two shapes (OmO 5.1.30, read off
    // real rows 2026-10-12): `ask_user_question` keys it by the question's TEXT,
    // `{ "<question>": "Green" }`, and `request_user_input` by the question's `id` from the call,
    // `{ "color": { "answers": ["Blue"] } }`. A dismissed call is `status: "cancelled"` with
    // `answers: {}`, so it fills nothing. Mapped onto question order, the shape opencode's
    // `metadata.answers` already has.
    const keyed = details?.answers;
    if (keyed === null || keyed === undefined || typeof keyed !== "object" || Array.isArray(keyed)) return;
    // Keys go through the card's own clamp, so a long or padded question still finds its answer.
    const byText = new Map<string, JsonValue>();
    for (const [key, value] of Object.entries(keyed)) {
      const question = questionKey(key);
      if (question !== undefined && value !== undefined) byText.set(question, value);
    }
    const lists = call.questions.map((q) => {
      const id = questionIds?.get(q.question);
      return answerLabels(byText.get(q.question) ?? (id === undefined ? undefined : keyed[id]));
    });
    if (lists.some((list) => list.length > 0)) call.answers = lists;
    return;
  }
  if (call.kind === "other") {
    // An unrecognised pi tool that records an answer (one with a `question` but no options, so not a
    // question card). It joins the STRUCTURED summary only — the part's own `summary` is the call's
    // one-line form and stays exactly what `summarizeToolInput` made of the input.
    const answer = details?.answer;
    if (typeof answer === "string" && answer.trim() !== "") call.summary = `${call.summary} → ${answer}`;
  }
}

/** A pi call waiting for its result, plus each question's `id` by its text when the call asked any. */
type PiPending = PendingTool & {
  questionIds?: ReadonlyMap<string, string>;
  /** Set when the call draws no part of its own: its result lands on this card instead (ADR 0119). */
  foldInto?: PendingTool;
};

/** The object under `details[key]`, or `undefined`. */
function detailsOf(details: JsonValue | undefined, key: string): JsonObject | undefined {
  if (details === null || details === undefined || typeof details !== "object" || Array.isArray(details)) return undefined;
  const inner = details[key];
  return inner !== null && typeof inner === "object" && !Array.isArray(inner) ? inner : undefined;
}

/** A string field, or `undefined` when absent, blank or another type. */
function field(o: JsonObject | undefined, key: string): string | undefined {
  const v = o?.[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** The `id` of each question a call's input names, keyed by the question's text. */
function questionIdsOf(input: JsonValue | undefined): Map<string, string> {
  const ids = new Map<string, string>();
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) return ids;
  if (!Array.isArray(input.questions)) return ids;
  for (const q of input.questions) {
    if (q === null || typeof q !== "object" || Array.isArray(q)) continue;
    const question = questionKey(q.question);
    if (question !== undefined && typeof q.id === "string") ids.set(question, q.id);
  }
  return ids;
}

/**
 * Parse a pi session log into oldest-first turns. PURE — no fs, no clock.
 *
 * Unparseable lines are skipped: the log is appended to live, so the last line can be a partial
 * write, and a tail-read window starts mid-line by construction.
 */
export function parsePiTranscript(text: string): TranscriptEntry[] {
  return parseWith(createPiReducer(), text);
}

/**
 * The same reading, one row at a time (see `reduce.ts`).
 *
 * The loop this replaces was already a reducer wearing a `for`: `pendingTools` was the ONLY state it
 * carried across rows, and a `toolResult` row MUTATED a part inside a turn the loop had already
 * pushed. So the state a reducer needs is the state the loop always kept, and the only genuinely new
 * thing here is that the mutation gets REPORTED — under a tail that turn is on somebody's screen.
 *
 * pi folds a result from a row of its OWN (`role: "toolResult"`), never from a block inside a user
 * turn the way Claude does, so one row never both adds a turn and changes it: here `added` and
 * `changed` are disjoint by the shape of the format, not by a rule this function applies.
 */
/**
 * A turn that ENDED BADLY, as a note of its own.
 *
 * MEASURED over 44 real sessions (1,989 rows, pi-tui 0.87.1) on 2026-09-30, because this row was
 * being dropped in silence and its shape decides the fix:
 *  - `stopReason: "error"` — 37 rows, EVERY ONE with zero content blocks. So the turn had nothing to
 *    render, `parts` came out empty, and the whole failure was invisible. That is the fault.
 *  - `stopReason: "aborted"` — 15 rows, 10 of them with zero blocks and 5 carrying text, thinking or
 *    a call the model got out before the operator stopped it.
 *  - every one of the 52 carries `errorMessage`, from 17 to 4,031 characters.
 *
 * `note` and not a text part on the turn itself: the harness wrote this, the model did not say it, and
 * a view that draws the two alike tells the reader the agent announced its own failure. `note` is the
 * role that already means machine-injected content which still belongs on screen.
 *
 * The message is passed through as pi wrote it, with no "Error:" prefix added. pi's own wording is
 * already a sentence ("Operation aborted", a provider's error line), the `note` role is what marks it
 * as not-speech, and a prefix would be this reader editorialising over a harness's own words.
 *
 * The OTHER stop reasons are deliberately silent: `toolUse` (794 rows) and `stop` (53) are how a
 * normal turn ends, and a note on either would put a line under almost every turn in the session.
 */
const PI_STOPPED_BADLY = new Set(["error", "aborted"]);

function stopNote(m: JsonObject): TranscriptPart | null {
  const reason = m.stopReason;
  if (typeof reason !== "string" || !PI_STOPPED_BADLY.has(reason)) return null;
  const message = m.errorMessage;
  if (typeof message !== "string" || message.trim() === "") return null;
  return { kind: "text", ...clamp(stripAnsi(message), MAX_TEXT_CHARS) };
}

/**
 * How many rows of the branch chain a reducer remembers.
 *
 * The SECOND bounded map in a reducer, beside {@link PENDING_MAX}, and it needs a bound for the same
 * reason: without one it is the thing that grows for the life of a session. 8192 links against a live
 * window of 2000 entries means the chain outlives everything the window can still show.
 *
 * Eviction is oldest-first, and it is sound because the log is append-only: every ancestor of a row
 * is older than that row, so the ids that fall off are the ones whose turns the window has already
 * trimmed. The cost of an evicted link is that its turn can no longer be marked or unmarked, which is
 * the same bound the window's own trim already puts on a late tool result.
 */
const BRANCH_MAX = 8192;

/** One row of the chain: what it hangs off, and the turns it put on screen. */
interface BranchLink {
  parentId: string | null;
  entries: TranscriptEntry[];
}

/** The text of a `custom_message`, whose `content` pi writes as a string or as blocks. */
function customText(content: JsonValue | undefined): string {
  if (typeof content === "string") return stripAnsi(content);
  return stripAnsi(textBlocks(content));
}

/**
 * A desk `!command`, which pi records as a message role rather than as a tool call.
 *
 * `note` and not `assistant`: nobody said this, the operator ran it, and `types.ts` names "a local
 * command's output" as the example of a note. The fields sit on the MESSAGE and not in content
 * blocks (`command`, `output`, `exitCode`, `cancelled`, `truncated`), verified against pi 0.87.1's
 * own `SessionManager` writing one.
 */
function bashExecutionParts(m: JsonObject): TranscriptPart[] {
  const command = typeof m.command === "string" ? m.command : "";
  if (command.trim() === "") return [];
  const summary = summarizeToolInput({ command });
  const call = classifyToolCall("bash", { command }, summary);
  const exitCode = typeof m.exitCode === "number" && Number.isFinite(m.exitCode) ? m.exitCode : undefined;
  if (call.kind === "execute" && exitCode !== undefined) call.exitCode = exitCode;
  const part: Extract<TranscriptPart, { kind: "tool" }> = { kind: "tool", name: "bash", summary, call };
  const output = typeof m.output === "string" ? m.output : "";
  // Cancelled OR a non-zero exit is a failure to read; a cancelled command is not a REFUSAL, so
  // `denied` stays off (the same line `PI_BLOCKED` draws for a tool result).
  const failed = m.cancelled === true || (exitCode !== undefined && exitCode !== 0);
  if (output.trim() !== "" || failed) part.result = toolResult(stripAnsi(output), failed);
  return [part];
}

/**
 * Every type, role and content-block type this adapter has MET, rendered or dropped (`reduce.ts` §
 * "what a reducer reports about what it could not read"). Anything else is counted and named.
 *
 * Measured on 2026-09-30 over 44 local sessions across both roots (`~/.pi/agent/sessions` and Oh My
 * Pi's `~/.omp/agent/sessions`), which is the whole inventory they carry; `compaction`,
 * `branch_summary`, `usage` and `label` are added from the grammar below, which names all four.
 *
 * `custom` and `custom_message` are two different rows and both are here. `custom_message` is an
 * extension putting something on the operator's screen (`display: true`) and is rendered; `custom`
 * carries `customType` and `data`, names no `display` at all, and is an extension's own bookkeeping
 * (4 rows in those 44 sessions).
 *
 * `image` is in `parts` and IS rendered — pi is the one harness whose pictures reach the phone
 * (#292) — even though those 44 sessions carry none.
 *
 * `session_info` (pi 1.1.0, the session's `name`) and Oh My Pi 18.10's `title` and `title_change`
 * were met by the harness canary on 2026-10-12. All three name the session and draw nothing; the
 * pane's label comes from the multiplexer, not from here.
 *
 * Oh My Pi 18.10's `service_tier_change` (written at session start when a tier is set) and
 * `model_usage` (the cost of a call outside the transcript, such as a composer prediction) were
 * met in a real session on 2026-10-13. Both are bookkeeping and draw nothing.
 */
const PI_KNOWN: KnownTypes = {
  rows: [
    "message",
    "compaction",
    "branch_summary",
    "custom_message",
    "session",
    "model_change",
    "thinking_level_change",
    "usage",
    "label",
    "custom",
    "session_info",
    "title",
    "title_change",
    "service_tier_change",
    "model_usage",
  ],
  roles: ["user", "assistant", "toolResult", "bashExecution", "system"],
  parts: ["text", "thinking", "image", "toolCall"],
};

/** The statuses Gentle Shell and Oh My Pi write when a subagent or a background job has ended. */
const FINAL_WORK_STATUS: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "exited", "stopped"]);

/** The statuses an Oh My Pi `task` start writes for a subagent that has not ended yet. */
const OMP_RUNNING_STATUS: ReadonlySet<string> = new Set(["pending", "running"]);

/** The objects of `details[key]` when it is a list, else none. */
function detailRows(details: JsonValue | undefined, key: string): JsonObject[] {
  if (details === null || details === undefined || typeof details !== "object" || Array.isArray(details)) return [];
  const list = details[key];
  if (!Array.isArray(list)) return [];
  return list.filter((row): row is JsonObject => row !== null && typeof row === "object" && !Array.isArray(row));
}

/**
 * The status an Oh My Pi `async-result` notice gives one job. The row's `details.jobs[]` carries no
 * status (OMP 18.6.1); the notice's own text does, as `<task-result id="<job>" … status="<s>">`. A
 * notice that names none is a delivered result, so `completed`.
 */
function asyncResultStatus(content: string, jobId: string): string {
  for (const m of content.matchAll(/<task-result\b([^>]*)>/g)) {
    const attrs = m[1] ?? "";
    if (/\bid="([^"]*)"/.exec(attrs)?.[1] !== jobId) continue;
    const status = /\bstatus="([^"]*)"/.exec(attrs)?.[1];
    if (status !== undefined && status !== "") return status;
  }
  return "completed";
}

export function createPiReducer(): RowReducer {
  // toolCall id → the part awaiting its result and the turn it went out in, so a later `toolResult`
  // row lands on its own call and can name where that call is drawn.
  const pendingTools = new Map<string, PiPending>();
  // What this reducer met and had no branch for, asked for once per session by the canary.
  const unknown = createUnknownCounter(PI_KNOWN);
  // The newest plan card, which a later non-`write` `todo` call folds into (ADR 0119).
  let heldPlan: PendingTool | undefined;
  // Subagent task id / background job id → the card that started it, so the end notice (or a
  // `subagent_result`) can find it. Kept after the work ends: a result can be asked for later. Bounded
  // by `rememberPending`; what falls off is the oldest id, whose notice the window has long passed.
  const workCards = new Map<string, PendingTool>();
  // An Oh My Pi job card → its progress names, the `label` an end row may name it by. Weak, so a card
  // the window and `workCards` both let go of costs nothing here.
  const jobLabels = new WeakMap<PendingTool, readonly string[]>();

  /**
   * Oh My Pi's `task` start (OMP 18.6.1, read off a real session on 2026-10-25). The result answers at
   * once with `details.async: {state: "running", jobId}` and one `details.progress[]` row per subagent
   * (`id`, `agent`, `status: "pending"`). The card is ongoing while the job runs, remembered under the
   * job id and under each progress id, and carries the job id as `jobId`. A failed spawn (`isError`,
   * no `async`) never reaches here. True when the details had this shape at all.
   */
  function startOmpJob(target: PendingTool, raw: JsonValue | undefined): boolean {
    const call = target.part.call;
    if (call?.kind !== "task") return false;
    const job = detailsOf(raw, "async");
    const progress = detailRows(raw, "progress");
    if (job === undefined && progress.length === 0) return false;
    const agent = progress.map((row) => field(row, "agent")).find((a) => a !== undefined);
    if (call.agent === undefined && agent !== undefined) call.agent = agent;
    const running =
      field(job, "state") === "running" || progress.some((row) => OMP_RUNNING_STATUS.has(field(row, "status") ?? ""));
    if (!running) return true;
    // A second job of one name gets `<name>-2` as its job id while its progress id stays `<name>`, so
    // a progress id an ongoing card already holds is left to that card. The job id is taken last and
    // always: it is the name the end notice uses.
    jobLabels.set(target, progress.flatMap((row) => field(row, "id") ?? []));
    for (const row of progress) {
      const id = field(row, "id");
      const held = id === undefined ? undefined : workCards.get(id);
      if (id !== undefined && (held === undefined || held.part.call?.kind !== "task" || held.part.call.ongoing !== true))
        rememberPending(workCards, id, target);
    }
    const jobId = field(job, "jobId") ?? field(progress[0], "id");
    if (jobId !== undefined) {
      rememberPending(workCards, jobId, target);
      call.jobId = jobId;
    }
    call.ongoing = true;
    return true;
  }

  /**
   * The one ongoing job card whose progress names include `label`, or undefined when none or several
   * do. Two same-named jobs and a notice for an id neither holds: ending either could end the wrong
   * one, so neither ends, and the quiet bound clears a count left too high.
   */
  function onlyOngoingByLabel(label: string): PendingTool | undefined {
    const found = new Set<PendingTool>();
    for (const card of workCards.values()) {
      const call = card.part.call;
      if (call?.kind === "task" && call.ongoing === true && jobLabels.get(card)?.includes(label) === true) found.add(card);
    }
    return found.size === 1 ? found.values().next().value : undefined;
  }

  /**
   * Oh My Pi's end of a job: an `async-result` notice (`details.jobs[]`: `jobId`, `label`) or any tool
   * result whose `details.jobs[]` rows carry a `status` (`wait`: `id`, `label`, `status`). A job is
   * found by its id; an id no card holds falls back to its label only when exactly one ongoing card
   * carries that label. Only a final status ends the card, the same set Gentle Shell's notices use.
   */
  function settleOmpJobs(rows: readonly JsonObject[], statusOf: (row: JsonObject, id: string) => string | undefined, changed: Set<string>): void {
    for (const row of rows) {
      const id = field(row, "jobId") ?? field(row, "id");
      const label = field(row, "label");
      const key = id ?? label;
      const held = id === undefined ? undefined : workCards.get(id);
      const card = held ?? (label === undefined ? undefined : onlyOngoingByLabel(label));
      if (card === undefined || key === undefined) continue;
      const status = statusOf(row, key);
      if (status !== undefined) settle(card, { status }, changed);
    }
  }

  /** Mark a card ongoing and remember it by id, when its start result says the work is still running. */
  function startWork(target: PendingTool, raw: JsonValue | undefined): void {
    const call = target.part.call;
    if (call?.kind !== "task" && call?.kind !== "execute") return;
    if (detailsOf(raw, "gentleAgents") === undefined && startOmpJob(target, raw)) return;
    const agents = call.kind === "task" ? detailsOf(raw, "gentleAgents") : undefined;
    const jobs = call.kind === "execute" ? detailsOf(raw, "gentleJobs") : undefined;
    const info = agents ?? jobs;
    if (info === undefined) return;
    const agent = field(agents, "agent");
    if (call.kind === "task" && call.agent === undefined && agent !== undefined) call.agent = agent;
    // `subagent_result` asks about work another card started; it never starts any of its own.
    if (target.part.name.toLowerCase() === "subagent_result") return;
    const id = field(info, agents ? "taskId" : "jobId");
    if (id !== undefined) rememberPending(workCards, id, target);
    const status = field(info, "status");
    if (status === "queued" || status === "running") call.ongoing = true;
  }

  /** A `gentle-agents.result` / `gentle-jobs.notice` row: the work it names has ended. */
  function endNotice(row: PiRow, changed: Set<string>): void {
    const type = row.customType;
    if (type === "async-result") {
      const content = customText(row.content);
      settleOmpJobs(detailRows(row.details, "jobs"), (job, id) => field(job, "status") ?? asyncResultStatus(content, id), changed);
      return;
    }
    if (type !== "gentle-agents.result" && type !== "gentle-jobs.notice") return;
    const agents = type === "gentle-agents.result";
    const info = detailsOf(row.details, agents ? "gentleAgents" : "gentleJobs");
    if (info !== undefined) settle(workCards.get(field(info, agents ? "taskId" : "jobId") ?? ""), info, changed);
  }

  /**
   * End a held card when `info` (a `gentleAgents` / `gentleJobs` record) reports a final status.
   * The end notice is the usual source; a cancelled subagent has none, and only the status a later
   * `subagent_status` or `subagent_cancel` result reports says it is over (a real session,
   * 2026-10-15). A status still running or queued leaves the card as it is.
   */
  function settle(card: PendingTool | undefined, info: JsonObject, changed: Set<string>): void {
    const status = field(info, "status");
    if (status === undefined || !FINAL_WORK_STATUS.has(status)) return;
    const call = card?.part.call;
    if (card === undefined || (call?.kind !== "task" && call?.kind !== "execute")) return;
    delete call.ongoing;
    const exitCode = info.exitCode;
    let failed = status === "failed";
    if (call.kind === "execute" && typeof exitCode === "number" && Number.isFinite(exitCode)) {
      call.exitCode = exitCode;
      failed ||= exitCode !== 0;
    }
    if (failed) {
      if (card.part.result) card.part.result.isError = true;
      else card.part.result = toolResult("", true);
    }
    changed.add(card.uuid);
  }

  // ── THE BRANCH CHAIN ────────────────────────────────────────────────────────
  // pi keeps every branch in ONE append-only log. Every row names its parent, and the session's
  // CURRENT branch is the path from the newest row back to a root. A row whose parent is not the row
  // before it is a rewind, and everything that hung off the old leaf has left the conversation.
  //
  // Measured over 44 real sessions on 2026-09-30: 8 of them fork. This is not an edge case.
  //
  // A rewind is ANNOUNCED by the row that arrives, which is what makes it expressible in a
  // forward-only reducer at all: the turns that left are marked `abandoned` in place and named in
  // `changed`, exactly like a tool result folding onto an earlier call. `Reduction` grows no
  // `removed` (ADR 0073 and its addendum). A rewind BACK onto a marked turn clears the mark the same
  // way, which a remove verb could never have done.
  const chain = new Map<string, BranchLink>();
  let leaf: string | null = null;

  /** A card on a turn the branch left can no longer be folded into: the new branch draws its own. */
  function forget(uuid: string): void {
    if (heldPlan?.uuid === uuid) heldPlan = undefined;
    for (const [id, card] of workCards) if (card.uuid === uuid) workCards.delete(id);
  }

  /** Remember this row, and if it rewound, flip the flags the rewind changed. */
  function link(rowId: string, parentId: string | null, entries: TranscriptEntry[], changed: Set<string>): void {
    if (rowId === "") return; // no identity, so nothing can hang off it and nothing can be walked
    if (parentId !== leaf) {
      // The path from the new parent back to a root. A parent the chain does not hold (including
      // `null`, pi's own new-root case) yields an empty path, so everything held has left.
      const keep = new Set<string>();
      for (let at = parentId; at !== null && !keep.has(at); at = chain.get(at)?.parentId ?? null) {
        if (!chain.has(at)) break;
        keep.add(at);
      }
      for (const [id, held] of chain) {
        const off = !keep.has(id);
        for (const entry of held.entries) {
          if (off && entry.abandoned !== true) {
            entry.abandoned = true;
            changed.add(entry.uuid);
            forget(entry.uuid);
          } else if (!off && entry.abandoned === true) {
            delete entry.abandoned;
            changed.add(entry.uuid);
          }
        }
      }
    }
    chain.set(rowId, { parentId, entries });
    leaf = rowId;
    if (chain.size > BRANCH_MAX) {
      const oldest = chain.keys().next().value;
      if (oldest !== undefined) chain.delete(oldest);
    }
  }

  /**
   * What one row puts on screen. Pushes into `entries` and names in `changed` any EARLIER turn it
   * edited; the branch bookkeeping is {@link link}'s and runs after this, so every row is a link
   * whether or not it draws anything.
   */
  function draw(row: PiRow, uuid: string, ts: string, entries: TranscriptEntry[], changed: Set<string>, note: UnknownCounter): void {
    const type = row.type;
    // At the READ, not in the branch that declined (`reduce.ts` § `createUnknownCounter`). Every
    // row-kind test below is against a name in `PI_KNOWN.rows`, so a name nobody listed lands here.
    note.row(type);

    // pi's own history rows. Both carry a `summary` the MODEL wrote about the conversation, which is
    // what `role: "summary"` means here and in claude.ts and opencode.ts. A compaction deliberately
    // does NOT mark the turns before `firstKeptEntryId` abandoned: they are still on the branch, and
    // the other two harnesses keep them on screen too.
    if (type === "compaction" || type === "branch_summary") {
      const summary = typeof row.summary === "string" ? stripAnsi(row.summary) : "";
      if (summary.trim() !== "")
        entries.push({ uuid, ts, role: "summary", parts: [{ kind: "text", ...clamp(summary, MAX_TEXT_CHARS) }] });
      return;
    }

    // An extension put this on the operator's screen. `display: false` is the extension talking to
    // the model, which is the same distinction Claude's `isMeta` draws, so it is dropped.
    if (type === "custom_message") {
      if (row.display !== true) return;
      // The notice is still drawn below; it also ends the card that started the work.
      endNotice(row, changed);
      const text = customText(row.content);
      if (text.trim() !== "")
        entries.push({ uuid, ts, role: "note", parts: [{ kind: "text", ...clamp(text, MAX_TEXT_CHARS) }] });
      return;
    }

    // `model_change`, `thinking_level_change`, `usage`, `label` and anything later: bookkeeping that
    // draws nothing and is still a LINK in the chain, which is why this returns rather than bailing
    // out of `push`.
    if (type !== "message") return;
    const message = row.message;
    if (message === null || message === undefined || typeof message !== "object" || Array.isArray(message)) return;
    const m: JsonObject = message;
    // The second discriminator: five roles are read below, and the `user` fallback at the bottom
    // would otherwise swallow a sixth silently.
    note.role(m.role);
    noteBlockTypes(note, m.content);

    if (m.role === "toolResult") {
      // Oh My Pi's `wait` (and any result that lists jobs with a status) settles the jobs it names,
      // whether or not its own call is still held.
      settleOmpJobs(detailRows(m.details, "jobs"), (job) => field(job, "status"), changed);
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const target = pendingTools.get(id);
      const resultText = stripAnsi(textBlocks(m.content));
      const isError = m.isError === true;
      const image = extractImage(m.content);
      if (target?.foldInto) {
        // A call that drew no part of its own: its result lands on the card it folds into.
        const card = target.foldInto;
        pendingTools.delete(id);
        if (card.part.call?.kind === "plan") {
          const tasks = planTasks(detailsOf(m.details, "gentleTodo")?.tasks);
          if (tasks.length > 0) card.part.call.tasks = tasks;
        } else {
          // `subagent_result`: the answer replaces the start notice's text. The work is over only
          // when the status it reports says so: one asked for too early answers "running".
          card.part.result = toolResult(resultText, isError, image);
          const info = detailsOf(m.details, "gentleAgents");
          if (info !== undefined) settle(card, info, changed);
        }
        changed.add(card.uuid);
      } else if (target) {
        // Mutated in place — the part already sits in an emitted entry, which is why results attach
        // without reordering anything.
        pendingTools.delete(id);
        target.part.result = toolResult(resultText, isError, image);
        // `details` rides on the RESULT ROW, not on a content block — it is pi's own record of what
        // the call did, and the only place a patch or an answer ever appears.
        if (target.part.call) enrichCall(target.part.call, m.details, resultText, isError, target.questionIds);
        if (!isError) startWork(target, m.details);
        // Both mutations above landed in a turn that went out rows ago. Name it.
        changed.add(target.uuid);
        // A status call about ANOTHER card's task (`subagent_status`, `subagent_cancel`).
        const info = detailsOf(m.details, "gentleAgents");
        const other = workCards.get(field(info, "taskId") ?? "");
        if (info !== undefined && other !== undefined && other !== target) settle(other, info, changed);
      } else if (resultText.trim() !== "" || image.url !== undefined || image.notes.length > 0) {
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
              result: toolResult(resultText, isError, image),
            },
          ],
        });
      }
      return;
    }

    // A desk `!command`. Its own role, its own shape, and a note rather than speech.
    if (m.role === "bashExecution") {
      const parts = bashExecutionParts(m);
      if (parts.length > 0) entries.push({ uuid, ts, role: "note", parts });
      return;
    }

    // pi's context injection: `content` is a STRING here, plus `sections` and `toolsAdded`, so the
    // block walk below would find nothing anyway. Refused by name rather than by accident, and NOT
    // collapsed into `user`, which is what it used to fall through to.
    if (m.role === "system") return;

    const role: TranscriptEntry["role"] = m.role === "assistant" ? "assistant" : "user";
    const parts: TranscriptPart[] = [];
    // `content` is a block list in pi's own log, and a plain STRING in the same format as OpenClaw
    // writes it (journal/openclaw.ts), where every user turn is one. A string is one text block:
    // walking arrays alone dropped every OpenClaw user turn without a trace (issue #401).
    const content: JsonValue[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const b of content) {
      // A `continue` over the BLOCK, not the row: the other blocks of this turn still count.
      if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
      if (b.type === "text" && typeof b.text === "string") {
        if (b.text.trim() !== "")
          parts.push({ kind: "text", ...clamp(stripAnsi(b.text), MAX_TEXT_CHARS) });
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        if (b.thinking.trim() !== "")
          parts.push({ kind: "thinking", ...clamp(stripAnsi(b.thinking), MAX_TEXT_CHARS) });
      } else if (b.type === "image" && typeof b.data === "string") {
        const mimeType = typeof b.mimeType === "string" ? b.mimeType : undefined;
        const image = resolveImage(b.data, mimeType);
        // A reference this build refuses to load contributes NO part, rather than a broken <img>.
        // A picture over the cap becomes a text line, so the person sees it was left out.
        // Assigned, never conditionally spread: an unnamed mime type leaves the key OFF.
        if (image !== null && "note" in image) {
          parts.push({ kind: "text", text: image.note });
        } else if (image !== null) {
          const part: Extract<TranscriptPart, { kind: "image" }> = { kind: "image", url: image.url };
          if (mimeType !== undefined) part.mimeType = mimeType;
          parts.push(part);
        }
      } else if (b.type === "toolCall") {
        const name = typeof b.name === "string" ? b.name : "tool";
        // pi passes `arguments` as a real object (Codex passes a JSON string) — no parse needed.
        const summary = summarizeToolInput(b.arguments);
        const part: Extract<TranscriptPart, { kind: "tool" }> = {
          kind: "tool",
          name,
          summary,
          call: classifyToolCall(name, b.arguments, summary),
        };
        // A call that folds into an earlier card draws nothing: a `todo` update into the held plan,
        // a `subagent_result` into the card of its `task_id` (ADR 0119).
        const input = b.arguments !== null && typeof b.arguments === "object" && !Array.isArray(b.arguments) ? b.arguments : {};
        const lower = name.toLowerCase();
        let foldInto: PendingTool | undefined;
        if (lower === "todo" && input.action !== "write") {
          foldInto = heldPlan;
          // A `clear` ends the list: its result is empty, so the card keeps the list as it last
          // stood, and the next `add` starts a card of its own.
          if (input.action === "clear") heldPlan = undefined;
        }
        else if (lower === "subagent_result") foldInto = workCards.get(field(input, "task_id") ?? "");
        if (foldInto !== undefined) {
          if (typeof b.id === "string") rememberPending(pendingTools, b.id, { part, uuid, foldInto });
          continue;
        }
        if (lower === "todo") heldPlan = { part, uuid };
        if (typeof b.id === "string") {
          part.id = b.id;
          // The turn is named here, before it exists, because `uuid` is read off the row above and
          // the part is already the object the turn will carry. `rememberPending` is what keeps an
          // orphan call from growing this map for the life of a session.
          const pending: PiPending = { part, uuid };
          if (part.call?.kind === "question") {
            const ids = questionIdsOf(b.arguments);
            if (ids.size > 0) pending.questionIds = ids;
          }
          rememberPending(pendingTools, b.id, pending);
        }
        parts.push(part);
      }
    }

    // A row with nothing renderable contributes no turn, which is not the same as contributing
    // nothing: the stop note below may still be owed.
    if (parts.length > 0) entries.push({ uuid, ts, role, parts });
    // AFTER the turn it belongs to, and under a uuid of its own so both can be held at once. A
    // derived uuid is safe: a uuid is only ever an identity here, matched by `?before=` against turns
    // already parsed and by the live window's own index, and `<row>:stop` collides with nothing pi
    // writes. 47 of the 52 measured rows carry no turn at all, so usually this IS the row's only
    // entry; the five that carry both are why it is not simply the row's own id.
    const stopped = stopNote(m);
    if (stopped !== null) entries.push({ uuid: `${uuid}:stop`, ts, role: "note", parts: [stopped] });
  }

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
      return NO_CHANGE; // partial trailing write, or the clipped first line of a tail read
    }
    // A line that parses to a scalar (or a bare `null`, which used to reach `.type` and THROW) has
    // no row shape — skip it exactly as an unparseable line is skipped.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return NO_CHANGE;
    const row: PiRow = parsed;
    // THE HEADER IS NOT A LINK. Its `id` is the SESSION's uuid, and the first message's `parentId` is
    // `null` rather than that id, so feeding it to the chain would make every first row look like a
    // rewind.
    if (row.type === "session") return NO_CHANGE;

    const uuid = typeof row.id === "string" ? row.id : "";
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";
    draw(row, uuid, ts, entries, changed, unknown);
    // Unconditional, and after `draw`: a row that renders nothing is still somebody's parent, so the
    // chain has to hold it or the next rewind would walk past a hole and abandon the live branch.
    link(uuid, typeof row.parentId === "string" ? row.parentId : null, entries, changed);
    // `reduction` rather than `NO_CHANGE` at the exit, because the mutating branches above may have
    // named a turn without adding one, and spelling it this way means a later mutation cannot
    // silently lose its report.
    return reduction(entries, changed);
  }

  // No queue in this format's log: see `RowReducer.queued`.
  return { push, unknowns: unknown.tally, queued: noQueue };
}

/**
 * Real filesystem source rooted at pi's `sessions` directory.
 *
 * Two ref kinds, because pi's hook reports whichever it has:
 *  - `path` — the common case. Confined to the root after symlink resolution, so a path pointing
 *    anywhere else resolves to null and reads to the client as an ordinary "no log". A path whose
 *    file pi has not written yet is a new empty session instead (`pending`, #526).
 *  - `id`   — the fallback. The uuid is the filename SUFFIX (`<ISO-ts>_<uuid>.jsonl`) inside a
 *    per-cwd directory, so this is a scan of the project dirs, cached after the first hit.
 */
export class PiTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();

  private readonly roots: string[];

  private readonly places: PiPlaces;

  private readonly processStart: (pid: number) => Promise<number | null>;

  /**
   * One sessions directory or several (a second `PI_CODING_AGENT_DIR`), searched in order. `places`
   * is the home and temp folder the harness names its folders from; the bridge's own by default,
   * since the harness runs on the bridge's machine. Tests hand in their own. `options.processStartMs`
   * answers when a process started (default: the real one); tests inject a fake so nothing forks.
   */
  constructor(
    roots: string | readonly string[],
    places: PiPlaces = { home: homedir(), tmp: tmpdir() },
    options: PiSourceOptions = {},
  ) {
    this.roots = rootList(roots);
    this.places = places;
    this.processStart = options.processStartMs ?? processStartMs;
  }

  /**
   * The session a pane in `cwd` runs, for a pane that names none (M79 spec 02): a multiplexer with no
   * pi integration (herdr-core, tmux, zellij) reports no session, only the pane's folder.
   *
   * pi and Oh My Pi file a session under a folder named from the cwd, and write the cwd into the
   * session row near the top of the log. The folder name is lossy (`/` and `-` both become `-`), so
   * it only narrows the search: a log counts only when its session row names exactly this cwd. The
   * newest such log (by mtime, so a resumed session that is being written wins) is the pane's.
   * Bounded: a few folders read, {@link MAX_DISCOVER_CANDIDATES} files stat'd, and at most
   * {@link MAX_DISCOVER_READS} heads read, newest first.
   *
   * A log that started before the pane's harness process is never the pane's session (M79 spec 06):
   * pi writes no log before its first reply, so a fresh pane in a folder with an older log would
   * show that older conversation. When `hints.processes` names a pid whose start time is known, the
   * logs that started more than {@link START_SLACK_MS} before it are skipped; with no pid or no
   * readable start the folder walk stands as it was.
   *
   * With a pi or omp neighbour in the same folder (`hints.shared`) the answer is no session, because
   * the newest log could be the neighbour's (#508). The answer is an `id` ref, so it goes through the
   * same `resolve` and containment as a reported one.
   */
  async discoverSession(cwd: string, hints?: DiscoverHints): Promise<AgentSessionRef | null> {
    if (hints?.shared === true) return null;
    if (!isAbsolute(cwd)) return null;
    const folders = piSessionFolderNames(cwd, this.places);
    const candidates: { id: string; path: string; root: string; mtimeMs: number }[] = [];
    for (const root of this.roots) {
      for (const folder of folders) {
        let names: string[];
        try {
          names = await readdir(join(root, folder));
        } catch {
          continue;
        }
        // The name starts with the ISO start time, so name order is start order: the newest starts
        // are stat'd first when a folder holds more than the cap.
        for (const name of names.toSorted().toReversed()) {
          if (candidates.length >= MAX_DISCOVER_CANDIDATES) break;
          const id = /_([^_/]+)\.jsonl$/u.exec(name)?.[1];
          if (id === undefined || !isPiSessionId(id)) continue;
          const path = join(root, folder, name);
          const meta = await statFile(path);
          if (meta === null) continue;
          candidates.push({ id: id.toLowerCase(), path, root, mtimeMs: meta.mtimeMs });
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const harnessStartMs = candidates.length === 0 ? null : await this.harnessStart(hints);
    const eligible: typeof candidates = [];
    for (const candidate of candidates) {
      if (eligible.length >= MAX_DISCOVER_READS) break;
      if (harnessStartMs !== null && (await predatesHarness(candidate, harnessStartMs))) continue;
      eligible.push(candidate);
    }
    for (const candidate of eligible) {
      const contained = await containedRealpath(candidate.path, candidate.root);
      if (contained === null) continue;
      if ((await sessionCwdOf(contained)) !== cwd) continue;
      this.pathCache.set(candidate.id, contained);
      return { kind: "id", value: candidate.id };
    }
    return null;
  }

  /** When the pane's harness process started: the first foreground process with a pid, or null. */
  private async harnessStart(hints: DiscoverHints | undefined): Promise<number | null> {
    const pid = hints?.processes?.find((p) => p.pid !== undefined)?.pid;
    if (pid === undefined) return null;
    return this.processStart(pid);
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

  /**
   * Where a `path` ref's log will be, while pi has not written it yet (#526).
   *
   * pi names a new session the moment it starts one, on launch and after `/new`, and writes the file
   * only when the first reply is saved (`SessionManager._persist`, pi 0.87.1). Herdr reports the path
   * at once, so for that gap the ref names a file that does not exist. `resolve` answers null for it,
   * which reads as "no log"; this answers the key the file WILL have, so the live window can show a
   * new, empty session and start reading when the file appears.
   *
   * The same confinement as `resolve`, moved one level up because there is no file to resolve yet:
   *  - the name must be pi's own (`<ISO-ts>_<session-uuid>.jsonl`), so a free-form path is refused;
   *  - NOTHING may exist at the path, not even a dangling symlink: a file that exists goes through
   *    `resolve` and its containment, and a refused one must never come back here as "empty";
   *  - the FOLDER must exist and lie inside a sessions root after symlink resolution, and the key is
   *    built from that real folder, which is the spelling `resolve` answers once the file exists, so
   *    both name one live window.
   */
  async pending(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "path") return null;
    const name = basename(ref.value);
    const id = /_([^_]+)\.jsonl$/.exec(name)?.[1];
    if (id === undefined || !isPiSessionId(id)) return null;
    if (await lstat(ref.value).then(() => true, () => false)) return null;
    const folder = await containedRealpathIn(dirname(ref.value), this.roots);
    return folder === null ? null : join(folder, name);
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

  /**
   * The live read. A `path`-kind ref changes nothing about it: `resolve` confines the path to a
   * configured root and returns the REAL path, and the cursor is taken on whatever `resolve`
   * answered — so a ref that starts naming a different log resets rather than resuming at a byte
   * offset that means nothing in it.
   */
  readSince = readSinceFile;
}

/** pi's journal adapter. `agent` matches the Herdr snapshot's `agent` string. */
export function piJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new PiTranscriptSource(roots);
  const catalog = new WindowCatalog();
  const costs = new FileSum('"cost"', piRowCost);
  return {
    agent: "pi",
    source,
    parse: parsePiTranscript,
    reducer: createPiReducer,
    // A pane on a multiplexer without pi's Herdr integration names no session; its folder finds it.
    discover: (cwd: string, hints?: DiscoverHints) => source.discoverSession(cwd, hints),
    sharedFolderBlind: true,
    cacheProbe: (ref) => piCacheProbe(source, ref, catalog, costs),
  };
}

/** The folders a harness names its session folders from. */
export interface PiPlaces {
  readonly home: string;
  readonly tmp: string;
}

/** What a {@link PiTranscriptSource} takes besides its roots; tests inject a fake start function. */
export interface PiSourceOptions {
  readonly processStartMs?: (pid: number) => Promise<number | null>;
}

/**
 * How much earlier than the harness process a log may start and still count as its own. The
 * process start has about one second of precision (clock ticks, `ps` elapsed seconds) and the
 * harness names its log a moment after it starts, so a log written right at the start must not be
 * lost to rounding. A log older than this is a previous run's.
 */
const START_SLACK_MS = 5000;

/**
 * When a session log started: the ISO time in its file name (`2026-10-30T10-00-00-000Z_<id>.jsonl`,
 * colons written as dashes), else the file's birth time (ctime where the file system keeps none).
 * Infinity when neither is readable, so an unreadable log is never skipped by the start rule.
 */
async function logStartMs(path: string): Promise<number> {
  const stamp = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:[-.](\d{1,3}))?Z_/u.exec(basename(path));
  if (stamp !== null) {
    const parsed = Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${(stamp[5] ?? "0").padEnd(3, "0")}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  try {
    const st = await stat(path);
    return st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * True when `log` belongs to an earlier run than the harness process that started at `harnessStartMs`:
 * it started before that (minus the slack) AND nothing wrote to it since the process started. A
 * resumed session keeps its old file name but is being written, so its mtime clears it.
 */
async function predatesHarness(log: { path: string; mtimeMs: number }, harnessStartMs: number): Promise<boolean> {
  if (log.mtimeMs >= harnessStartMs) return false;
  return (await logStartMs(log.path)) < harnessStartMs - START_SLACK_MS;
}

/** Most session logs a discovery stats before it stops looking. */
const MAX_DISCOVER_CANDIDATES = 500;

/** Most session logs a discovery head-reads, newest first; past this the answer is "no session". */
const MAX_DISCOVER_READS = 20;

/** How much of a log's head holds its session row (Oh My Pi puts a 256-byte title row first). */
const SESSION_ROW_BYTES = 16 * 1024;

/** A path's separators and drive colon as the harness writes them into a folder name. */
function encodePath(path: string): string {
  return path.replace(/[/\\:]/gu, "-");
}

/** `relative(from, to)` when `to` is `from` or inside it, else null. */
function inside(from: string, to: string): string | null {
  if (from === "") return null;
  const rel = relative(from, to);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : null;
}

/**
 * Every folder name a pi-format harness files a session for `cwd` under, one per naming rule:
 *  - pi (0.87.x) and Oh My Pi outside home and temp: `--<cwd, no leading slash, / \ : as ->--`
 *    (`getDefaultSessionDirPath`; omp `encodeLegacyAbsoluteSessionDirName`);
 *  - Oh My Pi (18.x) under the temp folder: `-tmp-<relative>`, `-tmp` for the temp folder itself;
 *  - Oh My Pi under home: `-<relative>`, `-` for home itself (omp `session-paths.ts`).
 * A name only narrows the search; the session row's cwd decides.
 */
export function piSessionFolderNames(cwd: string, places: PiPlaces): string[] {
  const names = [`--${encodePath(cwd.replace(/^[/\\]/u, ""))}--`];
  const underTmp = inside(places.tmp, cwd);
  if (underTmp !== null) names.push(underTmp === "" ? "-tmp" : `-tmp-${encodePath(underTmp)}`);
  const underHome = inside(places.home, cwd);
  if (underHome !== null) names.push(`-${encodePath(underHome)}`);
  return [...new Set(names)];
}

/** The cwd a log's session row names, or null when its head has none. */
async function sessionCwdOf(path: string): Promise<string | null> {
  let text: string;
  try {
    text = await fileHead(path, SESSION_ROW_BYTES);
  } catch {
    return null;
  }
  for (const line of text.split("\n").slice(0, 4)) {
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record === null || record.type !== "session") continue;
    return typeof record.cwd === "string" ? record.cwd : null;
  }
  return null;
}

// ── The prompt-cache probe ───────────────────────────────────────────────────
//
// herdr-cache-alert has no pi adapter, so this grammar was read off real logs rather than ported
// (verified 2026-09-13). An assistant row carries everything needed on ONE record, which makes this
// the simplest of the four:
//
//   {"type":"message","id":"…","timestamp":"…","message":{
//      "role":"assistant","provider":"openrouter","model":"anthropic/claude-opus-4",
//      "usage":{"input":…,"output":…,"cacheRead":…,"cacheWrite":…,"totalTokens":…}}}
//
// pi is provider-agnostic, so the TTL belongs to the upstream and not to pi: `model` is reported as
// `provider:model` exactly as opencode's is, and `bridge/cache/rules/providers.ts` unwraps a gateway
// prefix from there. `provider: "openrouter"` with `model: "openai/gpt-5.6-sol"` therefore lands on
// OpenAI's own 30-minute regime rather than on the pessimistic default.
//
// Oh My Pi needs nothing here: `omp` is an alias of `pi` in registry.ts, so an omp pane resolves to
// this adapter and to `pi.*` rules alike.
//
// THE CONTEXT (.adr/0115, amended 2026-10-25) is a turn row's `input + cacheRead + cacheWrite`: pi
// counts the cache apart from `input`, so the three together are what the request carried. pi's own
// footer adds the reply's `output` too; Collie counts what went in, as it does for Claude. A turn that
// failed writes zeros and is passed over ({@link piContextOf}). A `compaction` row after the turn means
// the next request carries less, and no turn has measured it yet, so the probe names no context then.
// The log names no window (a `model_change` row names the model only), so the window comes from the
// catalog in the agent dir ({@link piAgentDirOf}, bridge/journal/model-window.ts), and a model it does
// not name has no context dot.

/**
 * The agent dir a session log belongs to: the parent of the nearest `sessions` folder above it. A
 * session is `<agent>/sessions/<folder>/<file>.jsonl`, and Oh My Pi nests a subagent's log one level
 * deeper, under a folder named after its parent session. A root set to some other folder names no
 * agent dir, and then no catalog is read.
 */
export function piAgentDirOf(path: string): string | null {
  let folder = dirname(path);
  for (let depth = 0; depth < 3; depth++) {
    folder = dirname(folder);
    if (basename(folder) === "sessions") return dirname(folder);
  }
  return null;
}

/** The sum of a usage row's input-side counts, or undefined when the row names none of them. */
function piContextTokens(usage: JsonObject): number | undefined {
  const parts = [tokenCount(usage.input), tokenCount(usage.cacheRead), tokenCount(usage.cacheWrite)];
  if (parts.every((n) => n === undefined)) return undefined;
  const sum = parts.reduce<number>((total, n) => total + Math.max(0, n ?? 0), 0);
  return sum > 0 ? sum : undefined;
}

/**
 * The context the newest MEASURED turn carried, with its provider and model, or undefined. A turn
 * that failed writes a usage row of zeros, and the context it would have sent is the one before it,
 * so such a row is passed over. A `compaction` met first ends the search with no reading.
 */
export function piContextOf(lines: readonly string[]): MeasuredContext | undefined {
  const found = walkBack(lines, (raw): MeasuredContext | null | undefined => {
    const entry = asRecord(raw);
    if (entry === null) return undefined;
    if (entry.type === "compaction") return null;
    if (entry.type !== "message") return undefined;
    const message = asRecord(entry.message);
    if (message === null || message.role !== "assistant") return undefined;
    const usage = asRecord(message.usage);
    const tokens = usage === null ? undefined : piContextTokens(usage);
    if (tokens === undefined) return undefined;
    const out: MeasuredContext = { tokens };
    const provider = asText(message.provider);
    const model = asText(message.model);
    if (provider !== undefined) out.provider = provider;
    if (model !== undefined) out.model = model;
    return out;
  });
  return found ?? undefined;
}

/**
 * THE SESSION COST (.adr/0115, amended 2026-10-25) is the sum of `message.usage.cost.total`, in US
 * dollars, over every assistant row of the file; pi and Oh My Pi write the same shape (verified on pi
 * logs and on Oh My Pi 18.6.1). An aborted turn writes zeros and adds nothing. Branches pi abandoned
 * stay in the file and were paid for, so they count. A tail holds a handful of turns, so the sum runs
 * over the whole file once and then over the appended bytes only ({@link FileSum}).
 */
export function piRowCost(raw: JsonValue): number | undefined {
  const entry = asRecord(raw);
  if (entry === null || entry.type !== "message") return undefined;
  const message = asRecord(entry.message);
  if (message === null || message.role !== "assistant") return undefined;
  const total = tokenCount(asRecord(asRecord(message.usage)?.cost)?.total);
  return total === undefined || total < 0 ? undefined : total;
}

async function piCacheProbe(
  source: PiTranscriptSource,
  ref: AgentSessionRef,
  catalog?: WindowCatalog,
  costs?: FileSum,
): Promise<CacheProbe | null> {
  const tail = await probeTail(source, ref);
  if (tail === null) return null;
  // The thinking level is the NEWEST one the walk meets, whether a `thinking_level_change` row (written
  // when the session opens and on every change) or the `thinkingLevel` pi 1.3 stamps on each assistant
  // message. A level row after the newest turn is met first, so the label names the level the next
  // turn will use, the way Claude's `/model` does (#463).
  let effort: string | undefined;
  const found = walkBack(tail.lines, (raw): CacheProbe | undefined => {
    const entry = asRecord(raw);
    if (entry === null) return undefined;
    if (entry.type === "thinking_level_change") {
      effort ??= asText(entry.thinkingLevel);
      return undefined;
    }
    if (entry.type !== "message") return undefined;
    const message = asRecord(entry.message);
    if (message === null || message.role !== "assistant") return undefined;
    effort ??= asText(message.thinkingLevel);
    const usage = asRecord(message.usage);
    if (usage === null) return undefined;
    const at = Date.parse(asText(entry.timestamp) ?? "");
    if (Number.isNaN(at)) return undefined;
    const provider = asText(message.provider);
    const model = asText(message.model);
    const cacheReadTokens = tokenCount(usage.cacheRead);
    const cacheCreationTokens = tokenCount(usage.cacheWrite);
    const pair = provider !== undefined && model !== undefined ? `${provider}:${model}` : model;
    const probe: CacheProbe = {
      lastRequestAt: at,
      turnId: asText(entry.id) ?? String(at),
      measuredAt: tail.mtimeMs,
      evidence: `${tail.path} (${pair ?? "?"}, cache read ${String(cacheReadTokens ?? "?")})`,
    };
    if (cacheReadTokens !== undefined) probe.cacheReadTokens = cacheReadTokens;
    if (cacheCreationTokens !== undefined) probe.cacheCreationTokens = cacheCreationTokens;
    if (pair !== undefined) probe.model = pair;
    return probe;
  });
  if (found === undefined) return null;
  const context = piContextOf(tail.lines);
  if (context !== undefined) {
    found.contextTokens = context.tokens;
    const agentDir = piAgentDirOf(tail.path);
    if (catalog !== undefined && agentDir !== null && context.provider !== undefined && context.model !== undefined) {
      const window = await catalog.window(agentDir, piAgentDirLookups(agentDir), context.provider, context.model);
      if (window !== undefined) found.contextWindow = window;
    }
  }
  const summed = costs === undefined ? undefined : await costs.read(tail.path);
  if (summed !== undefined && summed.sum > 0) found.costUsd = summed.sum;
  // A turn that carried no level of its own: the level row the session opened with, or the last
  // change before the turn, still stands. Only the level is looked for past the turn.
  effort ??= walkBack(tail.lines, (raw) => {
    const entry = asRecord(raw);
    return entry?.type === "thinking_level_change" ? asText(entry.thinkingLevel) : undefined;
  });
  if (effort !== undefined) found.effort = effort;
  return found;
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
