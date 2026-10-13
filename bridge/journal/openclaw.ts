// OpenClaw's journal adapter (issue #401).
//
// SHAPE OF THE SOURCE (verified on OpenClaw 2026.9.8 and 2026.10.2, schema 24, 2026-10-12):
//   <stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite        one database per agent, WAL
//   schema_meta(meta_key='primary').schema_version = 24
//   session_nodes(session_key → current_session_id)                 `agent:main:work` → a uuid
//   transcript_events(session_id, seq, event_json | event_zstd)     one pi session v4 row each
//   session_transcript_active_events(session_id, active_position, event_seq)   the current branch
// A row over about 1 KB may be stored zstd-compressed in `event_zstd` instead of `event_json`.
// `<stateDir>` is `$OPENCLAW_STATE_DIR`, or `~/.openclaw` when that is unset.
//
// HOW THE PANE NAMES ITS SESSION: not through Herdr. OpenClaw reports to Herdr with a source of
// its own, and Herdr keeps a session only from its own integrations, so the pane never carries an
// `agent_session`. The pane's folder says nothing either: an agent's workspace is shared by every
// session of that agent. What does name it is the TUI's footer, which OpenClaw draws on every frame:
//
//   agent main (main) | session work | <model> | … | deliver:off | tokens 21k/200k (11%)
//
// `agent <id> (<name>)` and `session <key without its agent:<id>: prefix> (<display name>)`, both
// parentheses optional (OpenClaw's own `formatTuiFooter`). So `discover` reads the pane's screen,
// takes the bottommost footer line, and builds `agent:<id>:<rest>`. The screen is the pane's own
// output and therefore a HINT: the agent id must be OpenClaw's own id shape before it becomes a path
// segment, the database must sit inside a configured root, and the key is only ever a bound SQL
// parameter looked up in that agent's `session_nodes`. A key the database does not hold is no log.
//
// WHAT IS NEVER READ. Only the agent database above is opened, and only read-only. Not the state
// database beside it (`<stateDir>/state/`), which holds the gateway's shared secret, not the config
// file, and not the gateway. openclaw.test.ts pins this.
//
// GRAMMAR. The rows are pi's session format, so the pi reducer reads them, behind a normaliser for
// the three places OpenClaw differs (see `normaliseRow`).

import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { type Cursor, decodeCursor, encodeCursor, NO_CURSOR, type ReadSince } from "./cursor.ts";
import { containedRealpath, FIRST_TAIL_BYTES, FIRST_TAIL_ROWS, MAX_TRANSCRIPT_BYTES, rootList } from "./files.ts";
import { createPiReducer } from "./pi.ts";
import {
  createUnknownCounter,
  NO_CHANGE,
  parseWith,
  type Reduction,
  type RowReducer,
  type UnknownTally,
} from "./reduce.ts";
import type { AgentSessionRef, JournalAdapter, PaneScreen, TranscriptEntry, TranscriptSource } from "./types.ts";

/**
 * The schema versions this reader was verified against. Anything else answers "no log", never a
 * read: versions 10 to 24 were each marked unreleased in OpenClaw's own docs, so the store moves fast
 * and a reader guessing at a newer layout would draw the wrong conversation.
 */
export const OPENCLAW_SCHEMA_VERSIONS: readonly number[] = [24];

/** OpenClaw's own agent id shape (`normalizeAgentId`), checked before it becomes a path segment. */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A session id as `session_nodes` stores it: a uuid today. Validated before it rides in a key. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The longest session key this reader will look up. Real keys are a few dozen characters. */
const SESSION_KEY_MAX = 512;

/** The file inside an agent's folder. Spelled once. */
const AGENT_DB = "openclaw-agent.sqlite";

// ── The footer ───────────────────────────────────────────────────────────────

/** What the footer says: the agent's id and the session's label as drawn (key rest, display name). */
export interface OpenclawFooter {
  agentId: string;
  sessionLabel: string;
}

/**
 * `agent <id>[ (<name>)] | session <label>[ | …]` on one line. The id is OpenClaw's shape; the label
 * runs to the next ` | ` or the end of the line. A truncated footer on a narrow pane still parses,
 * and its cut label simply names no session.
 */
const FOOTER_RE = /^agent ([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?: \([^|]*\))? \| session (.+?)(?: \| .*)?$/;

/**
 * The footer the pane shows, or null when no line of `screen` is one. The BOTTOMMOST match wins,
 * because the footer sits under the conversation and anything above it is the agent's output.
 */
export function parseOpenclawFooter(screen: string): OpenclawFooter | null {
  const lines = screen.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = FOOTER_RE.exec((lines[i] ?? "").trim());
    if (m === null) continue;
    const label = (m[2] ?? "").trim();
    if (label === "") continue;
    return { agentId: (m[1] ?? "").toLowerCase(), sessionLabel: label };
  }
  return null;
}

/** The session key a footer names: `agent:<id>:<label>`, with the label as drawn. */
export function footerSessionKey(footer: OpenclawFooter): string {
  return `agent:${footer.agentId}:${footer.sessionLabel}`;
}

/** A key split into the agent it belongs to and the keys to try in that agent's database. */
interface KeyLookup {
  agentId: string;
  candidates: string[];
}

/**
 * Read a ref's key back into an agent id and the keys to try, or null when it is not one this
 * reader will touch. The candidates cover what the footer cannot tell apart: a display name after
 * the key (`work (Planning)`), and a key OpenClaw drew whole because it has no `agent:` prefix.
 */
export function sessionKeyLookup(key: string): KeyLookup | null {
  if (key.length > SESSION_KEY_MAX || !key.startsWith("agent:")) return null;
  // No control characters anywhere: the key came off a terminal screen.
  for (const ch of key) if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) return null;
  const end = key.indexOf(":", 6);
  if (end === -1) return null;
  const agentId = key.slice(6, end);
  const rest = key.slice(end + 1);
  if (!AGENT_ID_RE.test(agentId) || rest.trim() === "") return null;
  const bare = rest.replace(/ \([^()]*\)$/, "");
  const candidates = [`agent:${agentId}:${rest}`, `agent:${agentId}:${bare}`, rest, bare];
  return { agentId, candidates: [...new Set(candidates)] };
}

// ── The database ─────────────────────────────────────────────────────────────

/** How the source opens a database. A seam so a test can see every path that is opened. */
export type OpenDatabase = (path: string) => Database;

const openReadOnly: OpenDatabase = (path) => new Database(path, { readonly: true });

/** `<dbPath>#<sessionId>`: what `resolve` answers and every other method takes. */
export function openclawKey(dbPath: string, sessionId: string): string {
  return `${dbPath}#${sessionId}`;
}

function splitKey(key: string): { dbPath: string; sessionId: string } | null {
  const at = key.lastIndexOf("#");
  if (at <= 0) return null;
  const sessionId = key.slice(at + 1);
  return SESSION_ID_RE.test(sessionId) ? { dbPath: key.slice(0, at), sessionId } : null;
}

/**
 * Run `fn` against a read-only open of `dbPath`, or answer null: the file will not open, the query
 * failed, or the schema is not one this reader knows. The schema is checked on EVERY open, not once,
 * because OpenClaw migrates the file in place when it updates under a running bridge.
 */
function withAgentDb<T>(open: OpenDatabase, dbPath: string, fn: (db: Database) => T): T | null {
  let db: Database;
  try {
    db = open(dbPath);
  } catch {
    return null;
  }
  try {
    const meta = db
      .query<{ schema_version: number }, []>("select schema_version from schema_meta where meta_key = 'primary'")
      .get();
    if (meta === null || !OPENCLAW_SCHEMA_VERSIONS.includes(meta.schema_version)) return null;
    return fn(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

interface EventRow {
  seq: number;
  event_json: string | null;
  event_zstd: Uint8Array | null;
}

/** One stored row as one line of JSON, or null when it cannot be decoded. */
function eventLine(row: EventRow): string | null {
  let text: string;
  try {
    text = row.event_json ?? (row.event_zstd === null ? "" : new TextDecoder().decode(Bun.zstdDecompressSync(row.event_zstd)));
  } catch {
    return null; // a blob that will not decompress is a row of no shape, skipped like a torn line
  }
  if (text === "") return null;
  // A line is a row, so a row must be one line. Stored JSON is compact; re-serialise it if not.
  if (!text.includes("\n")) return text;
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return null;
  }
}

function eventLines(rows: readonly EventRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const line = eventLine(row);
    if (line !== null) lines.push(line);
  }
  return lines;
}

/** The current branch, oldest first. The session header row is not on it, and pi skips it anyway. */
const ACTIVE_ROWS =
  "select e.seq, e.event_json, e.event_zstd from session_transcript_active_events a join transcript_events e on e.session_id = a.session_id and e.seq = a.event_seq where a.session_id = ?";

/** Index of the oldest line that still fits under `bytes`, counting from the newest back. */
function clipStart(lines: readonly string[], bytes: number): number {
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    total += Buffer.byteLength(lines[i] ?? "") + 1;
    if (total > bytes) return i + 1;
  }
  return 0;
}

/** The newest seq among some rows, or `fallback` when there were none. */
function newestSeq(rows: readonly EventRow[], fallback: number): number {
  let newest = fallback;
  for (const row of rows) if (row.seq > newest) newest = row.seq;
  return newest;
}

/**
 * Real SQLite source over one or more OpenClaw state folders.
 *
 * `resolve` runs on every poll, which is what follows a session that OpenClaw started afresh under
 * the same key (`/new`): `session_nodes` names a new session id, the key changes, and the live
 * window starts over rather than resuming a cursor into another session.
 */
export class OpenclawTranscriptSource implements TranscriptSource {
  private readonly roots: string[];

  constructor(
    roots: string | readonly string[],
    private readonly open: OpenDatabase = openReadOnly,
  ) {
    this.roots = rootList(roots);
  }

  /**
   * The first root whose agent database holds the key wins. Unlike a uuid, a session key is NOT
   * unique across state folders: two OpenClaw profiles on one machine both have `agent:main:main`,
   * and the footer does not say which profile drew it. One root is the default and the common case;
   * an operator who lists several reads the first one's session for a key both hold.
   */
  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id") return null;
    const lookup = sessionKeyLookup(ref.value);
    if (lookup === null) return null;
    for (const root of this.roots) {
      const path = await containedRealpath(join(root, "agents", lookup.agentId, "agent", AGENT_DB), root);
      if (path === null) continue;
      const sessionId = withAgentDb(this.open, path, (db) => {
        const query = db.query<{ current_session_id: string }, [string]>(
          "select current_session_id from session_nodes where session_key = ?",
        );
        for (const candidate of lookup.candidates) {
          const hit = query.get(candidate);
          if (hit !== null) return hit.current_session_id;
        }
        return null;
      });
      if (sessionId !== null && SESSION_ID_RE.test(sessionId)) return openclawKey(path, sessionId);
    }
    return null;
  }

  /**
   * The size is the branch's length and the clock is the newest write to the session, so any row
   * written, and any branch that grew or shrank, moves one of them.
   */
  async stat(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    const parts = splitKey(key);
    if (parts === null) return null;
    return withAgentDb(this.open, parts.dbPath, (db) => {
      const row = db
        .query<{ size: number; mtime: number }, [string, string]>(
          "select (select count(*) from session_transcript_active_events where session_id = ?) as size, (select coalesce(max(created_at), 0) from transcript_events where session_id = ?) as mtime",
        )
        .get(parts.sessionId, parts.sessionId);
      return row === null ? null : { size: row.size, mtimeMs: row.mtime };
    });
  }

  async load(key: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }> {
    const empty = { text: "", complete: true, size: 0, mtimeMs: 0 };
    const parts = splitKey(key);
    if (parts === null) return empty;
    const meta = await this.stat(key);
    const lines = withAgentDb(this.open, parts.dbPath, (db) =>
      eventLines(db.query<EventRow, [string]>(`${ACTIVE_ROWS} order by a.active_position`).all(parts.sessionId)),
    );
    if (lines === null || meta === null) return empty;
    const start = clipStart(lines, MAX_TRANSCRIPT_BYTES);
    return { text: lines.slice(start).join("\n"), complete: start === 0, ...meta };
  }

  /**
   * What is new on the branch since `cursor`, which counts `transcript_events.seq` (`rowid` storage:
   * an integer that only grows, never reused within a session).
   *
   * A REWIND NEEDS NOTHING HERE. Every row names its parent, and the pi reducer marks the turns that
   * left the branch when the next row arrives naming an older parent (pi.ts, "the branch chain"), so
   * an append-only read of the branch's new rows carries a rewind the same way pi's own file does.
   *
   * A branch index OpenClaw has marked for a rebuild is not read at all: the caller keeps what it has
   * and asks again, rather than drawing a branch that is about to change under it.
   */
  async readSince(key: string, cursor: Cursor): Promise<ReadSince> {
    const held: ReadSince = { lines: [], cursor, reset: false, fromStart: false };
    const parts = splitKey(key);
    if (parts === null) return { lines: [], cursor: NO_CURSOR, reset: false, fromStart: false };
    const at = decodeCursor(cursor, "rowid", key);
    return (
      withAgentDb(this.open, parts.dbPath, (db): ReadSince => {
        const index = db
          .query<{ needs_rebuild: number }, [string]>(
            "select needs_rebuild from session_transcript_index_state where session_id = ?",
          )
          .get(parts.sessionId);
        if (index !== null && index.needs_rebuild !== 0) return held;
        if (at !== null) {
          const rows = db
            .query<EventRow, [string, number, number]>(`${ACTIVE_ROWS} and e.seq > ? order by e.seq limit ?`)
            .all(parts.sessionId, at, FIRST_TAIL_ROWS);
          // Never clipped: dropping rows off the head of a delta while the cursor moved past them
          // loses a turn for good. The `limit` bounds it, and the rest comes on the next tick.
          return { lines: eventLines(rows), cursor: encodeCursor("rowid", key, newestSeq(rows, at)), reset: false, fromStart: false };
        }
        const rows = db
          .query<EventRow, [string, number]>(`${ACTIVE_ROWS} order by a.active_position desc limit ?`)
          .all(parts.sessionId, FIRST_TAIL_ROWS)
          .toReversed();
        const lines = eventLines(rows);
        const start = clipStart(lines, FIRST_TAIL_BYTES);
        return {
          lines: lines.slice(start),
          cursor: encodeCursor("rowid", key, newestSeq(rows, 0)),
          reset: true,
          fromStart: start === 0 && rows.length < FIRST_TAIL_ROWS,
        };
      }) ?? held
    );
  }
}

// ── The normaliser ───────────────────────────────────────────────────────────
//
// What OpenClaw writes that pi does not, each verified on both versions:
//
//  1. A META TOOL. OpenClaw offers the model a catalogue behind `tool_call {id, args}`, so a call to
//     `ask_user` is stored as a call to `tool_call` with `id: "ask_user"`. The call is renamed to the
//     tool it ran and given that tool's own input, and its result row is unwrapped from the
//     `{tool, result}` envelope the meta tool returns. That is how Chat shows `ask_user` by name, and
//     how its questions reach the question card.
//  2. A NESTED-TOOL ROW: `role: "custom"`, `customType: "openclaw.nested-tool.v1"`, the same inner
//     call seen from inside. Under a renamed meta call it says nothing the rename did not, so it
//     becomes a silent link; anywhere else it is drawn as the tool result it carries.
//  3. ANSWERS. `ask_user` records `{status, answers: {answers: {<question id>: [labels]}}}`. They are
//     turned into one list of labels per question, in the order the call asked them, which is what
//     a question card reads (`details.answers`, see pi.ts `enrichCall`).
//
// A row is NEVER dropped. pi's branch chain needs every row, because a row that draws nothing is still
// the parent of the next one, and a missing parent reads as a rewind that abandons the conversation.
// So a row with nothing to draw is rewritten into a `custom` row that keeps its id and parent.

/** The meta tool's name, as OpenClaw stores it. */
const META_TOOL = "tool_call";

/** The nested-tool row's custom type. */
const NESTED_TOOL = "openclaw.nested-tool.v1";

/** A tool name taken from a meta call's `id`: a catalogue id (`openclaw:core:ask_user`) or a name. */
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** How many meta calls a reducer remembers. Bounded like pi's own maps, oldest out first. */
const META_MAX = 4096;

function isObject(v: JsonValue | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

/** The tool a meta call ran, or null when its `id` is not a name this reader will show. */
function metaTarget(args: JsonValue | undefined): { name: string; input: JsonValue } | null {
  if (!isObject(args) || typeof args.id !== "string") return null;
  const name = args.id.split(":").at(-1) ?? "";
  if (!TOOL_NAME_RE.test(name)) return null;
  return { name, input: isObject(args.args) ? args.args : {} };
}

/** A question call's ids, in order, so its answers can be read back in the same order. */
function questionIds(input: JsonValue): string[] {
  if (!isObject(input) || !Array.isArray(input.questions)) return [];
  return input.questions.map((q) => (isObject(q) && typeof q.id === "string" ? q.id : ""));
}

/** One answer's labels: a list of strings, or a lone string. */
function answerLabels(v: JsonValue | undefined): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((l): l is string => typeof l === "string") : [];
}

/**
 * `{answers: {answers: {q1: ["Blue"]}}}` as `[["Blue"]]`, in the asked order where it is known, or
 * null when the details carry no answers of that shape.
 */
function answerLists(details: JsonObject, order: readonly string[]): string[][] | null {
  const outer = details.answers;
  const byId = isObject(outer) && isObject(outer.answers) ? outer.answers : null;
  if (byId === null) return null;
  const ids = order.length > 0 && order.every((id) => id !== "" && Object.hasOwn(byId, id)) ? order : Object.keys(byId);
  return ids.map((id) => answerLabels(byId[id]));
}

/** A row that draws nothing and keeps its place in the branch chain. */
function silent(row: JsonObject): JsonObject {
  const link: JsonObject = { type: "custom", customType: "openclaw.silent" };
  if (row.id !== undefined) link.id = row.id;
  if (row.parentId !== undefined) link.parentId = row.parentId;
  if (row.timestamp !== undefined) link.timestamp = row.timestamp;
  return link;
}

/** The text of a custom message, whose `content` is a string or text blocks. */
function hasText(content: JsonValue | undefined): boolean {
  if (typeof content === "string") return content.trim() !== "";
  return Array.isArray(content) && content.some((b) => isObject(b) && typeof b.text === "string" && b.text.trim() !== "");
}

/**
 * A fresh reader for ONE session: the normaliser above in front of a pi reducer.
 *
 * Stateful, like every reducer: it remembers which calls were meta calls (so their nested rows go
 * quiet) and each question call's ids (so its answers come back in order).
 */
export function createOpenclawReducer(): RowReducer {
  const pi = createPiReducer();
  const metaCalls = new Map<string, string[]>();
  // OpenClaw's own unknowns: a custom message type this reader has not met. pi's tally covers the rest.
  const unknown = createUnknownCounter({ rows: [], roles: [], parts: [] });

  const remember = (id: string, ids: string[]): void => {
    metaCalls.set(id, ids);
    if (metaCalls.size > META_MAX) {
      const oldest = metaCalls.keys().next().value;
      if (oldest !== undefined) metaCalls.delete(oldest);
    }
  };

  function assistant(row: JsonObject, m: JsonObject): JsonObject {
    if (!Array.isArray(m.content)) return row;
    let touched = false;
    const content = m.content.map((block) => {
      if (!isObject(block) || block.type !== "toolCall" || block.name !== META_TOOL) return block;
      const target = metaTarget(block.arguments);
      if (target === null) return block;
      touched = true;
      if (typeof block.id === "string") remember(block.id, questionIds(target.input));
      return { ...block, name: target.name, arguments: target.input };
    });
    return touched ? { ...row, message: { ...m, content } } : row;
  }

  function toolResult(row: JsonObject, m: JsonObject): JsonObject {
    let message = m;
    const details = m.details;
    // The meta tool's envelope: `{tool: {name}, result: {content, details}}`. An error result has no
    // `result` (the call never ran), so its own text, which says why, stays as it is.
    if (m.toolName === META_TOOL && isObject(details) && isObject(details.result) && Array.isArray(details.result.content)) {
      const unwrapped: JsonObject = { ...m, content: details.result.content };
      const tool = details.tool;
      if (isObject(tool) && typeof tool.name === "string" && TOOL_NAME_RE.test(tool.name)) unwrapped.toolName = tool.name;
      if (details.result.details !== undefined) unwrapped.details = details.result.details;
      else delete unwrapped.details;
      message = unwrapped;
    }
    const inner = message.details;
    if (isObject(inner)) {
      const order = typeof m.toolCallId === "string" ? (metaCalls.get(m.toolCallId) ?? []) : [];
      const answers = answerLists(inner, order);
      if (answers !== null) message = { ...message, details: { ...inner, answers } };
    }
    return message === m ? row : { ...row, message };
  }

  function custom(row: JsonObject, m: JsonObject): JsonObject {
    if (m.customType === NESTED_TOOL && isObject(m.details)) {
      const d = m.details;
      const underMeta =
        (typeof d.parentToolCallId === "string" && metaCalls.has(d.parentToolCallId)) ||
        (typeof d.toolCallId === "string" && d.toolCallId.startsWith(`${META_TOOL}:`));
      if (underMeta) return silent(row);
      const result = isObject(d.result) ? d.result : {};
      const drawn: JsonObject = {
        role: "toolResult",
        toolName: typeof d.toolName === "string" ? d.toolName : "tool",
        content: Array.isArray(result.content) ? result.content : [],
        isError: d.isError === true,
      };
      if (typeof d.toolCallId === "string") drawn.toolCallId = d.toolCallId;
      if (result.details !== undefined) drawn.details = result.details;
      return { ...row, message: drawn };
    }
    unknown.row(typeof m.customType === "string" ? `custom:${m.customType}` : "custom");
    if (m.display === true && hasText(m.content)) {
      const shown: JsonObject = { ...silent(row), type: "custom_message", display: true, content: m.content ?? "" };
      delete shown.customType;
      return shown;
    }
    return silent(row);
  }

  /** One OpenClaw row as the pi row that draws it. */
  function normaliseRow(row: JsonObject): JsonObject {
    if (row.type !== "message" || !isObject(row.message)) return row;
    const m = row.message;
    if (m.role === "assistant") return assistant(row, m);
    if (m.role === "toolResult") return toolResult(row, m);
    if (m.role === "custom") return custom(row, m);
    return row;
  }

  function push(line: string): Reduction {
    if (line.trim() === "") return NO_CHANGE;
    let parsed: JsonValue;
    try {
      // SAFETY: JSON.parse returns only JSON primitives, arrays, and objects; JsonValue names that exact boundary.
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      return NO_CHANGE;
    }
    if (!isObject(parsed)) return NO_CHANGE;
    const row = normaliseRow(parsed);
    return pi.push(row === parsed ? line : JSON.stringify(row));
  }

  function unknowns(): UnknownTally {
    const own = unknown.tally();
    const theirs = pi.unknowns();
    const rows = new Map(theirs.rows);
    for (const [name, n] of own.rows) rows.set(name, (rows.get(name) ?? 0) + n);
    return { rows, parts: theirs.parts };
  }

  return { push, unknowns, queued: pi.queued };
}

export function parseOpenclawTranscript(text: string): TranscriptEntry[] {
  return parseWith(createOpenclawReducer(), text);
}

/** Find the session from the pane's footer. The folder is no clue for OpenClaw (see the header). */
async function discoverFromFooter(screen: PaneScreen | undefined): Promise<AgentSessionRef | null> {
  if (screen === undefined) return null;
  const text = await screen();
  if (text === null) return null;
  const footer = parseOpenclawFooter(text);
  return footer === null ? null : { kind: "id", value: footerSessionKey(footer) };
}

/** OpenClaw's journal adapter. `agent` matches the agent name OpenClaw reports to Herdr. */
export function openclawJournal(roots: string | readonly string[], open?: OpenDatabase): JournalAdapter {
  return {
    agent: "openclaw",
    source: new OpenclawTranscriptSource(roots, open),
    parse: parseOpenclawTranscript,
    reducer: createOpenclawReducer,
    discover: (_cwd, hints) => discoverFromFooter(hints?.screen),
  };
}
