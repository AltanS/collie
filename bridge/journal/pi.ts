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

import type { CacheProbe } from "../cache/engine.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { dirname, join } from "node:path";
import { asRecord, asText, probeTail, tokenCount, walkBack } from "./cache-probe.ts";
import {
  containedRealpath,
  containedRealpathIn,
  exists,
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
import { classifyToolCall, type ToolCall } from "./tool-call.ts";
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
function toolResult(text: string, isError: boolean, imageUrl?: string): ToolResult {
  const result: ToolResult = clamp(text, MAX_RESULT_CHARS);
  // Assigned, never conditionally spread: `isError` is ABSENT when false, not `false`.
  if (isError) result.isError = true;
  if (imageUrl) result.imageUrl = imageUrl;
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
function enrichCall(call: ToolCall, raw: JsonValue | undefined, text: string, isError: boolean): void {
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
  if (call.kind === "execute") {
    const status = PI_EXIT_STATUS.exec(text);
    if (status !== null) call.exitCode = Number(status[1]);
    else if (!isError) call.exitCode = 0;
    return;
  }
  if (call.kind === "other") {
    // The one thing an unrecognised pi tool records that a view can draw: the answer a question got.
    // It joins the STRUCTURED summary only — the part's own `summary` is the call's one-line form and
    // stays exactly what `summarizeToolInput` made of the input.
    const answer = details?.answer;
    if (typeof answer === "string" && answer.trim() !== "") call.summary = `${call.summary} → ${answer}`;
  }
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
  ],
  roles: ["user", "assistant", "toolResult", "bashExecution", "system"],
  parts: ["text", "thinking", "image", "toolCall"],
};

export function createPiReducer(): RowReducer {
  // toolCall id → the part awaiting its result and the turn it went out in, so a later `toolResult`
  // row lands on its own call and can name where that call is drawn.
  const pendingTools = new Map<string, PendingTool>();
  // What this reducer met and had no branch for, asked for once per session by the canary.
  const unknown = createUnknownCounter(PI_KNOWN);

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
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const target = pendingTools.get(id);
      const resultText = stripAnsi(textBlocks(m.content));
      const isError = m.isError === true;
      const imageUrl = extractImageUrl(m.content);
      if (target) {
        // Mutated in place — the part already sits in an emitted entry, which is why results attach
        // without reordering anything.
        pendingTools.delete(id);
        target.part.result = toolResult(resultText, isError, imageUrl);
        // `details` rides on the RESULT ROW, not on a content block — it is pi's own record of what
        // the call did, and the only place a patch or an answer ever appears.
        if (target.part.call) enrichCall(target.part.call, m.details, resultText, isError);
        // Both mutations above landed in a turn that went out rows ago. Name it.
        changed.add(target.uuid);
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
    const content = Array.isArray(m.content) ? m.content : [];
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
        const url = resolveImageUrl(b.data, mimeType);
        // A reference this build refuses to load contributes NO part, rather than a broken <img>.
        // Assigned, never conditionally spread: an unnamed mime type leaves the key OFF.
        if (url !== null) {
          const part: Extract<TranscriptPart, { kind: "image" }> = { kind: "image", url };
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
        if (typeof b.id === "string") {
          part.id = b.id;
          // The turn is named here, before it exists, because `uuid` is read off the row above and
          // the part is already the object the turn will carry. `rememberPending` is what keeps an
          // orphan call from growing this map for the life of a session.
          rememberPending(pendingTools, b.id, { part, uuid });
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
  return {
    agent: "pi",
    source,
    parse: parsePiTranscript,
    reducer: createPiReducer,
    cacheProbe: (ref) => piCacheProbe(source, ref),
  };
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

async function piCacheProbe(source: PiTranscriptSource, ref: AgentSessionRef): Promise<CacheProbe | null> {
  const tail = await probeTail(source, ref);
  if (tail === null) return null;
  const found = walkBack(tail.lines, (raw): CacheProbe | undefined => {
    const entry = asRecord(raw);
    if (entry === null || entry.type !== "message") return undefined;
    const message = asRecord(entry.message);
    if (message === null || message.role !== "assistant") return undefined;
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
  return found ?? null;
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
