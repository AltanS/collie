// Codex's journal adapter.
//
// SHAPE OF THE SOURCE (verified against on-disk rollouts from codex 0.32.0 AND 0.145.0, 2026-07-29 —
// the path layout and the row envelope are identical across that span; 0.145 adds `world_state` and
// `turn_context` row types, and a `developer` message role, all of which this parser ignores):
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<session-uuid>.jsonl
//   {"timestamp":"…","type":"session_meta","payload":{"id":"<uuid>","cwd":"…","cli_version":"…"}}
//   {"timestamp":"…","type":"response_item","payload":{"type":"message"|"reasoning"|
//                                                      "function_call"|"function_call_output", …}}
//   {"timestamp":"…","type":"event_msg","payload":{"type":"user_message"|"agent_message"|
//                                                  "agent_reasoning"|"token_count", …}}
// `{timestamp,type,payload}` are the ONLY top-level keys.
//
// THE TRAP: ROWS ARE DOUBLE-BOOKED. The same conversation is written twice — once as `response_item`
// (the API-shaped record) and once as `event_msg` (the UI event stream). Measured on one session: 29
// `response_item` user messages against 28 `event_msg` user_messages, and the same for assistant
// turns. Parse both families and every turn renders twice. We take `response_item` and drop
// `event_msg` wholesale, because only `response_item` carries tool RESULTS
// (`function_call_output`) — the event stream has the calls' narration but not their output.
//
// Where Herdr's id comes from: Codex's `SessionStart` hook reports `session_id` to
// `pane.report_agent_session` (herdr integration `codex`, version 6), so the pane record carries a
// kind-`id` ref exactly like Claude's. It needs `herdr integration install codex`; without the hook
// there is no id and the journal correctly reports "no-session". The hook fires only when the first
// prompt is submitted, so a Codex pane with no turn yet has no session either
// (`REPORTS_SESSION_ON_FIRST_PROMPT` in `registry.ts`).

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CacheProbe } from "../cache/engine.ts";
import type { JsonObject, JsonValue } from "../json.ts";
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
} from "./reduce.ts";
import { asRecord, asText, probeTail, tokenCount, walkBack } from "./cache-probe.ts";
import { containedRealpath, exists, loadTail, readSinceFile, rootList, statFile } from "./files.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import { classifyToolCall, type ToolCall } from "./tool-call.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** Codex names sessions with the same canonical uuid shape Claude does. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/**
 * A stable per-row cursor, synthesised because Codex rows carry NO id of their own — and
 * `TranscriptEntry.uuid` is the paging cursor (`?before=`).
 *
 * Row POSITION is the obvious candidate and the wrong one: a log over the byte cap is tail-read, so
 * the window's first row is not the file's first row, and the offset moves as the file grows. Hashing
 * the row's own bytes instead makes the cursor a property of the CONTENT, so it survives a window
 * that starts somewhere else. The occurrence counter disambiguates rows that are byte-identical
 * (two identical shell calls); an unknown cursor degrades to "newest" rather than to an empty page,
 * so the rare miss is a re-render, never a dead end.
 *
 * KNOWN FAILURE MODE, accepted. If a >32 MB log's tail window shifts between two requests AND an
 * earlier byte-identical row falls out of it, the occurrence counters renumber: a cursor the client
 * holds as `cx-<h>-2` can then name what used to be `cx-<h>-3`. That pages to a slightly wrong
 * position rather than degrading to "newest" — the one case where the miss is silent. It needs a
 * multi-megabyte log, duplicate rows identical to the byte, and a window shift between two taps; the
 * harm is a misplaced page in a view you scroll anyway, so it isn't worth a per-row index the format
 * doesn't give us.
 *
 * INVARIANT this relies on: `seen` is advanced for every `response_item` row, INCLUDING rows that
 * emit no entry (a tool output that folds onto its call, an empty reasoning row). Numbering must be a
 * function of the parsed window alone — if it depended on which rows happened to render, adding a
 * renderable row would renumber the ones before it.
 */
export function codexCursor(line: string, seen: Map<string, number>): string {
  // djb2 — we need determinism and speed, not collision resistance; a collision costs a re-render.
  let hash = 5381;
  for (let i = 0; i < line.length; i++) hash = ((hash << 5) + hash + line.charCodeAt(i)) | 0;
  const key = (hash >>> 0).toString(36);
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  return n === 0 ? `cx-${key}` : `cx-${key}-${n}`;
}

/** Flatten a Codex content list (`input_text` / `output_text` / `text` blocks) into plain text. */
function blockText(content: JsonValue | undefined): string {
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

/**
 * Unwrap a `function_call_output.output`, which is a JSON STRING wrapping `{"output": "…"}` rather
 * than the output itself. Falls back to the raw string when it isn't that shape — a tool whose
 * output isn't JSON should still show its output rather than nothing.
 */
export function codexToolOutput(raw: JsonValue | undefined): string {
  if (typeof raw !== "string") return "";
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; this names it so the `output`
    // read below stays a checked property access rather than a second assertion.
    const parsed = JSON.parse(raw) as JsonValue;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.output === "string") {
      return parsed.output;
    }
  } catch {
    // not JSON — the raw string IS the output
  }
  return raw;
}

/** `arguments` arrives as a JSON string, not an object — parse before summarising. */
function codexToolSummary(args: JsonValue | undefined): string {
  if (typeof args !== "string") return summarizeToolInput(args);
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    return summarizeToolInput(JSON.parse(args) as JsonValue);
  } catch {
    return oneLine(args); // malformed/partial arguments still say something useful
  }
}

/**
 * The same `arguments`, PARSED, for {@link classifyToolCall} — which wants the input as a
 * `JsonValue` and not as the one-line summary above.
 *
 * Malformed arguments yield `undefined`, which the classifier reads as an empty input: a partial
 * write loses the structure, while `codexToolSummary` still falls back to the raw line, so the row
 * keeps its sentence either way.
 */
function codexToolInput(args: JsonValue | undefined): JsonValue | undefined {
  if (typeof args !== "string") return args;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    return JSON.parse(args) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * A `custom_tool_call.input`, which is NOT the JSON object `function_call.arguments` is.
 *
 * Measured over 53 `custom_tool_call` rows on this host: `name` is `exec` every time and `input` is
 * the shell script ITSELF, a bare string that never parses as JSON. {@link classifyToolCall} reads an
 * object, so a raw script handed to it straight would classify as an empty execute — the call would
 * render with no command in it. Wrapping it under `script`, one of the three keys that branch already
 * reads, is what makes the command show.
 *
 * A JSON OBJECT is still taken as itself, for the tool codex has not written yet. A parse that yields
 * anything else (a script that happens to read as a bare number) is treated as the script it is.
 */
function codexCustomInput(raw: JsonValue | undefined): JsonValue | undefined {
  if (typeof raw !== "string") return raw;
  const parsed = codexToolInput(raw);
  if (parsed !== null && parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  return { script: raw };
}

/**
 * Codex's own preamble on an `exec` result, and the trailer under it.
 *
 * Both are codex literals, read off 52 `custom_tool_call_output` rows here, and they are matched
 * rather than assumed: a version that stops writing them leaves the text whole instead of losing a
 * line of it. `Script running with cell ID <n>` is the same header for a call still going.
 *
 * The trailer is the exit code, in the two dialects seen (`exit_code=0` and a bare `1`). It is read
 * ONLY as the third or later block under a matched preamble, because in a two-block output the
 * second block is the output itself — `echo 42` would otherwise report exit 42 and show nothing.
 */
/** What an `exec` result row says: the output, and the exit code codex buried in a block of its own. */
interface ExecOutput {
  readonly body: string;
  readonly exitCode?: number;
}

const EXEC_PREAMBLE = /^Script (?:completed|running[^\n]*)\nWall time [^\n]*\nOutput:\n?$/;
const EXEC_TRAILER = /^(?:exit_code=)?(\d{1,3})$/;

/**
 * Split a `custom_tool_call_output.output` into the output and the exit code codex buried in it.
 *
 * THE SHAPE IS TWO SHAPES, which is the part a naive read of the `function_call_output` path gets
 * wrong. Counted here: `output` is a LIST of `input_text` blocks 32 times and a bare STRING 20 times
 * (`aborted by user after 8.5s` among them, which {@link REFUSED} then marks as a refusal). The list
 * runs preamble, output, and sometimes the code:
 *
 *   [ "Script completed\nWall time 0.1 seconds\nOutput:\n", "line 1\nline 2\n", "exit_code=0" ]
 *
 * The preamble is dropped when anything follows it, because three lines of "Wall time" ahead of every
 * exec result is three lines of a phone screen (DESIGN.md §2). It is KEPT when nothing follows, since
 * "this script is still running" is then the only thing the row says.
 */
function codexExecOutput(raw: JsonValue | undefined): ExecOutput {
  if (!Array.isArray(raw)) return { body: blockText(raw) };
  const texts = raw.map((b) => blockText([b]));
  if (texts.length < 2 || !EXEC_PREAMBLE.test(texts[0] ?? "")) return { body: blockText(raw) };
  const trailer = texts.length >= 3 ? EXEC_TRAILER.exec(texts.at(-1) ?? "") : null;
  const body = texts.slice(1, trailer === null ? undefined : -1).filter(Boolean).join("\n");
  if (body.trim() === "" && trailer === null) return { body: blockText(raw) };
  return trailer === null ? { body } : { body, exitCode: Number(trailer[1]) };
}

/** A `tool` part's answered output — {@link clamp}'s pair, plus the flags the output earns. */
type ToolResult = NonNullable<Extract<TranscriptPart, { kind: "tool" }>["result"]>;

/**
 * An output that is a REFUSAL, not a failure.
 *
 * These are Codex's own literals (read off the 0.156.1 binary, and `aborted by user after …` seen
 * in real rollouts): `exec command rejected by user`, `patch rejected by user`, `aborted by user
 * after <n>s`, and `…; rejected by user approval settings`, where the no came from the rule the
 * operator set rather than from a tap. All four say somebody said no; none of them says a command
 * failed. A sandbox block (`sandbox denied exec error, exit code: 2`, also in real rollouts) is
 * deliberately NOT here: nothing was asked and nobody refused — the command ran and was stopped,
 * which is an ordinary error.
 */
const REFUSED = /rejected by user|aborted by user/i;

/**
 * Enrich a classified call from its `function_call_output` row, which is where Codex records what
 * the call actually DID rather than what it was asked to do.
 *
 * WHAT THE ROLLOUT ACTUALLY HOLDS, counted over the 296 `function_call_output` rows on this machine
 * (codex 0.32.0 through 0.156.1): `output` is a JSON string wrapping
 * `{"output":"…","metadata":{"exit_code":0,"duration_seconds":0.0}}` for a `shell` call (153 rows),
 * and a bare non-JSON string for everything else (131 rows) — an error message, `Plan updated`, an
 * approval refusal. `metadata` never carried a key beyond those two, so `exit_code` is the one
 * structured fact on this row and the only one folded in.
 *
 * NOT FILLED, on purpose. There is no diff to read: Codex applies a patch by running `apply_patch`
 * through the shell, so an edit's `added`/`removed` stay 0 and `diff` stays absent, because the
 * rollout records the patch nowhere. And code mode's `exec_command` writes its own `exit_code`
 * inside a list of `input_text` blocks instead of in `output` (1 row); `codexToolOutput` does not
 * read that shape either, so neither does this — a guess there would be a second grammar for one
 * row.
 */
function enrichCall(call: ToolCall, raw: JsonValue | undefined): void {
  if (call.kind !== "execute") return;
  // A `custom_tool_call_output` writes the code as a block of its own instead of in `metadata`, so the
  // list shape is enriched from {@link codexExecOutput}'s reading rather than from a second grammar.
  if (Array.isArray(raw)) {
    const code = codexExecOutput(raw).exitCode;
    if (code !== undefined) call.exitCode = code;
    return;
  }
  if (typeof raw !== "string") return;
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction — naming it keeps the reads below
    // checked property accesses.
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return; // a bare string output — it carries no metadata, so it carries no exit code
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const metadata = parsed.metadata;
  if (metadata === null || metadata === undefined || typeof metadata !== "object" || Array.isArray(metadata)) return;
  const code = metadata.exit_code;
  // Assigned, never set to `undefined`: a key holding `undefined` survives a deep compare.
  if (typeof code === "number" && Number.isFinite(code)) call.exitCode = code;
}

/**
 * Injected context Codex sends as a user turn. Rendering it as "You" would be actively wrong — the
 * operator never typed it — so it is dropped exactly like Claude's `system-reminder`.
 */
function isInjectedContext(text: string): boolean {
  return text.trimStart().startsWith("<environment_context>");
}

/** A rollout line, once JSON.parse has admitted it is an object at all. */
type CodexRow = JsonObject;

/**
 * Parse a Codex rollout log into oldest-first turns. PURE — no fs, no clock.
 *
 * Unparseable lines are skipped: the log is appended to live, so the last line can be a partial
 * write, and a tail-read window starts mid-line by construction.
 */
export function parseCodexTranscript(text: string): TranscriptEntry[] {
  return parseWith(createCodexReducer(), text);
}

/**
 * Every type this adapter has MET, rendered or dropped (`reduce.ts` § "what a reducer reports about
 * what it could not read"). Anything else is counted and named.
 *
 * Measured on 2026-09-30 over 48 local rollout logs (Codex 0.156.1), which is the whole inventory
 * they carry. TWO LEVELS land in `rows`, because Codex needs two to say what a row IS: the envelope's
 * own `type`, and the `payload.type` inside a `response_item`, which is the field that says whether
 * the item is speech, reasoning or a call. Content blocks land in `parts`: a message's `content`
 * (`input_text` / `output_text`, 596 of them) and reasoning's `summary` (`summary_text`, 202). Both
 * are read by FIELD here — `blockText` takes any block's `.text` — so a new block type would be
 * dropped in silence, which is exactly what this counts.
 *
 * `custom_tool_call` and `custom_tool_call_output` are READ, on the same branch as `function_call`,
 * and they are the shape codex reaches for most: 53 of them against 6 `function_call` on this host.
 * They were listed here while they were dropped, which is why the tally never counted them.
 *
 * `developer` is the one role that matters here: Codex writes three of those rows, carrying injected
 * system prompts, before the first real turn, and rendering one as speech would put words in the
 * operator's mouth (see the `message` branch).
 */
const CODEX_KNOWN: KnownTypes = {
  rows: [
    // The envelope.
    "response_item",
    "event_msg",
    "token_usage_record",
    "turn_context",
    "session_meta",
    "world_state",
    // What a `response_item` carries.
    "message",
    "reasoning",
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
  ],
  roles: ["user", "assistant", "developer"],
  parts: ["input_text", "output_text", "text", "summary_text"],
};

/**
 * The same reading, one row at a time (see `reduce.ts`).
 *
 * The loop this replaces was already a reducer wearing a `for`: both maps below were carried across
 * rows, and a `function_call_output` MUTATED a part inside a turn the loop had already pushed. So the
 * state a reducer needs is the state the loop always kept, and the only genuinely new thing here is
 * that the mutation gets REPORTED — under a tail that turn is on somebody's screen.
 *
 * Every row-level `continue` of that loop is a `return` here, and there is no other kind: Codex
 * flattens a row's content in {@link blockText} and in one inline `.map`, so the body never held an
 * inner loop to `continue` over.
 */
export function createCodexReducer(): RowReducer {
  // Row hash → how many times it has been seen, which is what gives two byte-identical rows distinct
  // cursors (see codexCursor). DELIBERATELY UNBOUNDED, unlike `pendingTools` below: evicting an entry
  // would make a later identical row reuse an earlier row's uuid, and a cursor pointing at the wrong
  // turn is worse than the memory. Its size is bounded by the window a reader feeds the reducer, not
  // by the length of the session.
  const seen = new Map<string, number>();
  // call_id → the part awaiting its output and the turn it went out in, so a `function_call_output`
  // lands on its own call and can name where that call is drawn.
  const pendingTools = new Map<string, PendingTool>();
  // What this reducer met and had no branch for, asked for once per session by the canary.
  const unknown = createUnknownCounter(CODEX_KNOWN);

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
    // A line that parses to a scalar (or a bare `null`, which used to reach `.type` and THROW) has
    // no row shape — skip it exactly as an unparseable line is skipped.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return NO_CHANGE;
    const row: CodexRow = parsed;
    // At the READ, not in the branch that declined (`reduce.ts` § `createUnknownCounter`).
    unknown.row(row.type);
    // The double-booking guard: everything the UI stream carries is already in `response_item`.
    if (row.type !== "response_item") return NO_CHANGE;
    const payload = row.payload;
    if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) return NO_CHANGE;
    const p: JsonObject = payload;
    // The second level of "what is this row": four branches below read it, and a fifth kind of item
    // is what this call catches. `summary` is reasoning's own block list, `content` is a message's.
    unknown.row(p.type);
    noteBlockTypes(unknown, p.content);
    noteBlockTypes(unknown, p.summary);
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";
    const uuid = codexCursor(line, seen);

    if (p.type === "message") {
      // Roles are matched EXPLICITLY, never "assistant or else user". Codex 0.145 writes `developer`
      // rows carrying the injected system prompts (permissions, multi-agent instructions) — three of
      // them before the first real turn — and treating an unknown role as speech would render those
      // as things the operator said. Anything that isn't user or assistant is plumbing: drop it.
      unknown.role(p.role);
      if (p.role !== "user" && p.role !== "assistant") return NO_CHANGE;
      const role = p.role;
      const body = stripAnsi(blockText(p.content));
      if (body.trim() === "") return NO_CHANGE;
      if (role === "user" && isInjectedContext(body)) return NO_CHANGE;
      entries.push({ uuid, ts, role, parts: [{ kind: "text", ...clamp(body, MAX_TEXT_CHARS) }] });
      return reduction(entries, changed);
    }

    if (p.type === "reasoning") {
      // Unlike Claude — whose persisted `thinking` text is empty every time — Codex writes a real
      // reasoning summary here, so this branch actually renders.
      const summary = Array.isArray(p.summary)
        ? p.summary
            .map((s) =>
              s !== null && typeof s === "object" && !Array.isArray(s) && typeof s.text === "string"
                ? s.text
                : "",
            )
            .filter(Boolean)
            .join("\n\n")
        : "";
      if (summary.trim() === "") return NO_CHANGE; // encrypted-only reasoning row — nothing to show
      entries.push({
        uuid,
        ts,
        role: "assistant",
        parts: [{ kind: "thinking", ...clamp(stripAnsi(summary), MAX_TEXT_CHARS) }],
      });
      return reduction(entries, changed);
    }

    // ONE branch for both call shapes. `custom_tool_call` carries the same three facts — a name, an
    // input and a `call_id` its output is paired by — so it folds onto the structured-call path rather
    // than beside it. The only difference is WHERE the input is and what it is: `arguments` is a JSON
    // string, `input` is the script itself (see codexCustomInput).
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name = typeof p.name === "string" ? p.name : "tool";
      const raw = p.type === "custom_tool_call" ? p.input : p.arguments;
      const summary = codexToolSummary(raw);
      const part: Extract<TranscriptPart, { kind: "tool" }> = {
        kind: "tool",
        name,
        summary,
        call: classifyToolCall(
          name,
          p.type === "custom_tool_call" ? codexCustomInput(raw) : codexToolInput(raw),
          summary,
        ),
      };
      if (typeof p.call_id === "string") {
        part.id = p.call_id;
        // The turn is named here, before it exists, because `uuid` is the row's own cursor above and
        // the part is already the object the turn will carry. `rememberPending` is what keeps an
        // orphan call from growing this map for the life of a session.
        rememberPending(pendingTools, p.call_id, { part, uuid });
      }
      entries.push({ uuid, ts, role: "assistant", parts: [part] });
      return reduction(entries, changed);
    }

    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const id = typeof p.call_id === "string" ? p.call_id : "";
      const target = pendingTools.get(id);
      const outputText = stripAnsi(
        p.type === "custom_tool_call_output" ? codexExecOutput(p.output).body : codexToolOutput(p.output),
      );
      const result: ToolResult = clamp(outputText, MAX_RESULT_CHARS);
      // Codex writes NO error flag on this row — a command that failed and one that worked are the
      // same shape, and the exit code sits in `metadata` rather than on the part. So `isError` stays
      // absent here, and only a refusal is marked (see REFUSED), because that one the text names.
      if (REFUSED.test(outputText)) result.denied = true;
      if (target) {
        // Mutated in place — the part already sits in an emitted entry, which is exactly why results
        // attach without reordering anything.
        pendingTools.delete(id);
        target.part.result = result;
        // The RAW field, not the unwrapped text: the exit code rides in `output`'s `metadata`, which
        // `codexToolOutput` throws away by design.
        if (target.part.call) enrichCall(target.part.call, p.output);
        // The mutation above landed in a turn that went out rows ago. Name it.
        changed.add(target.uuid);
      } else if (outputText.trim() !== "") {
        // Orphan output (its call fell outside a tail-read window) — kept unattached so the window
        // never silently drops output.
        entries.push({
          uuid,
          ts,
          role: "assistant",
          parts: [
            { kind: "tool", name: "result", summary: "", result },
          ],
        });
      }
    }

    // The row added no turn, which is not the same as a row that did nothing: the common case here is
    // a `function_call_output` whose result folded onto a call in an earlier turn, so it adds nothing
    // of its own and has still changed something. `NO_CHANGE` here would drop that report on the floor
    // and leave the folded result invisible to a tail, which is the one fault this exercise exists to
    // fix. It is also the answer for a `response_item` of a type this parser ignores.
    return reduction(entries, changed);
  }

  // No queue in this format's log: see `RowReducer.queued`.
  return { push, unknowns: unknown.tally, queued: noQueue };
}

/**
 * Real filesystem source rooted at Codex's `sessions` directory.
 *
 * Resolution is a targeted walk rather than Claude's flat scan, because the uuid is in the FILENAME
 * under date-partitioned directories (`YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`). We walk newest-date
 * first, so a live session is found after reading a handful of directory entries rather than the
 * whole year. The hit is cached; a cached path is re-verified before use, since a session can be
 * deleted while the bridge is up.
 *
 * No continuation-following, deliberately: Codex reports its session on the `SessionStart` hook (which
 * fires only at the first prompt, see `REPORTS_SESSION_ON_FIRST_PROMPT` in `registry.ts`), so a
 * resumed conversation re-reports its NEW id and the pane record follows it. That's the failure
 * Claude's followContinuation exists to paper over, and Codex's hook simply doesn't have it.
 */
export class CodexTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();

  private readonly roots: string[];

  /** One sessions directory or several (a second `CODEX_HOME`), searched in order. */
  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isCodexSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      if (await exists(cached)) return cached;
      this.pathCache.delete(sessionId);
    }

    const suffix = `-${sessionId.toLowerCase()}.jsonl`;
    for (const root of this.roots) {
      const hit = await this.findUnder(root, suffix);
      // A hit that failed containment is `null` too — that root has nothing it may serve for this
      // uuid either way, and the next root is asked on its own terms (files.ts header).
      if (hit === null) continue;
      this.pathCache.set(sessionId, hit);
      return hit;
    }
    return null;
  }

  /** Newest first at every level: a session being read is almost always today's. */
  private async findUnder(root: string, suffix: string): Promise<string | null> {
    for (const year of await descending(root)) {
      for (const month of await descending(join(root, year))) {
        for (const day of await descending(join(root, year, month))) {
          const dir = join(root, year, month, day);
          let names: string[];
          try {
            names = await readdir(dir);
          } catch {
            continue;
          }
          const hit = names.find(
            (n) => n.startsWith("rollout-") && n.toLowerCase().endsWith(suffix),
          );
          if (hit === undefined) continue;
          return containedRealpath(join(dir, hit), root);
        }
      }
    }
    return null;
  }

  stat = statFile;

  load = loadTail;

  /**
   * The live read, with one contract on its caller that no other harness imposes.
   *
   * A RESET MUST BE PAIRED WITH A FRESH REDUCER HERE. {@link codexCursor} numbers byte-identical
   * rows by occurrence, and that numbering is a property of the parsed window — which is stated as
   * an invariant where it is synthesised. A reset moves the window, so the numbering restarts, and a
   * reducer kept across one would carry `seen` counts for rows the caller has thrown away. Under an
   * append nothing renumbers, because the window only grows at the end.
   *
   * That is not a defect of the cursor, it is what `reset` means: the answer replaces what you hold,
   * uuids included.
   */
  readSince = readSinceFile;
}

/** Directory entries, newest-name first. Empty when the directory doesn't exist. */
async function descending(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).toSorted().toReversed();
  } catch {
    return [];
  }
}

/** Codex's journal adapter. `agent` matches the Herdr snapshot's `agent` string. */
export function codexJournal(roots: string | readonly string[]): JournalAdapter {
  const source = new CodexTranscriptSource(roots);
  return {
    agent: "codex",
    source,
    parse: parseCodexTranscript,
    reducer: createCodexReducer,
    cacheProbe: (ref) => codexCacheProbe(source, ref),
  };
}

// ── The prompt-cache probe ───────────────────────────────────────────────────
//
// Ported from herdr-cache-alert `src/harness/codex.ts:259-326`. THREE facts live on THREE DIFFERENT
// ROWS, which is why this walks back collecting rather than matching one line:
//
//   the clock      — any row's own `timestamp`
//   the cache counts — `payload.info.last_token_usage` where `payload.type === "token_count"`
//   the turn + model — `payload.turn_id` / `payload.model` where `type === "turn_context"`
//
// `last_token_usage` is the TURN. `total_token_usage` is a running total that reaches millions and
// would read as permanently warm, so it is never read. And `turn_context` is written once per turn
// while `token_count` fires many times, so the model can sit much further back than the newest counts
// — which is why the window is 128 KB and not smaller: a shorter tail finds the tokens and loses the
// model, silently demoting every GPT-5.6 session to the five-minute rule.
//
// Codex publishes nothing that names its TTL outright, so unlike Claude there is no `observedTtl`
// here. The model is what the rule is picked by (`bridge/cache/rules/index.ts` § modelRuleFor).

async function codexCacheProbe(
  source: CodexTranscriptSource,
  ref: AgentSessionRef,
): Promise<CacheProbe | null> {
  const tail = await probeTail(source, ref);
  if (tail === null) return null;

  let lastRequestAt = 0;
  let stamp = "";
  let turnId = "";
  let model: string | undefined;
  let usage: JsonObject | undefined;

  walkBack(tail.lines, (raw): true | undefined => {
    const entry = asRecord(raw);
    if (entry === null) return undefined;
    if (lastRequestAt === 0) {
      const ts = asText(entry.timestamp);
      const at = Date.parse(ts ?? "");
      if (!Number.isNaN(at)) {
        lastRequestAt = at;
        stamp = ts ?? "";
      }
    }
    const payload = asRecord(entry.payload);
    if (usage === undefined && payload !== null && payload.type === "token_count") {
      usage = asRecord(asRecord(payload.info)?.last_token_usage) ?? undefined;
    }
    if (turnId === "" && entry.type === "turn_context" && payload !== null) {
      turnId = asText(payload.turn_id) ?? "";
      model = asText(payload.model);
    }
    // `true` stops the walk; `undefined` keeps it going. Everything needed is in hand.
    return lastRequestAt !== 0 && usage !== undefined && turnId !== "" ? true : undefined;
  });

  if (lastRequestAt === 0) return null;
  const cacheReadTokens = tokenCount(usage?.cached_input_tokens);
  const cacheCreationTokens = tokenCount(usage?.cache_write_input_tokens);
  const detail = usage === undefined ? "no token_count in tail" : `cache read ${String(cacheReadTokens ?? "?")}`;
  const probe: CacheProbe = {
    lastRequestAt,
    // The turn id keeps a cold turn judged once. Falling back to the timestamp is correct but coarser:
    // `token_count` fires many times per turn, so a timestamp key re-judges the same turn every poll.
    turnId: turnId === "" ? String(lastRequestAt) : turnId,
    measuredAt: tail.mtimeMs,
    evidence: `${tail.path} (${stamp}${model === undefined ? "" : `, ${model}`}, ${detail})`,
  };
  if (cacheReadTokens !== undefined) probe.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens !== undefined) probe.cacheCreationTokens = cacheCreationTokens;
  if (model !== undefined) probe.model = model;
  return probe;
}
