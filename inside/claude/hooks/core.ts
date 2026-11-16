// The Collie mod's pure half (M99 spec 02): every rule the mod follows that needs no engine call.
//
// This file imports nothing, so the engine loads it beside `register.ts`, and Collie's own test runner
// (`bun test inside/claude/`) checks it with no engine at all. `register.ts` is the glue: it reads the
// engine, calls these functions and talks to the bridge.
//
// The wire is Collie's inside wire, version 1 (`bridge/inside/WIRE.md` in the Collie repository). The
// rules here mirror that contract; Collie's tests hold the two together.

/** The wire version this part speaks. */
export const WIRE_VERSION = 1;
/** How this part names its program on the wire. An open word: the bridge only logs it. */
export const HARNESS = "claude";
/**
 * What this part can do. No `steer`: a prompt submitted by a mod never joins a running turn.
 * `draft.state`: it says whether the box holds a draft, a boolean, never the text (spec 05).
 */
export const CAPABILITIES = ["send", "mail", "draft", "draft.state", "wake"] as const;
/** The ask kinds this part answers. */
export const ASK_KINDS = ["permission"] as const;

/**
 * The multiplexer marker variables, the ones Collie's hook emitter reads (Collie's
 * `bridge/beacon/env-markers.ts`). The mod reads each by a literal name, so `claude plugin validate`
 * lists them; Collie's test holds this list to the bridge's.
 */
export const MARKER_NAMES = [
  "TMUX_PANE",
  "TMUX",
  "TERN_PANE",
  "TERN_PANE_SOCKET",
  "ZELLIJ_PANE_ID",
  "ZELLIJ_SESSION_NAME",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HC_TERMINAL_ID",
  "HC_TERMINAL_SOCKET",
] as const;

/**
 * The doors whose stored rows wake Collie's chat read. The others (engine attachments, hook context,
 * notes, notices, queue records) are empty or large and never become a chat item.
 */
export const WAKE_DOORS: ReadonlySet<string> = new Set(["prompt", "command", "response", "tool-result", "delivery", "compaction"]);

/** A bridge that said "not mine" is asked again after this long, or at the next session start. */
export const NOT_MINE_RETRY_MS = 5 * 60_000;
/** A bridge that did not answer is tried again after these waits, the last one repeating. */
export const DOWN_RETRY_MS = [1000, 5000, 30_000, 60_000] as const;
/** How often the hook target folder is read again for a bridge that started later. */
export const RESCAN_MS = 60_000;
/** How long one poll asks the bridge to wait. The bridge's own limit is 25 s. */
export const POLL_WAIT_MS = 25_000;
/** The time limit of one hello or event post. A bridge that does not answer in it counts as down. */
export const REQUEST_MS = 5000;
/**
 * After a state word's post failed (no answer in time, a 429, a 5xx), the waits before it is said again,
 * then no more until the next word, the next edit of the box or the next hello (M100 spec 05). Each wait
 * is at least the second a 429 asks for, and the whole ladder ends well inside the bridge's word age.
 */
export const STATE_RETRY_MS = [1000, 5000, 15_000] as const;
/** How many command ids the mod remembers having acted on, newest kept. */
export const TAKEN_KEEP = 64;
/** The most hook target files read. A machine runs a handful of bridges. */
export const TARGETS_MAX = 32;
/** The longest draft the part reports; a longer one is reported as a failure, never cut. */
export const DRAFT_MAX = 32 * 1024;
/** The longest command text the part acts on. */
export const COMMAND_TEXT_MAX = 48 * 1024;
/** The longest wait for a permission answer, whatever a bridge asks. */
export const ASK_WAIT_MAX_MS = 15 * 60_000;

/** A hook target file's name: 16 hex characters and `.json`. */
const TARGET_FILE = /^[0-9a-f]{16}\.json$/u;
/** A part id the bridge mints. */
const PART_ID = /^[A-Za-z0-9_-]{16,64}$/u;
/** A command id. */
const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/u;
/** An ask id. */
const SHORT_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

/** A JSON value as `JSON.parse` returns it. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

/** The object a JSON text holds, or null for anything else. Never throws. */
export function objectOf(text: string): JsonRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
  } catch {
    return null;
  }
}

const stringOf = (value: Json | undefined): string | null => (typeof value === "string" ? value : null);
const numberOf = (value: Json | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// ── Finding the bridges ─────────────────────────────────────────────────────────────────────────

/** The hook target folder: `$XDG_STATE_HOME/collie/hook-targets`, else `~/.local/state/collie/hook-targets`. */
export function targetsDir(home: string | undefined, xdgStateHome: string | undefined): string | null {
  const xdg = xdgStateHome?.trim() ?? "";
  if (xdg.startsWith("/")) return `${xdg}/collie/hook-targets`;
  const base = home?.trim() ?? "";
  return base.startsWith("/") ? `${base}/.local/state/collie/hook-targets` : null;
}

/** Whether a folder entry is a hook target file. */
export function isTargetFile(name: string): boolean {
  return TARGET_FILE.test(name);
}

/** The socket a hook target file names for this wire version, or null (no wire, another version, bad file). */
export function socketOfTarget(text: string): string | null {
  const row = objectOf(text);
  if (row === null || numberOf(row.schemaVersion) !== 1) return null;
  const inside = row.inside;
  if (inside === null || inside === undefined || typeof inside !== "object" || Array.isArray(inside)) return null;
  if (numberOf(inside.wire) !== WIRE_VERSION) return null;
  const socket = stringOf(inside.socket);
  return socket !== null && socket.startsWith("/") && socket.length <= 1024 ? socket : null;
}

/**
 * The pid and its start time out of `/proc/self/stat`: field 1 and field 22. The start is read after
 * the LAST `)`, since field 2 (the program's name) may hold spaces and brackets. Null for anything else.
 */
export function selfOfStat(text: string): { pid: number; start: number } | null {
  const open = text.indexOf(" (");
  const close = text.lastIndexOf(")");
  if (open <= 0 || close < open) return null;
  const pidText = text.slice(0, open).trim();
  const fields = text.slice(close + 1).trim().split(/\s+/u);
  const startText = fields[19];
  if (!/^\d{1,10}$/u.test(pidText) || startText === undefined || !/^\d+$/u.test(startText)) return null;
  const pid = Number(pidText);
  return pid > 0 ? { pid, start: Number(startText) } : null;
}

// ── Speaking the wire ───────────────────────────────────────────────────────────────────────────

/** What a hello says, before it is written. */
export interface HelloFacts {
  readonly harnessVersion: string | null;
  readonly partVersion: string | null;
  readonly session: string | null;
  readonly cwd: string | null;
  readonly pid: number;
  readonly pidStartTime: number | null;
  readonly env: Readonly<Record<string, string>>;
}

/** The hello body. Only marker variables that hold a value go out. */
export function helloBody(facts: HelloFacts): string {
  const env: Record<string, string> = {};
  for (const name of MARKER_NAMES) {
    const value = facts.env[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return JSON.stringify({
    wire: WIRE_VERSION,
    harness: HARNESS,
    harnessVersion: facts.harnessVersion,
    partVersion: facts.partVersion,
    session: facts.session,
    cwd: facts.cwd,
    pid: facts.pid,
    pidStartTime: facts.pidStartTime,
    env,
    capabilities: CAPABILITIES,
    asks: ASK_KINDS,
  });
}

/** What a bridge said to the hello. */
export type HelloAnswer = { readonly mine: true; readonly part: string } | { readonly mine: false; readonly reason: string };

/** A hello answer, or null for a body that is not one (the bridge is then treated as down). */
export function parseHelloAnswer(status: number, text: string): HelloAnswer | null {
  if (status !== 200) return null;
  const row = objectOf(text);
  if (row === null || numberOf(row.wire) !== WIRE_VERSION) return null;
  if (row.mine === true) {
    const part = stringOf(row.part);
    return part !== null && PART_ID.test(part) ? { mine: true, part } : null;
  }
  return row.mine === false ? { mine: false, reason: stringOf(row.reason) ?? "unknown" } : null;
}

/** A command from `next`. */
export type Command =
  | { readonly id: string; readonly kind: "prompt" | "steer"; readonly text: string }
  /** `overDraft`: the person chose Deliver now, so the box is not read and the draft stays (spec 05). */
  | { readonly id: string; readonly kind: "mail"; readonly text: string; readonly overDraft?: true }
  | { readonly id: string; readonly kind: "answer"; readonly ask: string; readonly decision: "allow" | "deny" }
  | { readonly id: string; readonly kind: "draft" };

/** A command body, or null for anything that is not a well-formed command of this wire. */
export function parseCommand(text: string): Command | null {
  const row = objectOf(text);
  if (row === null || numberOf(row.wire) !== WIRE_VERSION) return null;
  const id = stringOf(row.id);
  if (id === null || !COMMAND_ID.test(id)) return null;
  const kind = stringOf(row.kind);
  if (kind === "prompt" || kind === "mail" || kind === "steer") {
    const body = stringOf(row.text);
    if (body === null || body.length === 0 || body.length > COMMAND_TEXT_MAX) return null;
    // Only a literal `true` is the person's choice; anything else is a mail a draft sends back.
    if (kind === "mail" && row.overDraft === true) return { id, kind, text: body, overDraft: true };
    return { id, kind, text: body };
  }
  if (kind === "answer") {
    const ask = stringOf(row.ask);
    const decision = stringOf(row.decision);
    if (ask === null || !SHORT_ID.test(ask)) return null;
    return decision === "allow" || decision === "deny" ? { id, kind, ask, decision } : null;
  }
  return kind === "draft" ? { id, kind } : null;
}

/** What the part does with a command. */
export type Action = { readonly do: "submit"; readonly text: string } | { readonly do: "read-draft" } | { readonly do: "refuse"; readonly reason: string };

/** The command mapping: a prompt and a mail are submitted as typed; a draft question reads the box. */
export function actionOf(command: Command): Action {
  switch (command.kind) {
    case "prompt":
    case "mail":
      return { do: "submit", text: command.text };
    case "draft":
      return { do: "read-draft" };
    case "steer":
      // Not declared: a submitted prompt waits for the turn to end, it never steers one.
      return { do: "refuse", reason: "unsupported" };
    case "answer":
      // An answer is read only by the permission hook that waits on its ask, never by the main poll.
      return { do: "refuse", reason: "unexpected" };
  }
}

/** The event a draft question is answered with: the box as it stands, or a failure past the cap. */
export function draftEvent(part: string, cmd: string, box: { readonly text: string; readonly cursor: number }): string {
  if (box.text.length > DRAFT_MAX) return JSON.stringify({ part, kind: "failed", cmd, reason: "too-long" });
  const caret = Number.isInteger(box.cursor) && box.cursor >= 0 && box.cursor <= box.text.length ? box.cursor : null;
  return JSON.stringify({ part, kind: "draft", cmd, text: box.text, caret });
}

/** The reason a `mail` is refused with when the box holds a draft: nothing was submitted (spec 05). */
export const DRAFT_REFUSAL = "draft";

/**
 * The reason of a `failed` whose submit came back with `{ drop }`. The engine's contract for that answer
 * is "the prompt did not enter" (a hook's refusal, a settings hook's block, or the engine's own), so
 * the bridge may run the screen road once for it. A rejected submit is `submit`, a fault elsewhere in
 * the handling is `error`: for those the contract promises nothing, and the bridge says it may have arrived.
 */
export const DROPPED = "dropped";

/** The longest `detail` a `failed` carries. */
export const FAIL_DETAIL_MAX = 160;

/** The window a detail is checked against the text with: no run of this many characters of the text may be in it. */
const TEXT_WINDOW = 12;

/**
 * The plain-words detail of a `failed`: an error's class and message, or a drop's reason, in one line,
 * capped at {@link FAIL_DETAIL_MAX}. Never the command's text: the line is cut where any run of
 * {@link TEXT_WINDOW} characters of it (all of a shorter text) starts, and says so. Null for nothing to say.
 */
export function failDetail(cause: unknown, text: string): string | null {
  const name = cause instanceof Error ? cause.name : typeof cause === "string" ? "" : "Error";
  const said = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  // Cut first: only the head is ever sent, and the search below must stay small inside the agent.
  // `\p{Cc}`: the control characters (C0, DEL, C1), each run made one space, then every run of space.
  const line = (name !== "" && said !== "" ? `${name}: ${said}` : name !== "" ? name : said).slice(0, FAIL_DETAIL_MAX * 2).replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim();
  if (line === "") return null;
  const at = textAt(line, text);
  if (at === -1) return line.slice(0, FAIL_DETAIL_MAX);
  const kept = line.slice(0, at).trim();
  return `${kept === "" ? "" : `${kept} `}(text not shown)`.slice(0, FAIL_DETAIL_MAX);
}

/** Where in `line` the text, or any run of {@link TEXT_WINDOW} characters of it, first starts; -1 for nowhere. */
function textAt(line: string, text: string): number {
  const body = text.trim();
  if (body === "") return -1;
  if (body.length <= TEXT_WINDOW) return line.indexOf(body);
  let first = -1;
  for (let at = 0; at + TEXT_WINDOW <= body.length; at += 1) {
    const found = line.indexOf(body.slice(at, at + TEXT_WINDOW));
    if (found !== -1 && (first === -1 || found < first)) first = found;
  }
  return first;
}

/** The `failed` event of a command, with its reason and, when there is one, its detail. */
export function failedEvent(part: string, cmd: string, reason: string, detail: string | null): string {
  return JSON.stringify(detail === null ? { part, kind: "failed", cmd, reason } : { part, kind: "failed", cmd, reason, detail });
}

/** Whether a box text is a draft: any text at all. A box of spaces is the person's too. */
export function holdsDraft(text: string): boolean {
  return text.length > 0;
}

/** The event that says whether the box holds a draft: the boolean only, never the text, and the word's count. */
export function draftStateEvent(part: string, present: boolean, seq: number): string {
  return JSON.stringify({ part, kind: "draft.state", present, seq });
}

/** The main turn as the part last saw it, with the count of the word that said so. */
export interface TurnWord {
  readonly kind: "turn.start" | "turn.end";
  readonly turn: string | null;
  /** The engine's reason for a turn end, as the engine gives it. */
  readonly reason?: unknown;
  readonly seq: number;
}

/** The event of a turn word. */
export function turnEvent(part: string, word: TurnWord): string {
  return JSON.stringify({ part, ...word });
}

/**
 * Whether a state word's post failed and is to be said again: no answer in time, a 429, a 5xx. A 410 is
 * not: the part says hello again, and the hello says every state word. Any other answer is final.
 */
export function stateLost(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

/** The ids acted on, with one more, newest kept. A list of anything else starts empty. */
export function remember(taken: unknown, id: string): string[] {
  const list = Array.isArray(taken) ? taken.filter((item): item is string => typeof item === "string") : [];
  return [...list.filter((item) => item !== id), id].slice(-TAKEN_KEEP);
}

/** Whether an id is in the remembered list. */
export function seen(taken: unknown, id: string): boolean {
  return Array.isArray(taken) && taken.includes(id);
}

/** The wake event of a stored row, or null for a row that wakes nothing (a door not listed, a subagent's row). */
export function rowEvent(part: string, door: string, row: string | undefined, agentId: string | undefined): string | null {
  if (agentId !== undefined || !WAKE_DOORS.has(door)) return null;
  const id = row !== undefined && SHORT_ID.test(row) ? row : null;
  return JSON.stringify({ part, kind: "row", door, row: id });
}

/** A turn id the wire takes, or null. */
export function turnIdOf(turn: string | undefined): string | null {
  return turn !== undefined && SHORT_ID.test(turn) ? turn : null;
}

// ── Permissions ─────────────────────────────────────────────────────────────────────────────────

/** What a bridge said to `ask.open`: wait for the phone (and how long), or do not. */
export function waitOf(status: number, text: string): number | null {
  if (status !== 200) return null;
  const row = objectOf(text);
  if (row === null || row.wait !== true) return null;
  const ms = numberOf(row.waitMs);
  return ms === null ? null : Math.max(0, Math.min(ASK_WAIT_MAX_MS, ms));
}

/**
 * The answer shape `classic.PermissionRequest` takes. The `decision` wrapper is required: a bare
 * `{ behavior }` is ignored by the engine with no error line (found in the live proof, 2026-11-13).
 */
export function answerResult(decision: "allow" | "deny"): { decision: { behavior: "allow" } } | { decision: { behavior: "deny" } } {
  // No message on a deny: the desk shows the engine's own words, and Collie adds none (decision 16).
  return decision === "allow" ? { decision: { behavior: "allow" } } : { decision: { behavior: "deny" } };
}

/**
 * What a phone answer that reached the hook does: it decides only while the desk has not (the hook's
 * signal not aborted), and the bridge is told which: `sent` when it decided, `failed` with reason
 * `desk` when the desk was first and the phone's answer did nothing.
 */
export function phoneAnswerWord(part: string, cmd: string, deskFirst: boolean): { decides: boolean; event: string } {
  return deskFirst
    ? { decides: false, event: JSON.stringify({ part, kind: "failed", cmd, reason: "desk" }) }
    : { decides: true, event: JSON.stringify({ part, kind: "sent", cmd }) };
}

/** An ask id: short, unique enough for one session. */
export function askIdOf(now: number, random: string): string {
  return `perm-${String(now)}-${random.replace(/[^A-Za-z0-9]/gu, "").slice(0, 12)}`;
}
