// WHAT THE ADAPTER SAYS TO ZELLIJ AND WHAT IT READS BACK — every argv it builds and every line it
// decodes, with no I/O of its own.
//
// Pure by construction, so `protocol.test.ts` pins the grammar with no binary present and the
// adapter above it stays a translation rather than a parser.
//
// ── THE ONE THING THAT SHAPES EVERY VERB BELOW ────────────────────────────────────────────────────
//
// **`zellij action …` is fire-and-forget: it exits 0 whether or not the target exists.** Probed on
// 0.44.2 — `dump-screen --pane-id terminal_999` printed nothing and exited 0; so did `write-chars`,
// `send-keys`, `close-tab-by-id 999` and `rename-tab-by-id 999`. Only two things report a failure at
// all: a session that is not running (`Session 'x' not found …`, exit 1) and the pane stream
// (`Pane terminal_999 not found`, exit 2).
//
// So an exit code can prove `unreachable`, and it can never prove `gone`. The adapter answers `gone`
// off its own listing instead ({@link parsePaneList}), which is why {@link ZELLIJ_LIST_PANES_ARGS}
// is on the write path and not only on the read path.
//
// ── WHY THE JSON FORM, ALWAYS ─────────────────────────────────────────────────────────────────────
//
// `list-panes` and `list-tabs` both print a human table by default and the machine form behind a
// flag. Parsing the table is how an adapter breaks on the next release, so every listing here asks
// for `--all --json` and nothing here ever reads a column.

import type { JsonObject, JsonValue } from "../../json.ts";

// ── The argv ──────────────────────────────────────────────────────────────────

/**
 * The session flag every `action` call carries.
 *
 * zellij's top-level `--session` selects which running session an action is delivered to, and the
 * ambient `ZELLIJ_SESSION_NAME` would otherwise decide it — which is exactly what a bridge started
 * from inside somebody's zellij pane must not inherit. Collie always says the name out loud.
 */
export function sessionArgs(session: string): string[] {
  return ["--session", session];
}

/** Every pane of the session, machine-readable: `action list-panes --all --json` (probed, M10/05). */
export const ZELLIJ_LIST_PANES_ARGS: readonly string[] = ["action", "list-panes", "--all", "--json"];

/** Every tab of the session, machine-readable — the same `--all --json` rule as the pane listing. */
export const ZELLIJ_LIST_TABS_ARGS: readonly string[] = ["action", "list-tabs", "--all", "--json"];

/**
 * Every session zellij knows about, one per line, formatting off.
 *
 * `--no-formatting` is what makes the line parseable at all: with it on, the name and the state are
 * wrapped in SGR escapes. `--short` would be tidier but it drops the very thing this listing exists
 * to read — whether the session is running or has exited ({@link parseSessionList}).
 */
export const ZELLIJ_LIST_SESSIONS_ARGS: readonly string[] = ["list-sessions", "--no-formatting"];

/**
 * One pane's screen. `dump-screen --ansi` keeps the SGR escapes; without `--ansi` zellij hands back
 * plain text, which is exactly what `styling:"strip"` asks for — the contract's request is a real
 * branch, not a field nobody reads. `--full` reaches behind the viewport into the pane's kept lines.
 */
export function dumpScreenArgs(paneId: string, preserveStyling: boolean, reachBehindViewport: boolean): string[] {
  const args = ["action", "dump-screen", "--pane-id", paneId];
  if (preserveStyling) args.push("--ansi");
  if (reachBehindViewport) args.push("--full");
  return args;
}

/**
 * Literal text into a pane, submitting nothing.
 *
 * `--` ends zellij's own flag parsing, so a message beginning with `-` is a message and not a flag
 * (probed: without it, `-n hello` was rejected as an unknown option).
 */
export function writeCharsArgs(paneId: string, text: string): string[] {
  return ["action", "write-chars", "--pane-id", paneId, "--", text];
}

/** Keys in zellij's own spelling, applied in order — one argument per keystroke (probed). */
export function sendKeysArgs(paneId: string, keys: readonly string[]): string[] {
  return ["action", "send-keys", "--pane-id", paneId, "--", ...keys];
}

/** Set a pane's name. An empty name restores whatever zellij called the pane before (probed). */
export function renamePaneArgs(paneId: string, label: string): string[] {
  return ["action", "rename-pane", "--pane-id", paneId, "--", label];
}

/** Close one pane, ending what runs in it. */
export function closePaneArgs(paneId: string): string[] {
  return ["action", "close-pane", "--pane-id", paneId];
}

/** A new tab, opening a fresh shell. zellij prints the new tab's stable id and nothing else. */
export function newTabArgs(label: string | undefined, cwd: string | undefined): string[] {
  const args = ["action", "new-tab"];
  if (label !== undefined) args.push("--name", label);
  if (cwd !== undefined) args.push("--cwd", cwd);
  return args;
}

/** Rename a tab by its stable id — not by position, which moves when a neighbour closes. */
export function renameTabArgs(tabNumber: number, label: string): string[] {
  return ["action", "rename-tab-by-id", "--", String(tabNumber), label];
}

/** Close a tab and every pane in it, by stable id. */
export function closeTabArgs(tabNumber: number): string[] {
  return ["action", "close-tab-by-id", "--", String(tabNumber)];
}

/**
 * The long-lived pane stream: `subscribe --ansi --format json --pane-id <id> …`, several ids at once.
 *
 * `--ansi` so a frame carries exactly what a `preserve` read of the same pane would, which is what
 * lets the watch compare like for like and fire only on a screen that really moved (watch.ts).
 */
export function subscribeArgs(paneIds: readonly string[]): string[] {
  const args = ["subscribe", "--ansi", "--format", "json"];
  for (const paneId of paneIds) args.push("--pane-id", paneId);
  return args;
}

// ── The pane id ───────────────────────────────────────────────────────────────

/** zellij's own namespace for a terminal pane. Plugin panes are `plugin_<n>` and are not Collie's. */
export const TERMINAL_PREFIX = "terminal_";

/** The Collie id for a zellij terminal pane. Carried through unchanged — identity rule 1. */
export function terminalPaneId(numericId: number): string {
  return `${TERMINAL_PREFIX}${String(numericId)}`;
}

/**
 * Collie's id for a zellij tab: its STABLE id, prefixed.
 *
 * The prefix is not decoration. zellij's `tab_id` is a bare integer and so is a pane's, so an
 * unprefixed tab id would read identically to a pane id in a log, a route parameter and a test —
 * and the two namespaces are unrelated. `terminal_1` and `tab_1` can never be confused.
 */
export const TAB_PREFIX = "tab_";

/** The Collie id for a zellij tab. */
export function tabId(tabNumber: number): string {
  return `${TAB_PREFIX}${String(tabNumber)}`;
}

/** The zellij tab number behind a Collie tab id, or null when it is not one of ours. */
export function tabNumberOf(id: string): number | null {
  if (!id.startsWith(TAB_PREFIX)) return null;
  const digits = id.slice(TAB_PREFIX.length);
  if (!/^\d+$/u.test(digits)) return null;
  return Number.parseInt(digits, 10);
}

// ── The listings ──────────────────────────────────────────────────────────────

/** One terminal pane, as zellij's listing describes it. Plugin panes never become one of these. */
export interface ZellijPaneRecord {
  readonly paneId: string;
  readonly focused: boolean;
  readonly exited: boolean;
  readonly title: string;
  readonly tabNumber: number;
  readonly tabPosition: number;
  readonly tabName: string;
  readonly contentRows: number;
  /**
   * `terminal_command` — what zellij was asked to run in this pane, or `""` when it reports none
   * (the listing carries `null` for a pane zellij did not start with an explicit command).
   *
   * NOT an identity: the adapter's header and ../types.ts § MuxPane.agent say why a process name may
   * never pick a harness grammar or a journal adapter. It travels as the raw fact it is.
   */
  readonly command: string;
}

/** Field separator inside one census row. A byte no zellij label can carry. */
const FIELD_SEP = "\u0000";

/**
 * A census fingerprint: everything about the herd's STRUCTURE, and nothing that moves on its own.
 *
 * Focus is deliberately out of it. `is_focused` changes every time the operator looks at another
 * pane on their desktop, and a topology callback for that is a snapshot re-read with nothing in it —
 * the same reason tmux's census reads names and ids rather than active flags.
 */
export function censusSignature(panes: readonly ZellijPaneRecord[]): string {
  return panes
    .map((pane) =>
      [
        pane.paneId,
        String(pane.tabNumber),
        String(pane.tabPosition),
        pane.tabName,
        pane.exited ? "1" : "0",
        pane.title,
      ].join(FIELD_SEP),
    )
    .join("\n");
}

/** One tab, as zellij's listing describes it. */
export interface ZellijTabRecord {
  readonly tabNumber: number;
  readonly position: number;
  readonly name: string;
  readonly active: boolean;
  readonly paneCount: number;
}

/** One session zellij knows about, and whether it is still running. */
export interface ZellijSessionRecord {
  readonly name: string;
  readonly running: boolean;
}

/**
 * The terminal panes of one `list-panes --all --json`, or null when the output was not a listing.
 *
 * PLUGIN PANES ARE DROPPED, and that is a decision rather than a filter for tidiness: `is_plugin`
 * panes are zellij's own furniture — the tab bar, the status bar, the "About" overlay — and the
 * probe found four of them around a single shell. They are not places an agent runs and nothing
 * Collie offers would mean anything pointed at one. Their ids also collide with terminal ids on the
 * bare number (`plugin_0` and `terminal_0` both existed in the probe), which is why the namespaced
 * spelling is what Collie carries.
 */
export function parsePaneList(stdout: string): ZellijPaneRecord[] | null {
  const rows = decodeRecordArray(stdout);
  if (rows === null) return null;
  const panes: ZellijPaneRecord[] = [];
  for (const row of rows) {
    if (readFlag(row, "is_plugin")) continue;
    const numericId = readInteger(row, "id");
    const tabNumber = readInteger(row, "tab_id");
    if (numericId === null || tabNumber === null) continue;
    panes.push({
      paneId: terminalPaneId(numericId),
      focused: readFlag(row, "is_focused"),
      exited: readFlag(row, "exited"),
      title: readText(row, "title") ?? "",
      tabNumber,
      tabPosition: readInteger(row, "tab_position") ?? 0,
      tabName: readText(row, "tab_name") ?? "",
      contentRows: readInteger(row, "pane_content_rows") ?? 0,
      command: readText(row, "terminal_command") ?? "",
    });
  }
  return panes;
}

/** The tabs of one `list-tabs --all --json`, or null when the output was not a listing. */
export function parseTabList(stdout: string): ZellijTabRecord[] | null {
  const rows = decodeRecordArray(stdout);
  if (rows === null) return null;
  const tabs: ZellijTabRecord[] = [];
  for (const row of rows) {
    const tabNumber = readInteger(row, "tab_id");
    if (tabNumber === null) continue;
    tabs.push({
      tabNumber,
      position: readInteger(row, "position") ?? 0,
      name: readText(row, "name") ?? "",
      active: readFlag(row, "active"),
      paneCount:
        (readInteger(row, "selectable_tiled_panes_count") ?? 0) +
        (readInteger(row, "selectable_floating_panes_count") ?? 0),
    });
  }
  return tabs;
}

/**
 * What zellij's session listing says, one record per line.
 *
 * The line is `<name> [Created … ago]` for a running session and carries `(EXITED` for one that has
 * stopped but could be resurrected by an `attach`. The marker is the only thing separating them and
 * it is what {@link chooseSession} refuses on — an exited session is not a place Collie can read or
 * type, and `action` against one answers "not found" anyway (probed).
 */
export function parseSessionList(stdout: string): ZellijSessionRecord[] {
  const sessions: ZellijSessionRecord[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const name = line.split(/\s/u)[0] ?? "";
    if (name.length === 0) continue;
    sessions.push({ name, running: !line.includes("(EXITED") });
  }
  return sessions;
}

/** Which session an adapter instance is bound to, or why it cannot decide. */
export type ZellijSessionChoice =
  | { readonly ok: true; readonly session: string }
  | { readonly ok: false; readonly detail: string };

/**
 * The one session this collie drives.
 *
 * `configured` is `COLLIE_MUX_ENDPOINT_ZELLIJ`. When the operator named one, that name must be
 * RUNNING — an exited session is refused by name rather than silently replaced by a neighbour, so a
 * collie pointed at "work" never quietly starts driving "scratch".
 *
 * When they named none, the documented default is **the single running session**, and ambiguity is
 * refused rather than guessed: with two running sessions there is no honest way to pick, and the
 * refusal names them so the operator can set the key. This is also why zero sessions is a refusal
 * and not an empty herd — "nothing to show" and "I do not know where to look" are different answers.
 */
export function chooseSession(sessions: readonly ZellijSessionRecord[], configured: string): ZellijSessionChoice {
  const named = configured.trim();
  const running = sessions.filter((session) => session.running);
  if (named.length > 0) {
    if (running.some((session) => session.name === named)) return { ok: true, session: named };
    const known = sessions.some((session) => session.name === named);
    return {
      ok: false,
      detail: known
        ? `the zellij session "${named}" has exited — attach to it once to bring it back, and Collie will follow`
        : `no running zellij session called "${named}"${describe(running)}`,
    };
  }
  if (running.length === 1) return { ok: true, session: running[0]?.name ?? "" };
  return {
    ok: false,
    detail:
      running.length === 0
        ? "no zellij session is running on this box"
        : `${String(running.length)} zellij sessions are running, so there is no single one to drive${describe(running)} — name one in COLLIE_MUX_ENDPOINT_ZELLIJ`,
  };
}

function describe(running: readonly ZellijSessionRecord[]): string {
  return running.length === 0 ? "" : ` — running: ${running.map((session) => session.name).join(", ")}`;
}

// ── The pane stream ───────────────────────────────────────────────────────────

/** One frame of `subscribe --format json`, decoded. Anything else on the stream is ignored. */
export type ZellijStreamEvent =
  | { readonly kind: "update"; readonly paneId: string; readonly text: string }
  | { readonly kind: "closed"; readonly paneId: string };

/**
 * One line of the pane stream, or null when it is not a frame this adapter acts on.
 *
 * The framing was probed on 0.44.2 and it is newline-delimited JSON, one object per line:
 * `{"event":"pane_update","is_initial":true,"pane_id":"terminal_2","scrollback":null,"viewport":[…]}`
 * and, when a followed pane goes away, `{"event":"pane_closed","pane_id":"terminal_3"}` — after
 * which the process exits once nothing is left to follow.
 *
 * `pane_closed` is the one topology fact zellij's CLI does announce, and the watch uses it: a pane
 * Collie is looking at disappearing is exactly the change an operator notices soonest.
 */
export function parseStreamEvent(line: string): ZellijStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const frame = decodeRecord(trimmed);
  if (frame === null) return null;
  const paneId = readText(frame, "pane_id");
  if (paneId === null || paneId.length === 0) return null;
  const event = readText(frame, "event");
  if (event === "pane_closed") return { kind: "closed", paneId };
  if (event !== "pane_update") return null;
  return { kind: "update", paneId, text: readLines(frame, "viewport").join("\n") };
}

// ── Refusals ──────────────────────────────────────────────────────────────────

/** Whether zellij said the session itself is not there — the one failure an exit code does prove. */
export function saysNoSession(text: string): boolean {
  return /not found\.?\s*(the following sessions|$)/iu.test(text) || text.includes("No active zellij sessions");
}

/** Whether the pane stream refused because the pane does not exist. */
export function saysNoPane(text: string): boolean {
  return /^Pane\s+\S+\s+not found/mu.test(text);
}

// ── Decoding ──────────────────────────────────────────────────────────────────
//
// `typeof` is the parse here, exactly as it is in the Herdr client's wire decoder, and this file is
// scoped in `.oxlintrc.json` for that reason: zellij's JSON is a third-party format that drifts
// between releases, so every field is read defensively and a record that cannot answer is skipped
// rather than trusted.

/** One JSON array of objects, or null when the text was not one. */
function decodeRecordArray(stdout: string): JsonObject[] | null {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed)) return null;
  const rows: JsonObject[] = [];
  for (const entry of parsed) {
    const row = asObject(entry);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** One JSON object, or null when the text was not one. */
function decodeRecord(text: string): JsonObject | null {
  return asObject(parseJson(text));
}

/** `JSON.parse`, with a document that is not JSON at all decoded as `null`. */
function parseJson(text: string): JsonValue {
  try {
    // SAFETY: `JSON.parse` returns exactly a JsonValue by construction — string, number, boolean,
    // null, or an array/object of those. TS types it `any`; this names what it already is, which is
    // what lets every field read below stay checked instead of re-asserted (bridge/wire.ts does the
    // same at the Herdr wire).
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

/** The value as a JSON object, or null. An array is `typeof "object"` and is not one. */
function asObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function readText(row: JsonObject, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function readInteger(row: JsonObject, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readFlag(row: JsonObject, key: string): boolean {
  return row[key] === true;
}

/** A JSON array of strings, dropping anything in it that is not one. */
function readLines(row: JsonObject, key: string): string[] {
  const value = row[key];
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") lines.push(entry);
  }
  return lines;
}
