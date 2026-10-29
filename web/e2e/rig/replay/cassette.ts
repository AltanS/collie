// The browser leg's cassettes (M67, ADR 0125): what a recorded model turn of pi, omp or Claude Code
// looks like on disk, how a request is matched to it, and how its stream is replayed. Pure: no network, no clock,
// no file system except the two small read/write helpers at the end, so the unit tests drive all of it.
//
// WHAT IS RECORDED. Per case, an ordered list of entries. An entry is one model request of one harness
// instance (`pi-lead`, `pi-member`) and the response the provider streamed back: the status, the
// content type, and the server-sent events, each with its delay in milliseconds after the one before
// (the first one: after the request arrived). A request body is never stored whole. Only its SUMMARY is:
// the wire format, the model, the stream flag, the tool names, the last prompt text (normalised, below)
// and the kinds of the messages after it. No header is stored, so no key and no Authorization header
// can reach a cassette, and `check.ts` proves it on every file.
//
// HOW A REQUEST IS MATCHED. A request with tools is a TURN of the agent's own loop. It is matched by
// its case and its ordinal in that case (per harness instance), and the summary's digest is the check:
// the first unused entry of the case whose digest equals the request's wins, so a harmless reorder of
// two requests still matches, and anything else is a cassette mismatch. A request with no tools is a
// SIDE request (a title, a summary, a description compressor): it is matched by digest alone, from a
// pool of every side entry the leg recorded for that harness, in any order and as often as asked.
//
// WHAT THE DIGEST IGNORES. The values that differ on every run: walky talky ids, pane addresses with
// their instance tokens, uuids, dates and times, the rig's ports, and the rig's own folders (VOLATILE
// below, and the literals the stub passes in). They are replaced by a class marker before hashing.
//
// HOW A VOLATILE VALUE GETS INTO A REPLAYED TURN. A recorded tool call names the walky id or the pane
// address of the recording run. At record time each such value in the response is replaced by a
// placeholder `{{class:i}}`, where i ranks the request's distinct values of that class by their LAST
// position in the request body (0 is the most recent). At replay the same rank over the live request
// gives the live value. The rewrite works on the concatenation of each delta stream, so a value split
// over two events is still found, and the event boundaries move only to keep a value whole.
//
// TWO VENDORS (M67 spec 07). pi and omp reach OpenRouter, Claude Code reaches Anthropic. The summary is
// the same shape for both; the `anthropic` vendor reads Claude Code's body: it cuts each
// `<system-reminder>` of the prompt to its first line (the reminders carry the operator's own CLAUDE.md
// and the account's email address), leaves Claude's `role: system` items out (the machine's OS version
// and the session's scratchpad path), and adds a `context` digest of the system blocks and the tool
// definitions. pi's and omp's summaries are unchanged, so their cassettes keep their digests.
import { createHash } from "node:crypto";

import { asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../../../src/lib/json";

/** A JSON value narrowed to a list, or `undefined`. */
function asJsonArray(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** The wire format of a model request, read off its path. */
export type WireApi = "anthropic" | "responses" | "chat" | "other";

/** A request without its body: the parts a replay is checked against. */
export interface RequestSummary {
  readonly api: WireApi;
  readonly model: string | null;
  readonly stream: boolean;
  /** The tool names, sorted. A request with none is a side request. */
  readonly tools: readonly string[];
  /** The last prompt's text, normalised: volatile values become `<class>`, the rig's folders `{{lab}}`. */
  readonly prompt: string;
  /** One word per item after the last prompt: `assistant`, `call:<tool>`, `result`, `reasoning`. */
  readonly tail: readonly string[];
  /**
   * The `anthropic` vendor only: sha256 (16 hex) of the normalised `system` blocks and tool
   * definitions, cache-control fields dropped. A new tool, a changed system prompt or another rig
   * folder layout changes it.
   */
  readonly context?: string;
}

/** Whose wire a request is read as: pi and omp go through OpenRouter, Claude Code to Anthropic. */
export type Vendor = "openrouter" | "anthropic";

/** One server-sent event as recorded: its delay after the event before it, its name and its data. */
export interface SseEvent {
  readonly ms: number;
  readonly event?: string;
  readonly data: string;
}

export interface RecordedResponse {
  readonly status: number;
  readonly contentType: string;
  /** The events of a streamed response. */
  readonly events?: readonly SseEvent[];
  /** The body of a response that did not stream (an error, mostly). */
  readonly body?: string;
  /** The harness hung up before the stream ended. The recorder read the stream to its end anyway. */
  readonly clientAborted?: boolean;
}

export type EntryKind = "turn" | "side";

export interface Entry {
  readonly kind: EntryKind;
  /** `lead` or `member`: the rig machine whose harness asked. */
  readonly machine: string;
  /** The entry's place among its case's entries of the same machine and kind, from 0. */
  readonly ordinal: number;
  readonly request: RequestSummary & { readonly path: string; readonly digest: string };
  readonly response: RecordedResponse;
}

/** The first line of a cassette file. */
export interface CassetteHeader {
  readonly v: 1;
  readonly harness: string;
  readonly version: string;
  readonly case: string;
  readonly leg: string;
  readonly recordedAt: string;
}

export interface Cassette {
  readonly header: CassetteHeader;
  readonly entries: readonly Entry[];
}

/** What one harness version has on file: per leg, the model, the skill hash and the cases recorded. */
export interface CassetteMeta {
  readonly v: 1;
  readonly harness: string;
  readonly version: string;
  readonly legs: Readonly<Record<string, LegMeta>>;
}

export interface LegMeta {
  readonly model: string;
  /** sha256 of cli/skills/walky-talky.md, first 16 hex: the skill text goes into the agent's prompt. */
  readonly skill: string;
  readonly recordedAt: string;
  readonly cases: readonly string[];
  /**
   * The cases whose recording comes from a live run in which the case did not pass (the leg's verdict,
   * leg.ts runScenario). A replay plays that run back, so such a case is re-recorded on its own.
   */
  readonly failed?: readonly string[];
}

// ── volatile values ──────────────────────────────────────────────────────────────────────────────

/**
 * The values that differ between two runs of the same case, as data. Order matters: a longer class
 * comes before one that could match inside it (an address holds a pane id, a timestamp holds a date).
 */
export const VOLATILE: readonly { readonly name: string; readonly re: RegExp }[] = [
  // A walky talky message id (bridge/walky/types.ts WALKY_ID), and a send id (SEND_ID).
  { name: "walky", re: /wt_[a-z0-9]{12}(?:-[0-9a-f]{8})?/gu },
  // A walky talky pane address with its instance token (bridge/walky/address.ts): the pane id is
  // Herdr's and depends on the order panes opened in, the token is random.
  // Never inside a path: `/usr/local/bin` is not a pane.
  { name: "address", re: /(?<![\w/.-])(?:local|rig-lead|rig-member)\/[A-Za-z0-9_.:%@+=-]+#[a-z0-9]{4}\b/gu },
  { name: "pane", re: /(?<![\w/.-])(?:local|rig-lead|rig-member)\/(?!all\b)[A-Za-z0-9_.:%@+=-]+/gu },
  { name: "uuid", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu },
  { name: "time", re: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gu },
  { name: "clock", re: /\b\d{1,2}:\d{2}:\d{2}\b/gu },
  // The rig's bridge and stub listen on 127.0.0.1:18700-18799 (rig-lib.ts PORT_LO..PORT_HI).
  { name: "port", re: /\b127\.0\.0\.1:\d{2,5}\b/gu },
];

/**
 * Claude Code's first system block names its build and a short hash of the conversation
 * (`cc_version=2.1.312.237`): the hash follows the operator's own memory files, so it is masked. The
 * version keys the cassette folder already.
 */
const CLAUDE_BILLING = /cc_version=[^;\s"\\]*/gu;

/** The address and pane classes after a JSON line or tab escape (volatileValues). */
const ESCAPED = new Map([
  ["address", /(?<=\\[nt])(?:local|rig-lead|rig-member)\/[A-Za-z0-9_.:%@+=-]+#[a-z0-9]{4}\b/gu],
  ["pane", /(?<=\\[nt])(?:local|rig-lead|rig-member)\/(?!all\b)[A-Za-z0-9_.:%@+=-]+/gu],
]);

/** A literal the stub knows, and its placeholder: the rig's state root (`{{lab}}`), the home (`{{home}}`). */
export type Literal = readonly [value: string, placeholder: string];

/**
 * The walky cases' own marks: a case writes `id.slice(3, 9)` of its message id into the body
 * (`Walky dialog check k5bosk: ...`, walky.spec.ts) to find the message on the screen. A mark is as
 * volatile as its id, so each walky id in a text makes its mark a volatile value of the class `mark`.
 */
function marksOf(text: string): string[] {
  const walky = VOLATILE.find((v) => v.name === "walky")?.re;
  if (walky === undefined) return [];
  return [...new Set([...text.matchAll(walky)].map((m) => m[0].slice(3, 9)))];
}

/** Each mark as a standalone word: never inside a longer word or an id. */
const markRe = (mark: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${mark}(?![A-Za-z0-9])`, "gu");

/** Replace every literal (longest first), then every volatile value by its class marker. */
export function normalizeText(text: string, literals: readonly Literal[] = []): string {
  let out = replaceLiterals(text, literals);
  const marks = marksOf(out);
  for (const { name, re } of VOLATILE) out = out.replace(re, `<${name}>`);
  for (const mark of marks) out = out.replace(markRe(mark), "<mark>");
  return out;
}

function replaceLiterals(text: string, literals: readonly Literal[]): string {
  let out = text;
  for (const [from, placeholder] of [...literals].filter(([literal]) => literal !== "").toSorted((a, b) => b[0].length - a[0].length)) {
    out = out.replaceAll(from, placeholder);
  }
  return out;
}

/**
 * The distinct values of each volatile class in a request body, most recent first: ranked by the
 * position of each value's LAST occurrence. A value of an earlier class is masked before a later
 * class is read, so a timestamp's date is not also counted as a date.
 */
/** The distinct values of each volatile class, most recent first. */
export type VolatileValues = Map<string, string[]>;

export function volatileValues(text: string): VolatileValues {
  const out: VolatileValues = new Map();
  let masked = text;
  const marks = marksOf(text);
  const take = (name: string, res: readonly RegExp[]) => {
    const last = new Map<string, number>();
    for (const re of res) for (const match of masked.matchAll(re)) last.set(match[0], Math.max(last.get(match[0]) ?? -1, match.index));
    out.set(
      name,
      [...last.entries()].toSorted((a, b) => b[1] - a[1]).map(([value]) => value),
    );
    for (const re of res) masked = masked.replace(re, (value) => "\u0000".repeat(value.length));
  };
  for (const { name, re } of VOLATILE) {
    take(name, [re]);
    // A mark is read right after the ids it comes from are masked (marksOf).
    if (name === "walky") take("mark", marks.map(markRe));
    // An address or pane that starts a line of a tool's output (`collie walky who`) follows a JSON
    // `\n` or `\t` escape in the raw body, which the class's own look-behind reads as a word. It
    // gets a class of its own, `lineaddress` or `linepane`, so the ranks of `address` and `pane` stay
    // what every recording before it was written with.
    const escaped = ESCAPED.get(name);
    if (escaped !== undefined) take(`line${name}`, [escaped]);
  }
  return out;
}

/** Record side: each volatile value of the request, as it may appear in the response, to its placeholder. */
export function placeholdersFor(values: VolatileValues, literals: readonly Literal[]): Literal[] {
  const out: Literal[] = [...literals];
  for (const [name, list] of values) list.forEach((value, i) => out.push([value, `{{${name}:${String(i)}}}`]));
  return out;
}

/** Replay side: each placeholder to the live request's value of the same class and rank. */
export function valuesFor(values: VolatileValues, literals: readonly Literal[]): Literal[] {
  const out: Literal[] = literals.map(([value, placeholder]) => [placeholder, value] as const);
  for (const [name, list] of values) list.forEach((value, i) => out.push([`{{${name}:${String(i)}}}`, value]));
  return out;
}

/** The placeholders a recorded response still names, so a replay can say which live value is missing. */
export function placeholdersIn(response: RecordedResponse): string[] {
  const text = `${response.body ?? ""}${(response.events ?? []).map((e) => e.data).join("\n")}`;
  return [...new Set(text.match(/\{\{[a-z]+(?::\d+)?\}\}/gu) ?? [])];
}

// ── the request summary ────────────────────────────────────────────────────────────────────────────

export function apiOf(path: string): WireApi {
  const bare = path.split("?")[0] ?? "";
  if (bare.endsWith("/messages")) return "anthropic";
  if (bare.endsWith("/responses")) return "responses";
  if (bare.endsWith("/chat/completions")) return "chat";
  return "other";
}

const list = (value: JsonValue | undefined): JsonValue[] => asJsonArray(value) ?? [];

function toolNames(body: JsonObject): string[] {
  return list(body.tools)
    .map((tool) => {
      const t = asJsonObject(tool);
      return asJsonString(t?.name) ?? asJsonString(asJsonObject(t?.function)?.name) ?? "?";
    })
    .toSorted();
}

/** The text blocks of a content value: a string, or a list of `{type: text|input_text, text}`. */
function texts(content: JsonValue | undefined): string[] {
  const s = asJsonString(content);
  if (s !== undefined) return [s];
  return list(content).flatMap((block) => {
    const b = asJsonObject(block);
    const type = asJsonString(b?.type);
    const text = asJsonString(b?.text);
    return text !== undefined && (type === "text" || type === "input_text") ? [text] : [];
  });
}

/** One word per item of a conversation after its last prompt (the tail of a turn). */
function tailWord(item: JsonObject): string {
  const role = asJsonString(item.role);
  const type = asJsonString(item.type);
  if (type === "function_call") return `call:${asJsonString(item.name) ?? "?"}`;
  if (type === "function_call_output") return "result";
  if (type === "reasoning") return "reasoning";
  if (role === "tool") return "result";
  if (role === "assistant") {
    const calls = [
      ...list(item.content).flatMap((block) => {
        const b = asJsonObject(block);
        return asJsonString(b?.type) === "tool_use" ? [`call:${asJsonString(b?.name) ?? "?"}`] : [];
      }),
      ...list(item.tool_calls).map((call) => `call:${asJsonString(asJsonObject(asJsonObject(call)?.function)?.name) ?? "?"}`),
    ];
    return calls.length > 0 ? calls.join("+") : "assistant";
  }
  if (role === "user") return list(item.content).some((block) => asJsonString(asJsonObject(block)?.type) === "tool_result") ? "result" : "user";
  return type ?? role ?? "?";
}

/** True when a conversation item is a prompt: a user item with text that is not only tool results. */
function isPrompt(item: JsonObject): boolean {
  return asJsonString(item.role) === "user" && texts(item.content).length > 0;
}

/**
 * One text block of a Claude Code prompt, as the summary keeps it. A `<system-reminder>` block keeps
 * its first line (what kind of reminder it is) and every `Contents of {{lab}}...` or
 * `Contents of {{worktree}}...` section (a memory file the rig wrote); the rest is the operator's own
 * (their CLAUDE.md found on the walk up from the project, the account's email address). Any other
 * block is kept whole. The literals are already placeholders here.
 */
export function cutReminder(block: string): string {
  const open = "<system-reminder>";
  const trimmed = block.trim();
  if (!trimmed.startsWith(open)) return block;
  const body = trimmed.slice(open.length).replace(/<\/system-reminder>\s*$/u, "");
  const first = body.split("\n").find((line) => line.trim() !== "") ?? "";
  const rigFiles = body.split(/\n(?=Contents of )/u).filter((section) => /^Contents of \{\{(?:lab|worktree)\}\}/u.test(section));
  return [open, first.trim(), ...rigFiles.map((section) => section.trim()), "</system-reminder>"].join("\n");
}

/** A JSON value with every `cache_control` field dropped: Claude Code moves its cache breakpoints between turns. */
function withoutCacheControl(value: JsonValue): JsonValue {
  const arr = asJsonArray(value);
  if (arr !== undefined) return arr.map(withoutCacheControl);
  const obj = asJsonObject(value);
  if (obj === undefined) return value;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(obj)) if (key !== "cache_control" && item !== undefined) out[key] = withoutCacheControl(item);
  return out;
}

/** The `anthropic` vendor's context digest: the system blocks and the tool definitions, normalised. */
function contextOf(body: JsonObject, literals: readonly Literal[]): string {
  const text = JSON.stringify([withoutCacheControl(body.system ?? null), withoutCacheControl(body.tools ?? [])]).replace(CLAUDE_BILLING, "cc_version=<build>");
  return shortHash(normalizeText(text, literals));
}

/**
 * Read a request body's summary. A body that is not a JSON object gives an `other` summary with its
 * text normalised. `vendor` says whose body it is (see TWO VENDORS above); `openrouter` is pi's and omp's.
 */
export function summarize(path: string, raw: string, literals: readonly Literal[] = [], vendor: Vendor = "openrouter"): RequestSummary {
  const api = apiOf(path);
  const body = asJsonObject(parseJson(raw));
  if (body === undefined) return { api: "other", model: null, stream: false, tools: [], prompt: normalizeText(raw.slice(0, 2000), literals), tail: [] };
  const claude = vendor === "anthropic";
  const items = list(api === "responses" ? body.input : body.messages).flatMap((item) => {
    const o = asJsonObject(item);
    // Claude Code's `role: system` items: its environment (OS version, scratchpad path) and a token count.
    if (o === undefined || (claude && asJsonString(o.role) === "system")) return [];
    return [o];
  });
  const at = items.findLastIndex(isPrompt);
  const blocks = at === -1 ? [] : texts(items[at]?.content);
  const prompt = claude ? blocks.map((block) => cutReminder(replaceLiterals(block, literals))).join("\n") : blocks.join("\n");
  const summary: RequestSummary = {
    api,
    model: asJsonString(body.model) ?? null,
    stream: body.stream === true,
    tools: toolNames(body),
    prompt: normalizeText(prompt, literals),
    tail: items.slice(at + 1).map(tailWord),
  };
  return claude ? { ...summary, context: contextOf(body, literals) } : summary;
}

export function kindOf(summary: RequestSummary): EntryKind {
  return summary.tools.length > 0 ? "turn" : "side";
}

/** The check a replayed request must pass: sha256 of the summary, 16 hex. */
export function digestOf(summary: RequestSummary): string {
  const parts: unknown[] = [summary.api, summary.model, summary.stream, summary.tools, summary.prompt, summary.tail];
  // Only Claude's summary has a context; pi's and omp's digests stay what their cassettes hold.
  if (summary.context !== undefined) parts.push(summary.context);
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

// ── server-sent events ───────────────────────────────────────────────────────────────────────────

/** Split a growing SSE text into its complete blocks and the incomplete rest. */
/** The complete blocks of a growing SSE text, and the incomplete rest. */
export interface SseSplit {
  readonly blocks: string[];
  readonly rest: string;
}

export function splitSse(text: string): SseSplit {
  const parts = text.split(/\r?\n\r?\n/u);
  const rest = parts.pop() ?? "";
  return { blocks: parts, rest };
}

/** One SSE block to an event, or null for a block with no data (a `: keep-alive` comment). */
export function parseSseBlock(block: string, ms: number): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
  }
  if (data.length === 0) return null;
  return event === undefined ? { ms, data: data.join("\n") } : { ms, event, data: data.join("\n") };
}

export function serializeSse(event: SseEvent): string {
  return `${event.event === undefined ? "" : `event: ${event.event}\n`}${event.data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;
}

// ── rewriting a recorded stream ──────────────────────────────────────────────────────────────────

/** A string leaf of an event's JSON: where it sits, and which stream it continues. */
/** One step into a JSON document: an object key or a list position. */
type Step = { readonly key: string } | { readonly at: number };

interface Leaf {
  readonly event: number;
  readonly path: readonly Step[];
  readonly stream: string | null;
  readonly text: string;
}

const ID_FIELDS = ["type", "index", "output_index", "content_index", "item_id"];

function leaves(doc: JsonValue, event: number): Leaf[] {
  const out: Leaf[] = [];
  const top = asJsonObject(doc);
  const ids = top === undefined ? "" : JSON.stringify(ID_FIELDS.map((key) => top[key] ?? null));
  const walk = (value: JsonValue, path: readonly Step[], named: readonly string[]) => {
    const s = asJsonString(value);
    if (s !== undefined) {
      // A leaf under a `delta` key is a piece of a longer text: its stream is its path, with each
      // array element named by its own `index` where it has one (a chat tool call), plus the event's ids.
      out.push({ event, path, stream: named.includes("delta") ? `${ids}|${named.join(".")}` : null, text: s });
      return;
    }
    const arr = asJsonArray(value);
    if (arr !== undefined) {
      arr.forEach((item, i) => {
        const index = asJsonObject(item)?.index;
        walk(item, [...path, { at: i }], [...named, index === undefined ? String(i) : `#${String(index)}`]);
      });
      return;
    }
    const obj = asJsonObject(value);
    if (obj === undefined) return;
    for (const [key, item] of Object.entries(obj)) if (item !== undefined) walk(item, [...path, { key }], [...named, key]);
  };
  walk(doc, [], []);
  return out;
}

function setAt(doc: JsonValue, path: readonly Step[], text: string): void {
  let node: JsonValue | undefined = doc;
  for (const step of path.slice(0, -1)) node = "at" in step ? asJsonArray(node)?.[step.at] : asJsonObject(node)?.[step.key];
  const last = path.at(-1);
  if (last === undefined) return;
  if ("at" in last) {
    const arr = asJsonArray(node);
    if (arr !== undefined) arr[last.at] = text;
    return;
  }
  const obj = asJsonObject(node);
  if (obj !== undefined) obj[last.key] = text;
}

/**
 * Replace literals across a list of parts that form one text, keeping the parts' boundaries where
 * they fall outside a replaced value. A boundary inside one moves to its end, so the whole new value
 * lands in the part where the old one started.
 */
export function replaceAcross(parts: readonly string[], pairs: readonly Literal[]): string[] {
  const whole = parts.join("");
  const sorted = pairs.filter(([from]) => from !== "").toSorted((a, b) => b[0].length - a[0].length);
  if (sorted.length === 0) return [...parts];
  const hits: { start: number; end: number; to: string }[] = [];
  for (let i = 0; i < whole.length; ) {
    const pair = sorted.find(([from]) => whole.startsWith(from, i));
    if (pair === undefined) {
      i++;
      continue;
    }
    hits.push({ start: i, end: i + pair[0].length, to: pair[1] });
    i += pair[0].length;
  }
  if (hits.length === 0) return [...parts];
  /** Where an old offset lands in the new text. */
  const mapOffset = (offset: number): number => {
    let shift = 0;
    for (const hit of hits) {
      if (offset <= hit.start) break;
      if (offset < hit.end) return hit.start + shift + hit.to.length;
      shift += hit.to.length - (hit.end - hit.start);
    }
    return offset + shift;
  };
  let rebuilt = "";
  let at = 0;
  for (const hit of hits) {
    rebuilt += whole.slice(at, hit.start) + hit.to;
    at = hit.end;
  }
  rebuilt += whole.slice(at);
  const out: string[] = [];
  let from = 0;
  let old = 0;
  for (const part of parts) {
    old += part.length;
    const to = mapOffset(old);
    out.push(rebuilt.slice(from, to));
    from = to;
  }
  return out;
}

/** A recorded response while it is rewritten. */
type WritableResponse = { -readonly [K in keyof RecordedResponse]: RecordedResponse[K] };

/** Rewrite a recorded response: every literal `from` becomes `to`, in the body and in every event. */
export function rewriteResponse(response: RecordedResponse, pairs: readonly Literal[]): RecordedResponse {
  const out: WritableResponse = { ...response };
  if (response.body !== undefined) out.body = replaceAcross([response.body], pairs)[0] ?? response.body;
  if (response.events === undefined) return out;
  const docs = response.events.map((e) => parseJson(e.data));
  const all = docs.flatMap((doc, i) => (doc === undefined ? [] : leaves(doc, i)));
  const changed = new Set<number>();
  const write = (leaf: Leaf, text: string) => {
    if (text === leaf.text) return;
    const doc = docs[leaf.event];
    if (doc === undefined) return;
    setAt(doc, leaf.path, text);
    changed.add(leaf.event);
  };
  const streams = new Map<string, Leaf[]>();
  for (const leaf of all) {
    if (leaf.stream === null) write(leaf, replaceAcross([leaf.text], pairs)[0] ?? leaf.text);
    else streams.set(leaf.stream, [...(streams.get(leaf.stream) ?? []), leaf]);
  }
  for (const group of streams.values()) {
    const next = replaceAcross(
      group.map((leaf) => leaf.text),
      pairs,
    );
    group.forEach((leaf, i) => write(leaf, next[i] ?? ""));
  }
  out.events = response.events.map((e, i) => {
    if (docs[i] === undefined) return { ...e, data: replaceAcross([e.data], pairs)[0] ?? e.data };
    return changed.has(i) ? { ...e, data: JSON.stringify(docs[i]) } : e;
  });
  return out;
}

// ── matching ─────────────────────────────────────────────────────────────────────────────────────

/** Why a request found no entry, in words for the case's row. Always ends with how to fix it. */
export const RERECORD = "re-record: COLLIE_RIG_LIVE=<harness> COLLIE_RIG_RECORD=1 (a key file for pi and omp; web/e2e/rig/README.md)";

export type Match = { readonly entry: Entry; readonly index: number } | { readonly mismatch: string };

/**
 * A turn request against its case's entries: the first unused entry of this machine and kind whose
 * digest equals the request's. `used` holds the indexes already served.
 */
export function matchTurn(entries: readonly Entry[] | undefined, machine: string, summary: RequestSummary, used: ReadonlySet<number>, caseId: string): Match {
  if (entries === undefined) return { mismatch: `cassette mismatch: no cassette for case ${caseId}; ${RERECORD}` };
  const digest = digestOf(summary);
  const mine = entries.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => entry.kind === "turn" && entry.machine === machine && !used.has(index));
  const hit = mine.find(({ entry }) => entry.request.digest === digest);
  if (hit !== undefined) return hit;
  const next = mine[0]?.entry;
  if (next === undefined) return { mismatch: `cassette mismatch: case ${caseId} has no turn left for this request (prompt "${clip(summary.prompt)}"); ${RERECORD}` };
  const context = next.request.context !== summary.context && next.request.prompt === summary.prompt ? ` (same prompt, another system prompt or tool list: context ${next.request.context ?? "-"}, got ${summary.context ?? "-"})` : "";
  return { mismatch: `cassette mismatch: case ${caseId} turn ${String(next.ordinal)} expected prompt "${clip(next.request.prompt)}" tail [${next.request.tail.join(" ")}], got "${clip(summary.prompt)}" tail [${summary.tail.join(" ")}]${context}; ${RERECORD}` };
}

/** A turn found in a case: which case, which entry, and its index there. */
export type CaseMatch = { readonly caseId: string; readonly entry: Entry; readonly index: number } | { readonly mismatch: string };

/**
 * A turn request against every case of the harness: its own case first (matchTurn), then any other
 * case's unused turn of this machine with the same digest. The second step covers a request that
 * crosses a case boundary (it left the harness just after the next case began, in the recording run
 * or in this one). The digest holds the prompt, the tail and the tools, so a borrowed entry answers
 * the very request it was recorded for: it is never a nearby answer.
 */
export function matchTurnAcross(byCase: ReadonlyMap<string, readonly Entry[]> | undefined, caseId: string, machine: string, summary: RequestSummary, usedIn: (caseId: string) => ReadonlySet<number>): CaseMatch {
  const own = matchTurn(byCase?.get(caseId), machine, summary, usedIn(caseId), caseId);
  if (!("mismatch" in own)) return { caseId, ...own };
  const digest = digestOf(summary);
  for (const [other, entries] of byCase ?? []) {
    if (other === caseId) continue;
    const used = usedIn(other);
    const index = entries.findIndex((entry, i) => entry.kind === "turn" && entry.machine === machine && !used.has(i) && entry.request.digest === digest);
    const entry = entries[index];
    if (entry !== undefined) return { caseId: other, entry, index };
  }
  return own;
}

/** A side request against the pool of every side entry the leg recorded for this harness. */
export function matchSide(pool: readonly Entry[], summary: RequestSummary): Entry | null {
  const digest = digestOf(summary);
  return pool.find((entry) => entry.request.digest === digest) ?? null;
}

const clip = (text: string): string => (text.length > 120 ? `${text.slice(0, 117)}...` : text).replaceAll("\n", " ");

// ── files ────────────────────────────────────────────────────────────────────────────────────────

/** A case id as a file name: `pi.walky-agents.jsonl`. A case id is `<harness>.<scenario>`. */
export function caseFile(caseId: string): string {
  if (!/^[a-z0-9-]+\.[a-z0-9-]+$/u.test(caseId)) throw new Error(`not a case id: ${caseId}`);
  return `${caseId}.jsonl`;
}

/** A harness version as a folder name. */
export function versionDir(version: string): string {
  if (!/^[0-9A-Za-z.+-]+$/u.test(version)) throw new Error(`not a version: ${version}`);
  return version;
}

export function formatCassette(cassette: Cassette): string {
  return `${[cassette.header, ...cassette.entries].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export function parseCassette(text: string): Cassette {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const [head, ...rest] = lines;
  if (head === undefined) throw new Error("an empty cassette");
  // SAFETY: the file is the rig's own output (formatCassette); its first line is the header and every
  // other line an entry. A hand-edited file that breaks the summary fails the case as a mismatch.
  const header = JSON.parse(head) as CassetteHeader;
  if (header.v !== 1) throw new Error(`cassette version ${String(header.v)} is not 1`);
  // SAFETY: as for the header: every other line is an entry formatCassette wrote.
  return { header, entries: rest.map((line) => JSON.parse(line) as Entry) };
}

/** sha256 of a text, 16 hex: the skill hash of a cassette leg. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ── the redaction check ──────────────────────────────────────────────────────────────────────────

/** What must never be in a cassette, as data: `check.ts` fails a file on any of these (the owner's host and company names are in check.ts HOSTS). */
export const FORBIDDEN: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "an OpenRouter key", re: /sk-or-v1-[A-Za-z0-9]{8,}/u },
  { name: "an Anthropic key", re: /sk-ant-[A-Za-z0-9_-]{16,}/u },
  { name: "an OpenAI-style key", re: /\bsk-[A-Za-z0-9]{32,}/u },
  { name: "a bearer token", re: /\bBearer\s+\S{8,}/u },
  { name: "an Authorization header", re: /"?authorization"?\s*[:=]/iu },
  { name: "an x-api-key header", re: /"?x-api-key"?\s*[:=]/iu },
  { name: "a home folder path", re: /(?:\/var\/home|\/home|\/Users)\/[A-Za-z0-9._-]+/u },
];

/** The key patterns the recorder blanks in a response before it is written (a model that echoes one). */
const KEY_PATTERNS: readonly RegExp[] = [/sk-or-v1-[A-Za-z0-9]{16,}/gu, /sk-ant-[A-Za-z0-9_-]{16,}/gu, /\bsk-[A-Za-z0-9]{32,}/gu, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gu];

/**
 * Drop what a Responses stream echoes of the REQUEST: OpenRouter's `response.created`,
 * `response.in_progress` and `response.completed` events carry the request's whole `instructions`
 * (the system prompt) and `tools`, about 30 KB each, three times per request. A cassette stores no
 * request body, so they become `null` and `[]`. The output items, the usage and the ids stay.
 */
export function compactResponse(response: RecordedResponse): RecordedResponse {
  if (response.events === undefined) return response;
  const events = response.events.map((e) => {
    const doc = asJsonObject(parseJson(e.data));
    const inner = asJsonObject(doc?.response);
    if (doc === undefined || inner === undefined || (inner.instructions === undefined && inner.tools === undefined)) return e;
    const kept: JsonObject = { ...inner };
    if (inner.instructions !== undefined) kept.instructions = null;
    if (inner.tools !== undefined) kept.tools = [];
    return { ...e, data: JSON.stringify({ ...doc, response: kept }) };
  });
  return { ...response, events };
}

/** Blank every key pattern in a recorded response, in its events and its body. */
export function redactKeys(response: RecordedResponse): RecordedResponse {
  const blank = (text: string): string => KEY_PATTERNS.reduce((out, re) => out.replace(re, "[redacted key]"), text);
  const out: WritableResponse = { ...response };
  if (response.body !== undefined) out.body = blank(response.body);
  if (response.events !== undefined) out.events = response.events.map((e) => ({ ...e, data: blank(e.data) }));
  return out;
}

/** The forbidden things a text holds, by name and line. Empty: the text is clean. */
export function forbiddenIn(text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const { name, re } of FORBIDDEN) if (re.test(line)) out.push(`line ${String(i + 1)}: ${name}`);
  });
  return out;
}
