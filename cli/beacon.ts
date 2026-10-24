import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { BEACON_DIR_MODE, beaconFileName, beaconKey, beaconsDir, EDGE_FILE, EDGE_MAX_AGE_MS, EDGE_SPOOL_MAX, edgesDir } from "../bridge/beacon/paths.ts";
import { HOOK_TARGET_FILE, HOOK_TARGETS_MAX, hookTargetsDir, parseHookTarget } from "../bridge/beacon/hook-targets.ts";
import { edgeModelOf } from "../bridge/beacon/parse.ts";
import { parseProcStartTime, procStatPath } from "../bridge/beacon/liveness.ts";
import { HOST } from "../bridge/host.ts";
import {
  BEACON_SCHEMA_VERSION,
  EDGE_SCHEMA_VERSION,
  type BeaconMarker,
  type BeaconRecord,
  type BeaconStatus,
  type EdgeRecord,
} from "../bridge/beacon/types.ts";
import { asJsonNumber, asJsonString } from "../web/src/lib/json.ts";
import { normalizePrompt } from "../web/src/lib/surface/edges.ts";
import { holdInputHash, shownInput } from "../web/src/lib/surface/hold.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { takeContextReading, takeSessionStart } from "./context-reading.ts";
import { agentHolds, agentSettingsPath, managedSettingsPath, projectSettingsPaths } from "./hold-entry.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import type { CliContext, Environment } from "./context.ts";
import { EXIT } from "./io.ts";
import { privateDir } from "./private-dir.ts";
import type { Files } from "./sys.ts";

export { privateDir };

// `collie beacon emit` — the agent's own hook, telling Collie what only the agent knows.
//
// Claude Code runs this on five of its own events (`cli/hooks.ts` registers them) with the event
// payload as JSON on stdin. It writes ONE file: the beacon for the pane it is running in
// (`bridge/beacon/`). Nothing it writes is ever obeyed — a beacon is a hint, never a control channel
// (.adr/0024).
//
// ── TWO CLAUDE-CODE HAZARDS, AND BOTH ARE ABSOLUTE ────────────────────────────────────────────────
//
// A `UserPromptSubmit` hook's STDOUT IS INJECTED INTO THE CONVERSATION as context, and a NON-ZERO
// EXIT BLOCKS THE PROMPT. So this verb prints nothing — not to stdout, not to stderr — and returns
// `EXIT.OK` on every path there is: no multiplexer, malformed JSON, an unwritable state dir, a full
// disk. A beacon that fails to write is a beacon that is ABSENT, which the reader already handles
// honestly; an emitter that can wedge the operator's agent is worse than no emitter at all.
//
// `SessionEnd` runs on a 1.5 s default budget, which sets the shape of the work: one environment
// read, one parse, one `/proc` read for the pid's start time, one atomic write. No network, no
// subprocess, and nothing that can block on another process.
//
// ── THE PAYLOAD, AS CAPTURED (2026-08-20, `claude -p` under a throwaway CLAUDE_CONFIG_DIR) ─────────
//
//   UserPromptSubmit  session_id, transcript_path, cwd, prompt, prompt_id, permission_mode,
//                     hook_event_name
//   SessionEnd        session_id, transcript_path, cwd, prompt_id, hook_event_name,
//                     reason (observed: "other")
//
// `SessionStart` carries the same common fields — `session_id` among them (code.claude.com/docs/en/hooks.md,
// read 2026-08-25) — plus `source`, which says how the session started.
//
// `Stop` (adds `stop_hook_active`, `last_assistant_message`) and `Notification` (adds
// `notification_type`, `message`) were not reached by the headless probe — a `-p` run completes
// without either, and `idle_prompt` fires ~60 s after a response in an INTERACTIVE session only.
// Their field lists are the documented ones (code.claude.com/docs/en/hooks.md, read 2026-08-20), and
// this verb reads neither: `hook_event_name` and `session_id` are the only fields it touches, plus the
// context-reading fields below (`transcript_path`, `source`, `model`, `context_tokens`). `model` also
// rides on the `SessionStart` edge, so the pane names its model before its first turn (below).
// `agent_id` (present only for a SUBAGENT's events) was absent from every captured payload, which is
// the case the gate below is for.
//
// The probe also settled the pid question: a hook command runs as a DIRECT CHILD of the `claude`
// process — no surviving shell in between, with or without a trailing comment in the command string —
// so `process.ppid` is the agent, and the agent is what the reader's liveness check needs. The hook's
// own pid is dead microseconds later and would make every beacon read expired.

// ── THE CONTEXT READING (.adr/0115, amended 2026-10-24) ───────────────────────────────────────────
//
// Besides the beacon and the edge, this verb notes the session's context use for the dots above the
// belt, with no statusLine (`cli/context-reading.ts` has the whole rule):
//
//  - `SessionStart` reads `source`, `model` and `context_tokens`: the window the model names, a context
//    that is unknown after a compact or a clear, a context known at once after a resume or a fork.
//  - `Stop` and the tool event (`PostToolUse`, registered by `--hold-permissions`) read the END of the
//    transcript, `transcript_path` in the payload, for the token counts of the last assistant line.
//    The path is a hint to check: an absolute `.jsonl` file under the Claude config root once every
//    link is resolved. Unlike the session id below, it is never recorded in anything this verb writes.
//
// A refusal, a missing file and a full disk are all "no reading", and exit 0 as everywhere in this verb.

/** The marker namespace of a Herdr pane, which is the Herdr adapter's registry key. */
const HERDR_NAMESPACE = "herdr";

/**
 * Where a multiplexer's pane identity lives in the environment of a process running inside it.
 *
 * THE GATE IS THIS TABLE, and it is consulted BEFORE stdin is read. An agent in a plain terminal has
 * none of these variables, so it costs one process spawn and no file — which is what makes the
 * global hook install (`cli/hooks.ts`) affordable.
 *
 * `pane` is stored RAW, exactly as `BeaconMarker` requires: `%7` for tmux, a bare integer for zellij.
 * Any prefixing a multiplexer's Collie ids need (zellij's `terminal_`) belongs to that adapter's
 * matcher at the join (M11/03) — the emitter cannot know which multiplexer this Collie drives, and a
 * value rewritten here could never be un-rewritten there.
 */
interface MuxEnvMarker {
  /** The mux registry's own key (`bridge/mux/registry.ts`) — tmux, zellij. */
  readonly namespace: string;
  /** The variable holding the pane id. Its absence is what "not in this multiplexer" means. */
  readonly paneVar: string;
  /** The variable holding the addressing space — see {@link BeaconMarker.scope}. */
  readonly scopeVar: string;
  /** The scope value inside that variable, for a variable that carries more than the scope. */
  scopeOf(raw: string): string;
}

const MUX_ENV_MARKERS: readonly MuxEnvMarker[] = [
  {
    namespace: "tmux",
    paneVar: "TMUX_PANE",
    // `$TMUX` is `<socket-path>,<server-pid>,<session-index>` and only the first field is the server
    // socket — which is what `BeaconMarker.scope` is defined to hold. The server pid changes nothing
    // about which panes exist, so carrying it would make the scope differ from the one the adapter
    // addresses tmux with.
    scopeVar: "TMUX",
    scopeOf: (raw) => raw.split(",")[0] ?? raw,
  },
  {
    namespace: "tern",
    paneVar: "TERN_PANE",
    scopeVar: "TERN_PANE_SOCKET",
    scopeOf: (raw) => raw,
  },
  {
    namespace: "zellij",
    paneVar: "ZELLIJ_PANE_ID",
    // zellij pane ids are per-session integers, so the session name IS the addressing space.
    scopeVar: "ZELLIJ_SESSION_NAME",
    scopeOf: (raw) => raw,
  },
  {
    // Herdr exports its own wire id (`w54:pW`) and the socket of the server that owns the pane
    // (M56 spec 11). Herdr names its agents itself, so a Herdr marker never names a pane's agent: it
    // places the hook edges on a Herdr pane, and nothing else.
    namespace: HERDR_NAMESPACE,
    paneVar: "HERDR_PANE_ID",
    scopeVar: "HERDR_SOCKET_PATH",
    scopeOf: (raw) => raw,
  },
];

/**
 * Every multiplexer this process can see itself inside — a LIST, because nesting is real (tmux inside
 * zellij and the other way round) and the emitter cannot know which one Collie is driving.
 *
 * A namespace whose scope variable is missing is skipped rather than given a default: without the
 * addressing space, `%7` from another tmux server would join to this pane's agent.
 */
export function readEnvMarkers(env: Environment): BeaconMarker[] {
  const markers: BeaconMarker[] = [];
  for (const source of MUX_ENV_MARKERS) {
    const pane = env[source.paneVar]?.trim();
    const rawScope = env[source.scopeVar]?.trim();
    if (!pane || !rawScope) continue;
    const scope = source.scopeOf(rawScope).trim();
    if (scope === "") continue;
    markers.push({ namespace: source.namespace, scope, pane });
  }
  return markers;
}

/**
 * One Claude Code hook event, and what it says the agent is doing.
 *
 * ── THE MAP IS PASEO'S, VERBATIM (getpaseo/paseo) ─────────────────────────────────────────────────
 * Its three-state event map is the one part of paseo that transfers to a Collie that adopts panes it
 * did not spawn, and it is reproduced here row for row rather than re-derived:
 *
 *   `UserPromptSubmit` → working · `Stop` → idle · `SessionEnd` → idle ·
 *   `Notification`/`idle_prompt` → waiting
 *
 * `SessionStart` → idle is the ONE row that is ours and not paseo's, and it was earned live: four
 * Claudes sat in four zellij panes with an empty beacons directory, because none of them had been
 * asked anything yet, so Collie reported every one of them as a shell — "No agents running" over a
 * screen full of agents. A launched agent IS an agent; the first prompt is not what makes it one.
 * The row says `idle` because that is what a session with no turn in it is doing, and `idle` is the
 * word `Stop` already uses for it.
 *
 * NOTHING BRANCHES ON `source`. `SessionStart` fires on startup, on `--resume`, on `/clear`, on a
 * compaction and on a fork; all five mean "an agent sits here, idle", and none of them changes the
 * pane key — the beacon is keyed by the pane, so a later event simply overwrites the same file. It is
 * registered with no matcher for that reason: every source is the same sentence.
 *
 * THE NOTIFICATION TYPE IS THE WAITING SIGNAL, NEVER A MESSAGE STRING. `Notification` fires for
 * several notification types. Since M56 spec 11 the registration carries no matcher, so every type
 * reaches this process, and `details` below picks by `notification_type`: `idle_prompt` writes
 * `waiting`, the permission and question types write an edge only, and every other type writes
 * nothing. The message string is undocumented and nothing here parses it. A status derived from prose
 * is a status that changes when the prose does.
 */
export interface HookRegistration {
  readonly event: string;
  /** Matched against `notification_type` by Claude Code itself. Absent means "every occurrence". */
  readonly matcher?: string;
  readonly status: BeaconStatus;
  /**
   * For an event with kinds (`Notification`, by `notification_type`): the kinds this emitter speaks
   * for, each with the beacon status it writes, or null for "an edge only, no beacon". A kind not
   * listed writes nothing at all. Absent means the event has no kinds and `status` holds.
   */
  readonly details?: Readonly<Record<string, BeaconStatus | null>>;
}

export const BEACON_HOOKS: readonly HookRegistration[] = [
  // First, because it is the first moment there is an agent to name — and `session_id` is in the
  // payload from that moment, so the journal's session ref is set before the first turn exists.
  { event: "SessionStart", status: "idle" },
  { event: "UserPromptSubmit", status: "working" },
  { event: "Stop", status: "idle" },
  // `SessionEnd` carries a `reason`, and `reason: "clear"` IS NOT THE AGENT LEAVING — Codeman's
  // `/clear` finding: the operator clearing the conversation mints a NEW session id in the same pane.
  // Nothing here branches on it, because nothing has to: the beacon is keyed by the pane, so the next
  // `UserPromptSubmit` re-keys the session ref by overwriting the same file. Only `logout` /
  // `prompt_input_exit` / `other` really mean the agent is gone, and for all four the honest word
  // right now is the same one.
  { event: "SessionEnd", status: "idle" },
  // No matcher since M56 spec 11: the permission and question kinds are hook edges too (a modal is up).
  // They write an edge and no beacon. A permission prompt is not the agent waiting for its next
  // prompt, and a `waiting` there would hold the pane at "needs you" until the turn's Stop. The idle
  // kind still writes `waiting`, as before.
  {
    event: "Notification",
    status: "waiting",
    details: { idle_prompt: "waiting", permission_prompt: null, elicitation_dialog: null },
  },
];

/** The harness this emitter speaks for, in the journal registry's vocabulary. */
export const BEACON_HARNESS = "claude";

/**
 * A session id, as the journal will use it.
 *
 * Pattern-validated HERE because of what it becomes: the journal builds a path from it inside a root
 * Collie configured (.adr/0024's argument for carrying an id rather than the payload's
 * `transcript_path`). A value that never leaves this shape can never leave that root either.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** The parsed payload as an object, or null. A payload that is not an object tells us nothing. */
function asObject(value: JsonValue): JsonObject | null {
  return value instanceof Object && !Array.isArray(value) ? value : null;
}

/**
 * One field, read as text and pattern-checked.
 *
 * `String()` is total over every value `JSON.parse` can produce, and an object or an array
 * stringifies to something no pattern here accepts — so this reads a field without ever asserting
 * what type it had.
 */
function readField(row: JsonObject, key: string, accepted: RegExp): string | null {
  const raw = row[key];
  if (raw === undefined || raw === null) return null;
  // A boolean or a number is not an identifier, and `String()` would launder both into one that
  // looks like it (`false`, `12`). Rejected by value, so this still asserts nothing about the type.
  if (raw === true || raw === false || Number.isFinite(raw)) return null;
  const text = String(raw).trim();
  return accepted.test(text) ? text : null;
}

export interface BeaconEmitDeps {
  readonly ctx: CliContext;
  readonly files: Files;
  /** The hook payload. A seam so the tests need no real stdin. */
  readStdin(): Promise<string>;
  /** The agent's pid — `process.ppid` in production (see the header's probe note). */
  readonly agentPid: number;
  /** Injected so a test can pin the heartbeat; production leaves it. */
  readonly now?: () => number;
  /** This process's uid: a spool or registry folder another user owns is not written into. Absent off POSIX. */
  readonly uid?: number | undefined;
}

/**
 * The pid's start time, from the ONE extra file read this verb allows itself.
 *
 * It is not optional in the record (`BeaconRecord.pidStartTime`) and it must not be faked: a beacon
 * carrying a start time no probe will ever return reads as EXPIRED for its whole life, which would
 * present a working agent as a dead one. So an unreadable start time means NO BEACON — the reader's
 * honest answer to an absent file is already the right one. In practice that is every non-Linux host,
 * because the alternatives there are all subprocesses and `SessionEnd` has 1.5 s.
 */
export function readPidStartTime(files: Files, pid: number): number | null {
  const text = files.read(procStatPath(pid));
  return text === null ? null : parseProcStartTime(text);
}

/**
 * Write the record as one file, atomically: a temp name in the same directory, then a rename.
 *
 * The rename is what makes a torn read impossible — the reader either sees the previous beacon or
 * this one, never half of either. The temp name carries the pid so two hooks firing at once in two
 * panes cannot collide on it.
 */
function writeBeacon(deps: BeaconEmitDeps, record: BeaconRecord): void {
  const dir = beaconsDir(deps.ctx.stateDir);
  const key = beaconKey(record.markers);
  const temp = join(dir, `.${key}.${record.pid}.tmp`);
  deps.files.mkdirp(dir, BEACON_DIR_MODE);
  try {
    deps.files.write(temp, `${JSON.stringify(record)}\n`, 0o600);
    deps.files.rename(temp, join(dir, beaconFileName(key)));
  } catch (err) {
    deps.files.remove(temp);
    throw err;
  }
}

/** A tool name or a subagent id: printable ASCII, short. */
const TOOL_FIELD = /^[\x20-\x7e]{1,128}$/u;

/**
 * Whether the settings this agent reads hold Collie's permission hook right now (M56 spec 12): the
 * user file, the project's two files under the folder the hook reports (`cwd`), and the managed file.
 * Any of them can turn hooks off (`disableAllHooks`, or `allowManagedHooksOnly` in the managed one).
 * The harness reloads hooks from these files while it runs (seen 2026-10-16 on 2.1.301), so the files
 * are the truth for a running agent too. A few small reads; an unreadable file holds nothing.
 */
function holdsNow(deps: BeaconEmitDeps, event: string, cwd: string | null): boolean {
  return agentHolds(
    {
      user: deps.files.read(agentSettingsPath(deps.ctx.env, deps.ctx.home)),
      project: cwd === null ? [] : projectSettingsPaths(cwd).map((path) => deps.files.read(path)),
      managed: deps.files.read(managedSettingsPath(HOST.platform)),
    },
    event,
  );
}

/** The folder the hook reports the agent runs in, or null. */
function cwdOf(payload: JsonObject): string | null {
  const cwd = asJsonString(payload.cwd);
  return cwd !== undefined && isAbsolute(cwd) && cwd.length < 4096 ? cwd : null;
}

/** A notification type: lower case and underscores. */
const NOTIFICATION_TYPE = /^[a-z_]{1,64}$/u;

/** What the registry walk needs: the emitter and the permission hold (`collie beacon hold`) share it. */
export type EdgeTargetDeps = Pick<BeaconEmitDeps, "ctx" | "files" | "uid">;

/**
 * Write one edge file into a state dir's spool (M56 spec 11): a temp name, then a rename, so the
 * bridge never reads half of one. A spool at {@link EDGE_SPOOL_MAX} files first loses its edges older
 * than {@link EDGE_MAX_AGE_MS}, which no bridge would take anyway; still full, it takes nothing more,
 * because no bridge is taking them and a spool must not grow without end.
 */
export function writeEdge(deps: BeaconEmitDeps, stateDir: string, record: EdgeRecord): void {
  const dir = edgesDir(stateDir);
  if (deps.files.entryType(dir) === null) deps.files.mkdirp(dir, BEACON_DIR_MODE);
  if (!privateDir(deps, dir)) return;
  if (deps.files.list(dir).length >= EDGE_SPOOL_MAX) {
    for (const name of deps.files.list(dir)) {
      if (EDGE_FILE.test(name) && record.at - Number(name.split("-")[0]) > EDGE_MAX_AGE_MS) deps.files.remove(join(dir, name));
    }
    if (deps.files.list(dir).length >= EDGE_SPOOL_MAX) return;
  }
  const name = `${String(record.at)}-${String(record.pid)}-${randomBytes(4).toString("hex")}.json`;
  const temp = join(dir, `.${name}.tmp`);
  try {
    deps.files.write(temp, `${JSON.stringify(record)}\n`, 0o600);
    deps.files.rename(temp, join(dir, name));
  } catch (err) {
    deps.files.remove(temp);
    throw err;
  }
}

/**
 * The prompt as Claude Code hands it, unwrapped. A collapsed paste arrives as
 * `\n\n<pasted_content id="f27a">\n<text>\n</pasted_content id="f27a">\n` (M56 spec 01 lab, Table 5),
 * so the wrapper is cut before the hash. Only this emitter knows that form.
 */
export function unwrapPrompt(prompt: string): string {
  return prompt.replace(/<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">/gu, "$1");
}

/**
 * The salted hash of the prompt a `UserPromptSubmit` carried, or null. The salt is the send store's own
 * (`<stateDir>/sends/.salt`, bridge/surface/requests.ts), so the hash matches a send's receipt and is
 * worth nothing to a reader without it. No salt (the Send Protocol never ran) means no hash. The
 * prompt text itself is never written anywhere.
 */
export function promptHashOf(deps: BeaconEmitDeps, stateDir: string, payload: JsonObject): string | null {
  const prompt = asJsonString(payload.prompt);
  if (prompt === undefined || prompt.length === 0) return null;
  const salt = deps.files.read(join(stateDir, "sends", ".salt"))?.trim();
  if (salt === undefined || salt.length === 0) return null;
  return createHash("sha256").update(salt).update("\u0000").update(normalizePrompt(unwrapPrompt(prompt))).digest("hex");
}

/**
 * The state dirs an edge goes to (M56 spec 11, bridge/beacon/hook-targets.ts): every bridge in the
 * hook target registry whose pid still runs as the same process. A dead target's file is deleted. An
 * explicit `COLLIE_STATE_DIR` in the agent's environment is always one of them. With no live target
 * the edge goes to this emitter's own state dir, as it did before the registry.
 */
export function edgeStateDirs(deps: EdgeTargetDeps): string[] {
  const dirs: string[] = [];
  const registry = hookTargetsDir(deps.ctx.env, deps.ctx.home);
  if (privateDir(deps, registry)) {
    for (const name of deps.files.list(registry).filter((entry) => HOOK_TARGET_FILE.test(entry)).slice(0, HOOK_TARGETS_MAX)) {
      const path = join(registry, name);
      const target = parseHookTarget(deps.files.read(path) ?? "");
      if (target === null) continue;
      const start = readPidStartTime(deps.files, target.pid);
      if (start === null || (target.pidStartTime !== null && start !== target.pidStartTime)) {
        deps.files.remove(path);
        continue;
      }
      dirs.push(target.stateDir);
    }
  }
  if ((deps.ctx.env.COLLIE_STATE_DIR ?? "").trim() !== "" || dirs.length === 0) dirs.push(deps.ctx.stateDir);
  return [...new Set(dirs.map((dir) => deps.files.realpath(dir) ?? dir))];
}

/** True when every marker is a Herdr one: Herdr names its agents itself, so no beacon is written. */
function herdrOnly(markers: readonly BeaconMarker[]): boolean {
  return markers.every((marker) => marker.namespace === HERDR_NAMESPACE);
}

/** The session's context use from its transcript, if the payload names a session and a transcript. Never throws. */
function takeReading(deps: BeaconEmitDeps, payload: JsonObject, stateDirs: () => string[]): void {
  const session = readField(payload, "session_id", SESSION_ID);
  if (session === null) return;
  takeContextReading(deps, { session, transcriptPath: asJsonString(payload.transcript_path), harness: BEACON_HARNESS }, stateDirs, (deps.now ?? Date.now)());
}

/** What a `SessionStart` says about the window and the context. Never throws. */
function takeStart(deps: BeaconEmitDeps, payload: JsonObject, stateDirs: () => string[]): void {
  const session = readField(payload, "session_id", SESSION_ID);
  if (session === null) return;
  takeSessionStart(
    deps,
    { session, harness: BEACON_HARNESS, source: asJsonString(payload.source), model: asJsonString(payload.model), contextTokens: asJsonNumber(payload.context_tokens) },
    stateDirs,
    (deps.now ?? Date.now)(),
  );
}

/**
 * `collie beacon emit` — one hook event in, at most one beacon file out.
 *
 * ALWAYS RETURNS `EXIT.OK`, and the header says why. The gate order is the requirement: the
 * environment is checked BEFORE stdin is read or parsed, so an agent outside a multiplexer does the
 * least work there is.
 */
export async function cmdBeaconEmit(deps: BeaconEmitDeps): Promise<number> {
  try {
    const markers = readEnvMarkers(deps.ctx.env);
    // Not in a multiplexer Collie can join a beacon to: nothing to say, and nothing read.
    if (markers.length === 0) return EXIT.OK;

    const payload = asObject(JSON.parse(await deps.readStdin()));
    if (payload === null) return EXIT.OK;

    // The tool edge (M56 spec 12): a tool finished. It ends a "Sent" card of a hook-held permission,
    // so it is written for a subagent too, with the subagent id and the tool name, and never a beacon.
    const hold = loadProfiles().get(BEACON_HARNESS)?.hold;
    // The registry walk happens at most once per run, and only when something is to be written.
    let targets: string[] | undefined;
    const stateDirs = (): string[] => (targets ??= edgeStateDirs(deps));
    if (hold !== undefined && payload.hook_event_name === hold.toolEvent) {
      // The context use, before the edge: it needs no pid. A subagent's tool call is not the session's turn.
      if (payload.agent_id === undefined || payload.agent_id === null) takeReading(deps, payload, stateDirs);
      const pidStartTime = readPidStartTime(deps.files, deps.agentPid);
      if (pidStartTime === null) return EXIT.OK;
      const tool = readField(payload, "tool_name", TOOL_FIELD);
      const agent = readField(payload, "agent_id", TOOL_FIELD);
      let record: EdgeRecord = {
        schemaVersion: EDGE_SCHEMA_VERSION,
        harness: BEACON_HARNESS,
        event: hold.toolEvent,
        detail: null,
        pid: deps.agentPid,
        pidStartTime,
        markers,
        at: (deps.now ?? Date.now)(),
        promptHash: null,
        holds: holdsNow(deps, hold.event, cwdOf(payload)),
      };
      if (tool !== null) record = { ...record, tool };
      if (agent !== null) record = { ...record, agent };
      // The input shown, hashed as the hold hashed it: the bridge ends only the hold of this very call.
      if (tool !== null) record = { ...record, inputHash: holdInputHash(tool, shownInput(payload.tool_input, hold.inputShown, hold.inputDetails[tool])) };
      for (const stateDir of stateDirs()) {
        try {
          writeEdge(deps, stateDir, record);
        } catch {
          // No tool edge for this target. A Sent card there ends when the screen moves on.
        }
      }
      return EXIT.OK;
    }

    // A SUBAGENT IS NOT THE PANE. A payload carrying `agent_id` came from a Task running inside the
    // session, and its `session_id` is not the pane's identity — writing it would hand the pane a
    // conversation the operator cannot see in it.
    if (payload.agent_id !== undefined && payload.agent_id !== null) return EXIT.OK;

    const event = payload.hook_event_name;
    const registration = BEACON_HOOKS.find((row) => row.event === event);
    if (registration === undefined) return EXIT.OK;
    // An event with kinds speaks only for the kinds it lists. `undefined` here is "not ours".
    const detail = registration.details === undefined ? null : readField(payload, "notification_type", NOTIFICATION_TYPE);
    const status = registration.details === undefined ? registration.status : detail === null ? undefined : registration.details[detail];
    if (status === undefined) return EXIT.OK;

    if (registration.event === "Stop") takeReading(deps, payload, stateDirs);
    if (registration.event === "SessionStart") takeStart(deps, payload, stateDirs);

    const pidStartTime = readPidStartTime(deps.files, deps.agentPid);
    if (pidStartTime === null) return EXIT.OK;
    const now = (deps.now ?? Date.now)();

    // The edges first, each in its own guard: a beacon that cannot be written must not cost an edge,
    // one target that cannot be written must not cost the others, and the other way round.
    const holds = hold === undefined ? false : holdsNow(deps, hold.event, cwdOf(payload));
    // The start's model rides on its edge, so the pane names its model before the transcript holds a
    // turn: Claude Code writes no transcript until the first message or local command (seen on
    // 2.1.310). Bounded and raw; a name that is not one adds no field and still writes the edge.
    const model = registration.event === "SessionStart" ? edgeModelOf(payload.model) : null;
    for (const stateDir of stateDirs()) {
      try {
        const record: EdgeRecord = {
          schemaVersion: EDGE_SCHEMA_VERSION,
          harness: BEACON_HARNESS,
          event: registration.event,
          detail,
          pid: deps.agentPid,
          pidStartTime,
          markers,
          at: now,
          promptHash: promptHashOf(deps, stateDir, payload),
          holds,
        };
        writeEdge(deps, stateDir, model === null ? record : { ...record, model });
      } catch {
        // No edge for this target. The screen still reads the pane on its own poll.
      }
    }

    // A Herdr pane gets edges only: Herdr names the agent and its session on its own wire.
    if (status === null || herdrOnly(markers)) return EXIT.OK;
    const session = readField(payload, "session_id", SESSION_ID);
    if (session === null) return EXIT.OK;

    writeBeacon(deps, {
      schemaVersion: BEACON_SCHEMA_VERSION,
      harness: BEACON_HARNESS,
      session: { kind: "id", value: session },
      status,
      pid: deps.agentPid,
      pidStartTime,
      markers,
      heartbeatMs: now,
    });
    return EXIT.OK;
  } catch {
    // Every failure is the same failure: there is no beacon for this pane right now.
    return EXIT.OK;
  }
}

/**
 * The verb, with its dependency construction inside the same guarantee.
 *
 * Resolving the context can itself throw (a `COLLIE_INSTANCE` with no port), and a throw out of the
 * verb table is an exit code and a line on stderr — the two things this emitter may never produce.
 */
export async function runBeaconEmit(build: () => BeaconEmitDeps): Promise<number> {
  try {
    return await cmdBeaconEmit(build());
  } catch {
    return EXIT.OK;
  }
}
