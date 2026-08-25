import { join } from "node:path";

import { BEACON_DIR_MODE, beaconFileName, beaconKey, beaconsDir } from "../bridge/beacon/paths.ts";
import { parseProcStartTime, procStatPath } from "../bridge/beacon/liveness.ts";
import {
  BEACON_SCHEMA_VERSION,
  type BeaconMarker,
  type BeaconRecord,
  type BeaconStatus,
} from "../bridge/beacon/types.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import type { CliContext, Environment } from "./context.ts";
import { EXIT } from "./io.ts";
import type { Files } from "./sys.ts";

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
// this verb reads neither: `hook_event_name` and `session_id` are the only fields it touches.
// `agent_id` (present only for a SUBAGENT's events) was absent from every captured payload, which is
// the case the gate below is for.
//
// The probe also settled the pid question: a hook command runs as a DIRECT CHILD of the `claude`
// process — no surviving shell in between, with or without a trailing comment in the command string —
// so `process.ppid` is the agent, and the agent is what the reader's liveness check needs. The hook's
// own pid is dead microseconds later and would make every beacon read expired.

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
    namespace: "zellij",
    paneVar: "ZELLIJ_PANE_ID",
    // zellij pane ids are per-session integers, so the session name IS the addressing space.
    scopeVar: "ZELLIJ_SESSION_NAME",
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
 * THE MATCHER IS THE WAITING SIGNAL, NEVER A MESSAGE STRING. `Notification` fires for several
 * notification types; the registration in `cli/hooks.ts` carries `matcher: "idle_prompt"`, so the
 * only `Notification` payloads that reach this process are the idle ones. The `idle_prompt` message
 * string is undocumented and nothing here parses it — a status derived from prose is a status that
 * changes when the prose does.
 */
export interface HookRegistration {
  readonly event: string;
  /** Matched against `notification_type` by Claude Code itself. Absent means "every occurrence". */
  readonly matcher?: string;
  readonly status: BeaconStatus;
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
  { event: "Notification", matcher: "idle_prompt", status: "waiting" },
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
function readPidStartTime(files: Files, pid: number): number | null {
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

    // A SUBAGENT IS NOT THE PANE. A payload carrying `agent_id` came from a Task running inside the
    // session, and its `session_id` is not the pane's identity — writing it would hand the pane a
    // conversation the operator cannot see in it.
    if (payload.agent_id !== undefined && payload.agent_id !== null) return EXIT.OK;

    const event = payload.hook_event_name;
    const registration = BEACON_HOOKS.find((row) => row.event === event);
    if (registration === undefined) return EXIT.OK;

    const session = readField(payload, "session_id", SESSION_ID);
    if (session === null) return EXIT.OK;

    const pidStartTime = readPidStartTime(deps.files, deps.agentPid);
    if (pidStartTime === null) return EXIT.OK;

    writeBeacon(deps, {
      schemaVersion: BEACON_SCHEMA_VERSION,
      harness: BEACON_HARNESS,
      session: { kind: "id", value: session },
      status: registration.status,
      pid: deps.agentPid,
      pidStartTime,
      markers,
      heartbeatMs: (deps.now ?? Date.now)(),
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
