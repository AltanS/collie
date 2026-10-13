// The `durable` journal adapter: Chat and History for a program that has no screen and no log of
// its own that Collie can find. It reads the bridge-owned pane log (bridge/durable/log.ts), which the
// durable mux adapter fills from the program's events. It is an ordinary journal adapter: the same
// `TranscriptSource` seam, the same row reducer, the same byte-cursor live read as the harnesses that
// write a JSONL file. There is no second reader path.
//
// SHAPE OF THE SOURCE: `<stateDir>/durable/<base64url(paneId)>.jsonl`, one JSON row per line
// (`k` is `gen`, `item`, `ask`, `ask-closed`, `state` or `settled`; see the log's header). The ref is the
// pane's conversation id (`{ kind: "id" }`), which the durable mux adapter puts on every pane, so the
// ordinary session lookup in `paneChat` and `paneHistory` finds it. The id is never a path: it is
// checked against the wire's id rule, and the file name is derived from it by the log's own function.
//
// WHAT IS DRAWN, from the item kinds of WIRE.md section 4:
//   user       a user turn
//   reply      an assistant turn
//   thinking   an assistant turn with a thinking part
//   notice     a note (machine text that still belongs on screen)
//   tool       a tool part, with its status as the result: running has none, done has the output,
//              failed is an error, denied is a refusal (not an error)
//   settled    a short note, "stopped", for an input that ended `unanswered` with the reason
//              `aborted` (WIRE.md 7.5). Any other settled event draws nothing.
// An ITEM IS UPSERTED BY ID: a later row for a known id replaces the earlier one in place and is
// reported as `changed`, so History shows one turn per item and the live window updates it where it
// sits. Open asks are rows too, but this adapter does not draw them (a later spec draws ask cards),
// and a state row draws nothing.

import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { logFileName } from "../durable/log.ts";
import { isWireId } from "../mux/durable/clean.ts";
import { type Cursor, NO_CURSOR, type ReadSince } from "./cursor.ts";
import { containedRealpath, exists, loadTail, readSinceFile, rootList, statFile } from "./files.ts";
import {
  createUnknownCounter,
  type KnownTypes,
  NO_CHANGE,
  noQueue,
  parseWith,
  reduction,
  type Reduction,
  rememberPending,
  type RowReducer,
} from "./reduce.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine } from "./text.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** The agent name a durable pane reports. It keys this adapter in the registry. */
export const DURABLE_JOURNAL_AGENT = "durable";

/** The line a stop draws (WIRE.md 7.5). */
export const STOPPED_TEXT = "stopped";

/**
 * Every row kind this adapter has met. `ask`, `ask-closed` and `state` are known and drawn as nothing:
 * the drop is the decision (reduce.ts § "known means met and decided about").
 */
const DURABLE_KNOWN: KnownTypes = {
  rows: ["gen", "item", "ask", "ask-closed", "state", "settled"],
  roles: [],
  parts: [],
};

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** The tool part for one logged tool item. The status is the result, as for the other harnesses. */
function toolPartOf(id: string, tool: JsonObject, status: string): ToolPart {
  const name = textOf(tool.name) ?? "";
  const summary = oneLine(textOf(tool.summary) ?? "");
  const part: ToolPart = { kind: "tool", name, summary, id, call: { kind: "other", name, summary } };
  if (status === "running") return part;
  const output = clamp(textOf(tool.output) ?? "", MAX_RESULT_CHARS);
  if (status === "failed") part.result = { ...output, isError: true };
  else if (status === "denied") part.result = { ...output, denied: true };
  else part.result = output;
  return part;
}

/** One logged item as a turn, or null when it is not one this adapter can draw. */
function entryOf(item: JsonObject, at: string): TranscriptEntry | null {
  const id = textOf(item.id);
  const kind = textOf(item.kind);
  if (id === null || id === "" || kind === null) return null;
  const ts = textOf(item.ts) ?? at;
  if (kind === "tool") {
    const status = textOf(item.status);
    if (!isRecord(item.tool) || status === null) return null;
    return { uuid: id, ts, role: "assistant", parts: [toolPartOf(id, item.tool, status)] };
  }
  const text = textOf(item.text);
  if (text === null) return null;
  const body = clamp(text, MAX_TEXT_CHARS);
  switch (kind) {
    case "user":
      return { uuid: id, ts, role: "user", parts: [{ kind: "text", ...body }] };
    case "reply":
      return { uuid: id, ts, role: "assistant", parts: [{ kind: "text", ...body }] };
    case "thinking":
      return { uuid: id, ts, role: "assistant", parts: [{ kind: "thinking", ...body }] };
    case "notice":
      return { uuid: id, ts, role: "note", parts: [{ kind: "text", ...body }] };
    default:
      return null;
  }
}

/** Parse a pane log into turns, oldest first. PURE: no fs, no clock. */
export function parseDurableLog(text: string): TranscriptEntry[] {
  return parseWith(createDurableReducer(), text);
}

/**
 * The log, one row at a time (see reduce.ts).
 *
 * `held` is the turn each item id went out as. A later row for a known id MUTATES that turn and says
 * `changed`, the same way a tool result folds into its call, so `parse` yields one turn per item and
 * the live window updates it in place. The map is bounded by {@link rememberPending}: an item whose
 * latest version is more than that many distinct items old, and that is then changed again, is
 * emitted as a new turn, and the live window takes that as a re-emit of a uuid it holds.
 */
export function createDurableReducer(): RowReducer {
  const held = new Map<string, TranscriptEntry>();
  const unknown = createUnknownCounter(DURABLE_KNOWN);

  function push(line: string): Reduction {
    if (line.trim() === "") return NO_CHANGE;
    let parsed: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      return NO_CHANGE;
    }
    if (!isRecord(parsed)) return NO_CHANGE;
    unknown.row(parsed.k);
    const at = textOf(parsed.at) ?? "";

    if (parsed.k === "item" && isRecord(parsed.item)) {
      const entry = entryOf(parsed.item, at);
      if (entry === null) return NO_CHANGE;
      const known = held.get(entry.uuid);
      if (known === undefined) {
        rememberPending(held, entry.uuid, entry);
        return reduction([entry], new Set());
      }
      // The item changed. An item that sent no `ts` of its own keeps the moment it first appeared.
      known.role = entry.role;
      known.parts = entry.parts;
      if (textOf(parsed.item.ts) !== null) known.ts = entry.ts;
      return reduction([], new Set([entry.uuid]));
    }

    if (parsed.k === "settled" && parsed.status === "unanswered" && parsed.reason === "aborted") {
      const inputId = textOf(parsed.inputId);
      if (inputId === null || inputId === "") return NO_CHANGE;
      const uuid = `settled:${inputId}`;
      if (held.has(uuid)) return NO_CHANGE;
      const entry: TranscriptEntry = { uuid, ts: at, role: "note", parts: [{ kind: "text", text: STOPPED_TEXT }] };
      rememberPending(held, uuid, entry);
      return reduction([entry], new Set());
    }
    return NO_CHANGE;
  }

  return { push, unknowns: unknown.tally, queued: noQueue };
}

/** How many bytes of a log are read to find its header line. */
const HEADER_BYTES = 256;

/** The log's generation: the `id` of its header line, or `""` when it has none. */
async function generationOf(path: string): Promise<string> {
  const head = await Bun.file(path).slice(0, HEADER_BYTES).text();
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    const row = JSON.parse(head.split("\n", 1)[0] ?? "") as JsonValue;
    return isRecord(row) && row.k === "gen" && typeof row.id === "string" ? row.id : "";
  } catch {
    return "";
  }
}

/** The log files under the roots. A ref names one by the pane's conversation id. */
export class DurableTranscriptSource implements TranscriptSource {
  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isWireId(ref.value)) return null;
    for (const root of this.roots) {
      const candidate = join(root, logFileName(ref.value));
      if (!(await exists(candidate))) continue;
      const real = await containedRealpath(candidate, root);
      if (real !== null) return real;
    }
    return null;
  }

  stat = statFile;
  load = loadTail;

  /**
   * The live read, byte-counted like every harness that writes a JSONL file, with one addition: the
   * cursor also carries the log's generation. A rewrite (bridge/durable/log.ts) starts a new
   * generation, so a window that held a position from before it is answered with a reset and not
   * with the new file read from a position that is now somewhere else.
   */
  async readSince(key: string, cursor: Cursor): Promise<ReadSince> {
    const generation = await generationOf(key);
    const split = cursor.indexOf("|");
    const held = split === -1 ? null : { generation: cursor.slice(0, split), inner: cursor.slice(split + 1) };
    const read = await readSinceFile(key, held !== null && held.generation === generation ? held.inner : NO_CURSOR);
    return { ...read, cursor: `${generation}|${read.cursor}` };
  }
}

export function durableJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: DURABLE_JOURNAL_AGENT,
    source: new DurableTranscriptSource(roots),
    parse: parseDurableLog,
    reducer: createDurableReducer,
  };
}
