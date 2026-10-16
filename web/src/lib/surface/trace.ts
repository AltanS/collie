// Golden traces: a recorded run of screen reads, hook edges and ticks, with the Surface expected after
// each step (M56 spec 11; spec 10 builds the nightly lab on this format).
//
// A trace is one JSON Lines file, `web/src/fixtures/traces/<harness>/<name>.jsonl`.
//
// Line 1 is the header:
//   { "kind": "trace", "harness": "<profile id or agent string>", "version": "X.Y.Z",
//     "set": "positive" | "negative", "source": "<where it came from>", "note": "<what it shows>",
//     "pollMs": 1000 }                                        (pollMs is optional, default 1000)
//
// Each later line is one step: `at` (ms from the start of the trace), one input, and an optional
// `expect`:
//   { "at": 0, "read": { "rows": 40, "cols": 119, "text": "<the screen with its SGR>" } }
//   { "at": 0, "read": { "rows": 40, "cols": 119, "fixture": "<a file in fixtures/panes>" } }
//   { "at": 900, "edge": { "event": "Stop" } }
//   { "at": 900, "edge": { "event": "Notification", "detail": "permission_prompt" } }
//   { "at": 900, "edge": { "event": "UserPromptSubmit", "prompt": "<the prompt text>" } }
//   { "at": 5000, "tick": true }
//   { "at": 100, "send": { "id": "r1", "text": "<the text a send typed>" } }
//   { "at": 100, "send": { "id": "r2", "text": "<...>", "queued": true } }  (a send queued behind a turn)
// `expect` names only the claims it checks:
//   { "free": false, "turn": "running", "modal": "none" | "ask" | "unreadable" | "unknown",
//     "composer": "empty", "reason": "contested" | null, "lostStops": 1, "receipts": { "r1": "effective" } }
// `reason: null` means "no reason". A `send` opens a receipt; a prompt edge whose text matches closes
// it as `effective` (the same rule the bridge uses, edges.ts `closingReceipt`).
//
// A negative trace must never read free, at any step. The CI test replays every trace three ways: the
// hook source present, removed (the fold's source list without `edge`), and lying (every edge kind
// inverted, and a closing edge before every read). All three keep every negative trace off `free`.
//
// Pure: the caller hands in the text of the file and a way to read a fixture. No DOM, no Bun API.

import { parseAnsi } from "../ansi";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../json";
import { splitLines, type StyledLine } from "../blocks";
import { closingReceipt, edgeKindOf, invertEdge, tracePromptHash, type EdgeKind, type OpenReceipt } from "./edges";
import { emptyFoldState, readFold, stepFold, SURFACE_SOURCES, type FoldContext, type FoldState, type SurfaceInput, type SurfaceSource } from "./fold";
import { liftAsk, readerBlocks } from "./lift";
import { loadProfiles } from "./profile";
import { isFree, modalWord, type Surface } from "./surface";

export type TraceSet = "positive" | "negative";

export interface TraceHeader {
  readonly kind: "trace";
  readonly harness: string;
  readonly version: string;
  readonly set: TraceSet;
  readonly source: string;
  readonly note: string;
  readonly pollMs?: number;
}

export interface TraceExpect {
  readonly free?: boolean;
  readonly turn?: Surface["turn"];
  readonly modal?: "none" | "ask" | "unreadable" | "unknown";
  readonly composer?: Surface["composer"];
  readonly reason?: string | null;
  readonly lostStops?: number;
  readonly receipts?: Readonly<Record<string, "open" | "effective">>;
}

/** A trace edge while it is built from its line. */
interface TraceEdgeDraft {
  event: string;
  detail?: string;
  prompt?: string;
  pid?: number;
}

export type TraceInput =
  | {
      readonly read: {
        readonly rows: number;
        readonly cols: number;
        readonly text?: string;
        readonly fixture?: string;
        /** Rows already parsed. A loader sets them for a screen no file holds (an incident rebuilt from a base). A trace file never has them. */
        readonly styled?: readonly StyledLine[];
      };
    }
  | { readonly edge: { readonly event: string; readonly detail?: string; readonly prompt?: string; readonly pid?: number } }
  | { readonly tick: true }
  | { readonly send: { readonly id: string; readonly text: string; readonly queued?: boolean } };

export type TraceStep = TraceInput & { readonly at: number; readonly expect?: TraceExpect };

export interface Trace {
  readonly name: string;
  readonly header: TraceHeader;
  readonly steps: readonly TraceStep[];
}

/** How the hook source takes part in a replay. */
export type HookMode = "present" | "removed" | "lying";
export const HOOK_MODES: readonly HookMode[] = ["present", "removed", "lying"];

/** A trace file that is not one this module reads. */
export class TraceError extends Error {
  constructor(name: string, line: number, problem: string) {
    super(`${name}:${String(line)}: ${problem}`);
    this.name = "TraceError";
  }
}

const SURFACE_TURNS: readonly Surface["turn"][] = ["idle", "running", "unknown"];
const MODAL_WORDS = ["none", "ask", "unreadable", "unknown"] as const;
const COMPOSERS: readonly Surface["composer"][] = ["empty", "draft", "unreachable", "unknown"];
const OUTCOMES = ["open", "effective"] as const;

function pick<const T extends string>(value: JsonValue | undefined, allowed: readonly T[]): T | undefined {
  const word = asJsonString(value);
  return allowed.find((candidate) => candidate === word);
}

function parseHeader(name: string, value: JsonValue | undefined): TraceHeader {
  const node = asJsonObject(value);
  if (node === undefined || node.kind !== "trace") throw new TraceError(name, 1, "line 1 must be the header, kind trace");
  const harness = asJsonString(node.harness);
  const version = asJsonString(node.version);
  const source = asJsonString(node.source);
  const note = asJsonString(node.note);
  if (harness === undefined || version === undefined || source === undefined || note === undefined) {
    throw new TraceError(name, 1, "the header needs harness, version, source and note as strings");
  }
  const set = pick(node.set, ["positive", "negative"] as const);
  if (set === undefined) throw new TraceError(name, 1, "set must be positive or negative");
  const header: TraceHeader = { kind: "trace", harness, version, set, source, note };
  if (node.pollMs === undefined) return header;
  const pollMs = asJsonNumber(node.pollMs);
  if (pollMs === undefined || pollMs <= 0) throw new TraceError(name, 1, "pollMs must be a positive number");
  return { ...header, pollMs };
}

function parseExpect(name: string, line: number, value: JsonValue | undefined): TraceExpect | undefined {
  if (value === undefined) return undefined;
  const node = asJsonObject(value);
  if (node === undefined) throw new TraceError(name, line, "expect must be an object");
  const out: { -readonly [K in keyof TraceExpect]: TraceExpect[K] } = {};
  const bad = (key: string): never => {
    throw new TraceError(name, line, `expect.${key} is not a value this format knows`);
  };
  if (node.free !== undefined) out.free = asJsonBoolean(node.free) ?? bad("free");
  if (node.turn !== undefined) out.turn = pick(node.turn, SURFACE_TURNS) ?? bad("turn");
  if (node.modal !== undefined) out.modal = pick(node.modal, MODAL_WORDS) ?? bad("modal");
  if (node.composer !== undefined) out.composer = pick(node.composer, COMPOSERS) ?? bad("composer");
  if (node.reason !== undefined) out.reason = node.reason === null ? null : (asJsonString(node.reason) ?? bad("reason"));
  if (node.lostStops !== undefined) out.lostStops = asJsonNumber(node.lostStops) ?? bad("lostStops");
  if (node.receipts !== undefined) {
    const receipts = asJsonObject(node.receipts) ?? bad("receipts");
    out.receipts = Object.fromEntries(Object.entries(receipts).map(([id, outcome]) => [id, pick(outcome, OUTCOMES) ?? bad(`receipts.${id}`)]));
  }
  return out;
}

function parseInput(name: string, line: number, node: JsonObject): TraceInput {
  const keys = ["read", "edge", "tick", "send"].filter((key) => node[key] !== undefined);
  if (keys.length !== 1) throw new TraceError(name, line, "a step holds exactly one of read, edge, tick, send");
  const read = asJsonObject(node.read);
  if (read !== undefined) {
    const rows = asJsonNumber(read.rows);
    const cols = asJsonNumber(read.cols);
    const text = asJsonString(read.text);
    const fixture = asJsonString(read.fixture);
    if (rows === undefined || cols === undefined || (text === undefined) === (fixture === undefined)) {
      throw new TraceError(name, line, "a read needs rows, cols and one of text or fixture");
    }
    return { read: text === undefined ? { rows, cols, fixture } : { rows, cols, text } };
  }
  const edge = asJsonObject(node.edge);
  if (edge !== undefined) {
    const event = asJsonString(edge.event);
    if (event === undefined) throw new TraceError(name, line, "an edge needs an event");
    const detail = asJsonString(edge.detail);
    const prompt = asJsonString(edge.prompt);
    const pid = asJsonNumber(edge.pid);
    const out: TraceEdgeDraft = { event };
    if (detail !== undefined) out.detail = detail;
    if (prompt !== undefined) out.prompt = prompt;
    if (pid !== undefined) out.pid = pid;
    return { edge: out };
  }
  const send = asJsonObject(node.send);
  if (send !== undefined) {
    const id = asJsonString(send.id);
    const text = asJsonString(send.text);
    if (id === undefined || text === undefined) throw new TraceError(name, line, "a send needs an id and a text");
    return asJsonBoolean(send.queued) === true ? { send: { id, text, queued: true } } : { send: { id, text } };
  }
  if (node.tick !== true) throw new TraceError(name, line, "a tick is `true`");
  return { tick: true };
}

function parseStep(name: string, line: number, value: JsonValue | undefined): TraceStep {
  const node = asJsonObject(value);
  const at = asJsonNumber(node?.at);
  if (node === undefined || at === undefined) throw new TraceError(name, line, "a step needs a number `at`");
  const input = parseInput(name, line, node);
  const expect = parseExpect(name, line, node.expect);
  return expect === undefined ? { ...input, at } : { ...input, at, expect };
}

/** One trace file's text, parsed. Throws a {@link TraceError} that names the line. */
export function parseTrace(name: string, text: string): Trace {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new TraceError(name, 1, "the file is empty");
  const parsed = lines.map((line, i) => {
    const value = parseJson(line);
    if (value === undefined) throw new TraceError(name, i + 1, "not JSON");
    return value;
  });
  const header = parseHeader(name, parsed[0]);
  const steps = parsed.slice(1).map((value, i) => parseStep(name, i + 2, value));
  if (steps.length === 0) throw new TraceError(name, 2, "a trace needs at least one step");
  return { name, header, steps };
}

/** One step's result: the Surface after it, the fold state and the receipts. */
export interface TraceStepResult {
  readonly index: number;
  readonly surface: Surface;
  readonly state: FoldState;
  readonly receipts: Readonly<Record<string, "open" | "effective">>;
  /** What did not match `expect`, one line each; empty when it matched or there was none. */
  readonly mismatches: readonly string[];
}

export interface ReplayOptions {
  readonly mode: HookMode;
  /** The text of a fixture named by a read. */
  readonly fixture: (name: string) => string;
}

const TRACE_PANE = "trace";

function rowsOf(read: { readonly text?: string; readonly fixture?: string; readonly styled?: readonly StyledLine[] }, fixture: (name: string) => string): StyledLine[] {
  if (read.styled !== undefined) return [...read.styled];
  return splitLines(parseAnsi(read.text ?? fixture(read.fixture ?? "")));
}

function check(expect: TraceExpect | undefined, surface: Surface, state: FoldState, receipts: Record<string, "open" | "effective">): string[] {
  if (expect === undefined) return [];
  const out: string[] = [];
  const want = (what: string, expected: string | number | boolean | undefined, actual: string | number | boolean | undefined): void => {
    if (expected !== undefined && expected !== actual) out.push(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  };
  want("free", expect.free, isFree(surface));
  want("turn", expect.turn, surface.turn);
  want("modal", expect.modal, modalWord(surface.modal));
  want("composer", expect.composer, surface.composer);
  if (expect.reason !== undefined) want("reason", expect.reason ?? "none", surface.reason ?? "none");
  want("lostStops", expect.lostStops, state.lostStops);
  for (const [id, outcome] of Object.entries(expect.receipts ?? {})) want(`receipt ${id}`, outcome, receipts[id]);
  return out;
}

/**
 * Replay a trace through the real fold. The profile is the harness's own (its `idle` anchors, its edge
 * map and settle time); a harness with no profile reads with none, and every edge is a `reread`.
 */
export function replayTrace(trace: Trace, options: ReplayOptions): TraceStepResult[] {
  const profile = loadProfiles().get(trace.header.harness) ?? null;
  const sources: readonly SurfaceSource[] = options.mode === "removed" ? SURFACE_SOURCES.filter((source) => source !== "edge") : SURFACE_SOURCES;
  const context: FoldContext = {
    idle: profile?.idle ?? null,
    pollMs: trace.header.pollMs ?? 1000,
    settleMs: profile?.edges?.settleMs,
    sources,
  };
  const events = profile?.edges?.events ?? {};
  const agent = trace.header.harness === "shell" ? undefined : trace.header.harness;
  let state = emptyFoldState();
  let seq = 0;
  const open: OpenReceipt[] = [];
  const receipts: Record<string, "open" | "effective"> = {};
  const results: TraceStepResult[] = [];
  const feed = (input: SurfaceInput): void => {
    state = stepFold(state, input, context);
  };
  const edge = (kind: EdgeKind, at: number): void => feed({ seq: ++seq, source: "edge", at, kind });

  trace.steps.forEach((step, index) => {
    if ("read" in step) {
      // A liar sends a closing edge just before every read: it must not free a screen that is not.
      if (options.mode === "lying") edge("stop", step.at - 1);
      const rows = rowsOf(step.read, options.fixture);
      const revision = index + 1;
      feed({ seq: ++seq, source: "screen", at: step.at, revision, rows, ask: liftAsk(readerBlocks(rows, agent), revision) });
    } else if ("edge" in step) {
      const written = edgeKindOf(events, step.edge.event, step.edge.detail ?? null);
      const kind = options.mode === "lying" ? invertEdge(written) : written;
      edge(kind, step.at);
      // A prompt edge closes a receipt only when the hook source takes part, and only as a prompt.
      if (options.mode !== "removed" && kind === "prompt" && step.edge.prompt !== undefined) {
        const closed = closingReceipt(open, TRACE_PANE, tracePromptHash(step.edge.prompt), step.at);
        if (closed !== null) {
          receipts[closed.id] = "effective";
          open.splice(open.indexOf(closed), 1);
        }
      }
    } else if ("tick" in step) {
      feed({ seq: ++seq, source: "tick", at: step.at });
    } else {
      const receipt: OpenReceipt = { id: step.send.id, paneId: TRACE_PANE, promptHash: tracePromptHash(step.send.text), at: step.at };
      open.push(step.send.queued === true ? { ...receipt, queued: true } : receipt);
      receipts[step.send.id] = "open";
    }
    const surface = readFold(state, context).surface;
    results.push({ index, surface, state, receipts: { ...receipts }, mismatches: check(step.expect, surface, state, receipts) });
  });
  return results;
}

/** The steps of a replay that read free. A negative trace must have none. */
export function freeSteps(results: readonly TraceStepResult[]): number[] {
  return results.filter((result) => isFree(result.surface)).map((result) => result.index);
}
