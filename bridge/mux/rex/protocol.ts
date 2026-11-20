// Wire formats, parsers and error classifiers for Rex (Superlogical's terminal multiplexer).
//
// Everything here is the text the `rex` CLI prints, read into the few fields the adapter uses. Every
// shape below was read off a live server (rex 0.0.1795019727, API revision 18, Linux) on 2026-11-19
// — MUX_CONTRACT.md, source **RX**. Rex is in beta and says its commands may change, so each reader
// takes only what it needs, checks it, and drops anything it does not recognise instead of throwing.

import type { JsonObject, JsonValue } from "../../json.ts";
import { NO_BINARY_CODE, TIMED_OUT_CODE } from "./exec.ts";

/** One session from `rex ls --json --short=false`. */
export interface RexSession {
  readonly sessionId: string;
  readonly label: string;
}

/** One terminal block, as `rex window ls -s <session> --json` places it in a window. */
export interface RexBlock {
  readonly blockId: string;
  readonly label: string;
  /** `com.superlogical.terminal` for a terminal. Only a terminal has a screen to read. */
  readonly creator: string;
}

/** One window — Collie's tab. */
export interface RexWindow {
  readonly windowId: string;
  readonly label: string;
  readonly focusedBlockId: string | null;
  /** Every block of every layer, tiled first, in the order the server listed them. */
  readonly blocks: readonly RexBlock[];
}

/** One session's view: its windows and which one is active. */
export interface RexView {
  readonly sessionId: string;
  readonly label: string;
  readonly activeWindowId: string | null;
  readonly windows: readonly RexWindow[];
}

/** What `rex block call -b <id> process` says about the block's program. */
export interface RexProcess {
  /** The foreground process's name (`zsh`, `claude`), when a child is running. */
  readonly foreground: string | null;
  /** The foreground process's working directory, else the child's. Empty when neither is known. */
  readonly cwd: string;
  /** False once the block's program has exited and only its screen is left (`--keep-open`). */
  readonly alive: boolean;
  /**
   * The pid of the block's own login shell, when its program is one: a child whose `argv0` starts
   * with `-`, which is how a login shell is started (Rex starts the default shell that way). Null for a
   * block that runs a program of its own, and once the program exited.
   */
  readonly loginShellPid: number | null;
}

/** One status record a program reported with OSC 7501 (`program_status`). */
export interface RexStatusRecord {
  /** `idle`, `working`, `done`, `blocked` or `error`, as reported. */
  readonly state: string;
  /** The program's name for itself: `claude-code`, `codex`, … Empty when none in the chain says. */
  readonly app: string;
  /** The record's id; empty for the root record. */
  readonly id: string;
  /** The pid of the process that wrote the record; Rex drops a record once that process exits. */
  readonly ownerPid: number | null;
}

/** The creator of a terminal block, the only kind of block this adapter maps to a pane. */
export const REX_TERMINAL_CREATOR = "com.superlogical.terminal";

// ── small readers ───────────────────────────────────────────────────────────────────────────────

// `typeof` is the parse here, as in the zellij and Tern protocol modules, and this file is scoped in
// `.oxlintrc.json` for that reason: rex's JSON is a beta's format, so every field is read defensively
// and a record that cannot answer is skipped rather than trusted.

/** The value as a JSON object, or null. An array is `typeof "object"` and is not one. */
function asObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** A field as text, or `""` when it is absent or not a string. */
function str(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/** A field as a process id, or null when it is absent or not a positive whole number. */
function pid(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** A field as an array, or `[]`. */
function list(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** `JSON.parse` of one CLI answer, which must be an object. */
function parseObject(stdout: string, what: string): JsonObject {
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` returns exactly a JsonValue by construction — string, number, boolean,
    // null, or an array/object of those. TS types it `any`; this names what it already is, so every
    // field read below stays checked instead of re-asserted (zellij/protocol.ts does the same).
    parsed = JSON.parse(stdout) as JsonValue;
  } catch {
    throw new Error(`unreadable output from ${what}`);
  }
  const object = asObject(parsed);
  if (object === null) throw new Error(`unexpected response from ${what}`);
  return object;
}

// ── parsers ─────────────────────────────────────────────────────────────────────────────────────

/** `rex ls --json --short=false`: `{ sessions: [{ session_id, label }] }`. */
export function parseSessions(stdout: string): RexSession[] {
  const parsed = parseObject(stdout, "rex ls --json");
  if (!Array.isArray(parsed.sessions)) throw new Error("unexpected response from rex ls --json: missing sessions array");
  const sessions: RexSession[] = [];
  for (const entry of parsed.sessions) {
    const raw = asObject(entry);
    if (raw === null) continue;
    const sessionId = str(raw.session_id);
    if (sessionId === "") continue;
    sessions.push({ sessionId, label: str(raw.label) || sessionId });
  }
  return sessions;
}

/**
 * `rex window ls -s <session> --json`: the session's view. Each window holds layers (one `tiled`,
 * any number floating), and each layer lists its blocks.
 */
export function parseView(stdout: string): RexView {
  const parsed = parseObject(stdout, "rex window ls --json");
  if (!Array.isArray(parsed.windows)) throw new Error("unexpected response from rex window ls --json: missing windows array");
  const windows: RexWindow[] = [];
  for (const entry of parsed.windows) {
    const raw = asObject(entry);
    if (raw === null) continue;
    const windowId = str(raw.window_id);
    if (windowId === "") continue;
    const blocks: RexBlock[] = [];
    const layers = list(raw.layers).flatMap((layer) => {
      const object = asObject(layer);
      return object === null ? [] : [object];
    });
    // The tiled layer first, so a window's first pane is the one its layout holds.
    const ordered = [...layers.filter((l) => l.kind === "tiled"), ...layers.filter((l) => l.kind !== "tiled")];
    for (const layer of ordered) {
      for (const blockEntry of list(layer.blocks)) {
        const block = asObject(blockEntry);
        if (block === null) continue;
        const blockId = str(block.block_id);
        if (blockId === "") continue;
        blocks.push({ blockId, label: str(block.label), creator: str(block.creator_name) });
      }
    }
    windows.push({ windowId, label: str(raw.label), focusedBlockId: str(raw.focused_block_id) || null, blocks });
  }
  return {
    sessionId: str(parsed.session_id),
    label: str(parsed.label),
    activeWindowId: str(parsed.active_window_id) || null,
    windows,
  };
}

/**
 * `rex client ls -s <session> --json`: how many clients that show the session to a person are attached.
 *
 * Command-line clients do not count. Rex's help says `--json` is "the server's full reply, including
 * command line clients", and probed on API revision 19 a `rex window ls -s <session>` running beside
 * the listing was one of them (`info.kind: "cli"`) in 6 of 20 tries, so the adapter's own calls, and
 * any `rex events -s` (attached for as long as it streams), made a headless pane read as focused.
 */
export function parseClientCount(stdout: string): number {
  const parsed = parseObject(stdout, "rex client ls --json");
  return list(parsed.clients).filter((entry) => {
    const client = asObject(entry);
    return client !== null && str(asObject(client.info)?.kind) !== "cli";
  }).length;
}

/**
 * `rex block call -b <id> process`. Probed: a running block answers `last_exit: null` with a `child`
 * and a `foreground`; one whose program exited under `--keep-open` answers `last_exit: {exit_code}`
 * and no child.
 */
export function parseProcess(stdout: string): RexProcess {
  const parsed = parseObject(stdout, "rex block call process");
  const foreground = asObject(parsed.foreground);
  const child = asObject(parsed.child);
  const exited = asObject(parsed.last_exit) !== null;
  return {
    foreground: foreground ? str(foreground.name) || null : null,
    cwd: str(foreground?.cwd) || str(child?.cwd),
    alive: !exited && child !== null,
    loginShellPid: !exited && child !== null && str(child.argv0).startsWith("-") ? pid(child.pid) : null,
  };
}

/**
 * The longest `state` a status record may carry (the protocol's states are words like `working`), and
 * the longest `app` or record `id` (the protocol caps an id at 32 bytes). `kind` and `msg` are never
 * read: no card text comes from a record, only from the screen.
 */
export const STATUS_STATE_CAP = 16;
export const STATUS_FIELD_CAP = 64;

/** `rex block call -b <id> program_status`: `{ records: [{ state, app, effective_app, id, … }] }`. */
export function parseProgramStatus(stdout: string): RexStatusRecord[] {
  const parsed = parseObject(stdout, "rex block call program_status");
  const records: RexStatusRecord[] = [];
  for (const entry of list(parsed.records)) {
    const raw = asObject(entry);
    if (raw === null) continue;
    const state = str(raw.state);
    const app = str(raw.effective_app) || str(raw.app);
    const id = str(raw.id);
    if (state === "") continue;
    // The record is what the program in the block says about itself, so its fields are bounded
    // before use: a record with a field past the cap is not a report this adapter reads.
    if (state.length > STATUS_STATE_CAP || app.length > STATUS_FIELD_CAP || id.length > STATUS_FIELD_CAP) continue;
    records.push({ state, app, id, ownerPid: pid(asObject(raw.owner)?.pid) });
  }
  return records;
}

/** `rex block call -b <id> title`: `{ title, owner }`. */
export function parseTitle(stdout: string): string {
  return str(parseObject(stdout, "rex block call title").title);
}

/** `rex block call -b <id> size`: the terminal's rows, or null when it did not say. */
export function parseRows(stdout: string): number | null {
  const rows = parseObject(stdout, "rex block call size").rows;
  return typeof rows === "number" && Number.isInteger(rows) && rows >= 1 ? rows : null;
}

/** `rex block call format` with `max_bytes`: the first part, the byte `total`, and an `id` when more remains. */
export interface RexFormatted {
  readonly content: string;
  /** Set only when the output did not fit; `blob_read` reads the rest by it. */
  readonly id: number | null;
  readonly total: number;
}

/**
 * `rex block call -b <id> format '{"format":"vt","max_bytes":n}'`. Probed on API revision 19: the
 * reply holds `content` (the START of the output, cut once its JSON string reaches `max_bytes`),
 * `total` (the whole output in bytes) and, only when more remains, an `id` for `blob_read`.
 */
export function parseFormatted(stdout: string): RexFormatted {
  const parsed = parseObject(stdout, "rex block call format");
  if (typeof parsed.content !== "string") throw new Error("unexpected response from rex block call format: missing content");
  const id = typeof parsed.id === "number" && Number.isInteger(parsed.id) ? parsed.id : null;
  const total = typeof parsed.total === "number" && Number.isInteger(parsed.total) ? parsed.total : null;
  if (id !== null && total === null) throw new Error("unexpected response from rex block call format: an id with no total");
  return { content: parsed.content, id, total: total ?? 0 };
}

/** `rex block call blob_read`: the text from the asked offset, and whether it reaches the end. */
export interface RexBlobPart {
  readonly data: string;
  readonly eof: boolean;
}

/**
 * `rex block call -b <id> blob_read '{"id":n,"offset":o}'`. Probed: `data` never ends inside a
 * character, but an `offset` inside one reads as U+FFFD, so a reader drops the part row at the start.
 */
export function parseBlobPart(stdout: string): RexBlobPart {
  const parsed = parseObject(stdout, "rex block call blob_read");
  if (typeof parsed.data !== "string") throw new Error("unexpected response from rex block call blob_read: missing data");
  return { data: parsed.data, eof: parsed.eof === true };
}

/**
 * The Rex API revisions this adapter was probed on (MUX_CONTRACT.md, source RX): 18 on rex
 * 0.0.1795019727 and 19 on rex 0.0.1795116584, both on a Linux server. The author's earlier macOS
 * probes were on revision 11, before the adapter took its present shape. A server on another
 * revision is still driven; the bridge names it once in its log, and `collie doctor` names it too.
 */
export const REX_TESTED_API_REVISIONS: readonly number[] = [18, 19];

/** `api_revision` in `rex api call server.status`, or null when the answer names none. */
export function parseApiRevision(stdout: string): number | null {
  let parsed: JsonObject;
  try {
    parsed = parseObject(stdout, "rex api call server.status");
  } catch {
    return null;
  }
  const revision = parsed.api_revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : null;
}

/** The one sentence for a revision this adapter was not probed on, or null for a tested one. */
export function untestedRevisionNote(revision: number): string | null {
  if (REX_TESTED_API_REVISIONS.includes(revision)) return null;
  return `Rex API revision ${String(revision)} was not tested with Collie (tested: ${REX_TESTED_API_REVISIONS.join(", ")})`;
}

/**
 * The primary listener's address in `rex api call server.status`, or null when it names none.
 * Probed: `listeners: [{ endpoint: "unix:///run/user/1000/rex/server.sock", primary: true }, …]`.
 */
export function primaryListener(stdout: string): string | null {
  let parsed: JsonObject;
  try {
    parsed = parseObject(stdout, "rex api call server.status");
  } catch {
    return null;
  }
  for (const entry of list(parsed.listeners)) {
    const listener = asObject(entry);
    if (listener === null || listener.primary !== true) continue;
    const endpoint = str(listener.endpoint).trim();
    if (endpoint !== "") return endpoint;
  }
  return null;
}

/** The ids a create answered with: `rex new --json` and `rex window new --json`. */
export interface RexCreated {
  readonly sessionId: string | null;
  readonly windowId: string | null;
  readonly blockId: string | null;
}

/**
 * `rex new --json` answers `{ session_id, initial_windows: [{ window_id, block_ids }] }`, and
 * `rex window new --json` answers `{ window_id, block_ids }`.
 */
export function parseCreated(stdout: string): RexCreated {
  const parsed = parseObject(stdout, "a rex create");
  const first = asObject(list(parsed.initial_windows)[0]) ?? parsed;
  return {
    sessionId: str(parsed.session_id) || null,
    windowId: str(first.window_id) || null,
    blockId: str(list(first.block_ids)[0]) || null,
  };
}

/** The events of `rex events --all --json` the watch acts on. */
export type RexEvent =
  | { readonly kind: "topology" }
  | { readonly kind: "pane"; readonly blockId: string }
  | { readonly kind: "ignored" };

/** Session-scoped event types that change the herd's shape or names. */
const TOPOLOGY_SESSION_EVENTS = new Set([
  "block_created",
  "block_closed",
  "window_created",
  "window_closed",
  "window_label_changed",
  "active_window_changed",
  "session_label_changed",
  "session_view_changed",
]);

/** Block events that change what a pane reports: its agent's status, its title, its folder, its process. */
const PANE_BLOCK_EVENTS = new Set([
  "program_status_changed",
  "program_status_removed",
  "title_changed",
  "pwd_changed",
  "process_changed",
  "child_exited",
]);

/**
 * One line of `rex events --all --json`. Probed: server events are `session_created` and
 * `session_destroyed`; a session's own arrive wrapped as `session_event` with the inner `type`, and
 * a block's custom events wrapped once more as `block_event` with a `name`. `client_*` events are
 * CLI connections — every `rex` call makes two — and are not topology.
 */
export function parseEvent(line: string): RexEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: JsonObject;
  try {
    parsed = parseObject(trimmed, "rex events");
  } catch {
    return null;
  }
  const type = str(parsed.type);
  if (type === "session_created" || type === "session_destroyed") return { kind: "topology" };
  const inner = type === "session_event" ? asObject(asObject(parsed.payload)?.event) : null;
  if (inner === null) return { kind: "ignored" };
  const innerType = str(inner.type);
  if (TOPOLOGY_SESSION_EVENTS.has(innerType)) return { kind: "topology" };
  const block = innerType === "block_event" ? asObject(inner.payload) : null;
  if (block !== null) {
    const blockId = str(block.block_id);
    if (blockId !== "" && PANE_BLOCK_EVENTS.has(str(block.name))) return { kind: "pane", blockId };
  }
  return { kind: "ignored" };
}

// ── what a window's label means ─────────────────────────────────────────────────────────────────

/**
 * Whether a window label is rex's own default rather than a name somebody gave it. Probed: an unnamed
 * window is labelled `Window <the last 8 hex digits of its id>`, and `rex window new NAME` keeps NAME.
 */
export function isDefaultWindowLabel(windowId: string, label: string): boolean {
  return label === "" || label === `Window ${windowId.slice(-8)}`;
}

// ── screen text ─────────────────────────────────────────────────────────────────────────────────

// ESC and BEL are spliced in from their code points rather than written as escapes in a literal:
// matching a control character IS the point here (journal/text.ts does the same).
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

/**
 * An SGR sequence: colour and weight, the only escapes the contract lets through (ADR 0008). Bounded:
 * a real one is a few dozen characters, and a longer one is dropped like any other escape.
 */
const SGR = new RegExp(`^${ESC}\\[[0-9;:]{0,256}m$`, "u");

/**
 * Every escape sequence the VT capture can carry: CSI, OSC (BEL- or ST-terminated), and the
 * two-character forms. Bounded, so the pattern is linear.
 */
const ANY_ESCAPE = new RegExp(
  `${ESC}(?:\\[[0-9;:?<=>]*[ -/]*[@-~]|\\][^${BEL}${ESC}]{0,4096}(?:${BEL}|${ESC}\\\\)|[ -/]?[0-~])`,
  "gu",
);

/**
 * The 8-bit forms, C1 CSI (0x9b) and C1 OSC (0x9d, ended by BEL, 0x9c or ESC \\). Rex's VT capture never
 * wrote one in any probe, but a byte a filter does not know must not reach the phone as text.
 */
const C1_ESCAPE = new RegExp(
  `${String.fromCodePoint(0x9b)}[0-9;:?<=>]*[ -/]*[@-~]|${String.fromCodePoint(0x9d)}[^${BEL}${String.fromCodePoint(0x9c)}${ESC}]{0,4096}(?:${BEL}|${String.fromCodePoint(0x9c)}|${ESC}\\\\)?`,
  "gu",
);

/**
 * Every control byte left once the escapes are gone: C0 but tab, newline and ESC, DEL and C1. A
 * rendered row holds none, so none may pass (a NUL, a BEL or a backspace in a text node would still
 * reach a grammar, a copy and a screen reader).
 */
const STRAY_CONTROL = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(8)}${String.fromCodePoint(0x0b)}-${String.fromCodePoint(0x1a)}${String.fromCodePoint(0x1c)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}]`,
  "gu",
);

/** An ESC that does not open a kept SGR, such as one cut off at the end of the text. */
const LONE_ESC = new RegExp(`${ESC}(?!\\[[0-9;:]{0,256}m)`, "gu");

/** Cursor forward, `ESC [ n C`: how the VT capture writes a run of blank cells inside a row. */
const CURSOR_FORWARD = new RegExp(`${ESC}\\[([0-9]{0,4})C`, "gu");

/**
 * The widest run of blanks one cursor-forward may stand for: past any real terminal's width. The
 * pattern above takes four digits at most, and a longer count is dropped as an unknown escape, so no
 * count can make the filter allocate more than this many spaces.
 */
const MAX_BLANK_RUN = 1000;

/**
 * Rex's `--format=vt` as the contract's grid text: rows separated by `\n`, colour kept, everything
 * else gone (ADR 0008).
 *
 * Probed on a block running Claude Code: the capture writes each row with `\r\n`, writes a run of
 * blank cells as `ESC [ n C` (69 of them on one screen), and carries OSC 8 hyperlinks. No other
 * sequence appeared. So a cursor-forward becomes that many spaces — the blank cells it skips, on the
 * same row, which is a rendering and not an emulator — the `\r` goes, and every other escape but SGR
 * is dropped. A mirror that passed an unknown escape through would be relying on a beta's defaults,
 * so the filter is the adapter's own.
 */
export function keepSgrOnly(text: string): string {
  return text
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "")
    .replace(CURSOR_FORWARD, (_seq, count: string) => " ".repeat(Math.min(MAX_BLANK_RUN, Math.max(1, Number(count) || 1))))
    .replace(ANY_ESCAPE, (seq) => (SGR.test(seq) ? seq : ""))
    .replace(C1_ESCAPE, "")
    .replace(LONE_ESC, "")
    .replace(STRAY_CONTROL, "");
}

/** Every escape gone — what `styling: "strip"` asks for. Run on {@link keepSgrOnly}'s output. */
export function stripEscapes(text: string): string {
  return text.replace(ANY_ESCAPE, "");
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────────

/** Rex's own exit code for a target that does not exist (`block target "…" not found`). Probed. */
export const REX_NOT_FOUND_CODE = 3;
/** Rex's own exit code for no server at the address (`no Rex server is running at …`). Probed. */
export const REX_NO_SERVER_CODE = 4;

export function saysNotFound(code: number, stderr: string): boolean {
  if (code === REX_NOT_FOUND_CODE) return true;
  return /\b(block|window|session) target "[^"]*" not found\b/iu.test(stderr) || /\bsession_not_found\b/u.test(stderr);
}

export function saysNoServer(code: number, stderr: string): boolean {
  if (code === REX_NO_SERVER_CODE) return true;
  const s = stderr.toLowerCase();
  return s.includes("no rex server is running") || s.includes("rex server is not running") || s.includes("connection refused");
}

/**
 * Whether a finished call says rex could not be asked at all: no binary, no server, or a call killed
 * on its budget. These are `unreachable` to the contract; an ordinary non-zero exit is the server
 * answering "no".
 */
export function saysUnreachable(code: number, stderr: string): boolean {
  return code === NO_BINARY_CODE || code === TIMED_OUT_CODE || saysNoServer(code, stderr);
}
