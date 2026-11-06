import { edgeModelOf } from "../bridge/beacon/parse.ts";
import { BEACON_SCHEMA_VERSION, EDGE_SCHEMA_VERSION, type BeaconRecord, type BeaconStatus, type EdgeRecord } from "../bridge/beacon/types.ts";
import type { JsonObject } from "../bridge/json.ts";
import { asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import {
  agentPidOf,
  edgeStateDirs,
  herdrOnly,
  promptHashOf,
  readEnvMarkers,
  readPidStartTime,
  sessionIdOf,
  writeBeacon,
  writeEdge,
  type BeaconEmitDeps,
  type ProcessInfo,
} from "./beacon.ts";
import { isCodexTui } from "./codex-notify.ts";
import { EXIT } from "./io.ts";

// `collie beacon codex-hook`: the command every native Codex hook runs (`collie hooks install codex
// --native`, cli/codex-native.ts). It is the Codex twin of `collie beacon emit`, and it exists for one
// reason: herdr-core knows that a terminal runs Codex but not which conversation, so without it a
// Codex pane there has no Chat and no History (M74 spec 04 is the same gap for Claude).
//
// Codex runs it on four of its own events with the event as JSON on stdin. It writes a hook edge for
// the pane, and, outside the Herdr TUI, the beacon that names the pane's Codex session. The journal
// reads that session by id: Codex's `session_id` is the rollout id, the same id `bridge/journal/codex.ts`
// keys a session file by.
//
// ── THE SAME TWO PROMISES AS `beacon emit` ────────────────────────────────────────────────────────
//
// A hook's stdout reaches Codex as context or as a decision, and a non-zero exit is a decision too
// (exit 2 on UserPromptSubmit blocks the prompt). So this verb prints nothing and returns `EXIT.OK` on
// every path. A beacon that cannot be written is absent, and the reader handles absence honestly.
//
// It is a sub-verb of `beacon` for the same reason: `collie beacon <anything>` has answered with
// silence and exit 0 since 1.0.0, so a Collie rolled back to a build without this verb still does
// nothing to the operator's Codex. A verb of its own would print a usage error and exit 2 there.
//
// ── WHICH PROCESS, AND WHY THE DAEMON IS REFUSED ──────────────────────────────────────────────────
//
// The beacon names a pane by the multiplexer markers in this process's environment, and a process by
// its pid and start time (the reader's liveness check). Both must be the pane's own Codex.
//
//  - `codex --no-daemon` runs a hook as a child of the Codex window itself, with the window's own
//    environment (probed 2026-11-06, Codex 0.167.0 on hc 0.1.16): `HC_TERMINAL_ID` and
//    `HC_TERMINAL_SOCKET` are that terminal's. The parent, past any shell, is the window.
//  - Plain `codex` runs its sessions in a shared `codex app-server` daemon, and the daemon runs the
//    hooks with ITS environment: the markers of whichever pane started it, or none. A beacon from
//    there would hand one pane another pane's conversation. So the host must be a Codex window by its
//    own arguments (`isCodexTui`: the program `codex`, no `app-server`, no `exec`), and anything else
//    writes nothing at all, edge included.
//
// The climb past a shell is `agentPidOf`'s, shared with `beacon emit` (issue 689). The arguments come
// from `/proc/<pid>/cmdline` on Linux and one `ps` run on macOS (`readProcessArgs`).
//
// ── WHAT THE PROBE ALSO SETTLED ───────────────────────────────────────────────────────────────────
//
// A sub-agent (multi_agent) fired no hook at all, only the main thread did. A payload naming
// `agent_id` is still refused, as `beacon emit` refuses one, so a later Codex that does fire them
// cannot hand the pane a sub-agent's session. After `/new` nothing fires until the next prompt; then
// SessionStart fires with the new id. The beacon is keyed by the pane, so it follows `/new` there.

/** The harness this verb speaks for, in the journal registry's vocabulary. */
export const CODEX_HOOK_HARNESS = "codex";

/**
 * One Codex hook event: the beacon status it writes, and the seconds `hooks.json` gives the command.
 *
 * The statuses are the Claude emitter's (`BEACON_HOOKS` in cli/beacon.ts). SessionEnd's timeout is
 * short because Codex allows that event only a few seconds; the work is a few small file writes.
 */
export interface CodexHookEvent {
  readonly event: string;
  readonly status: BeaconStatus;
  readonly timeout: number;
}

export const CODEX_HOOK_EVENTS: readonly CodexHookEvent[] = [
  { event: "SessionStart", status: "idle", timeout: 10 },
  { event: "UserPromptSubmit", status: "working", timeout: 10 },
  { event: "Stop", status: "idle", timeout: 10 },
  { event: "SessionEnd", status: "idle", timeout: 3 },
];

export interface CodexHookDeps extends Omit<BeaconEmitDeps, "agentPid"> {
  /** This process's parent (`process.ppid`): the Codex window, a shell under it, or the daemon. */
  readonly parentPid: number;
  /** One process's name and parent. Production: `readProcessInfo` (cli/beacon.ts). */
  readProcess(pid: number): ProcessInfo | null;
  /** One process's arguments. Production: `readProcessArgs` (cli/beacon.ts). */
  readArgs(pid: number): readonly string[] | null;
}

/**
 * The Codex window this hook runs under, or null. The parent is climbed past any shell, then its
 * arguments must name a Codex window: a daemon, a `codex exec` run, an unreadable process or anything
 * else is null, and null writes nothing.
 */
export function codexHostOf(deps: Pick<CodexHookDeps, "parentPid" | "readProcess" | "readArgs">): number | null {
  const pid = agentPidOf(deps.parentPid, (at) => deps.readProcess(at));
  const args = deps.readArgs(pid);
  return args !== null && isCodexTui(args) ? pid : null;
}

/** Whether the Codex profile maps this event to an edge. Unmapped, it would be a bare reread, so none is written. */
function profileMaps(event: string): boolean {
  return loadProfiles().get(CODEX_HOOK_HARNESS)?.hooks[event] === "edge";
}

/**
 * `collie beacon codex-hook`: one Codex hook event in, at most one edge and one beacon per bridge out.
 *
 * The gate order is the cost order: the environment before stdin (a Codex outside every multiplexer
 * reads nothing), the payload before any process is probed, and the host before anything is written.
 */
export async function cmdCodexHook(deps: CodexHookDeps): Promise<number> {
  try {
    const markers = readEnvMarkers(deps.ctx.env);
    if (markers.length === 0) return EXIT.OK;

    const payload = parseJsonObject(await deps.readStdin());
    if (payload === undefined) return EXIT.OK;
    const row = CODEX_HOOK_EVENTS.find((candidate) => candidate.event === asJsonString(payload.hook_event_name));
    if (row === undefined) return EXIT.OK;
    // A SUB-AGENT IS NOT THE PANE (see the header).
    if (payload.agent_id !== undefined && payload.agent_id !== null) return EXIT.OK;

    const host = codexHostOf(deps);
    if (host === null) return EXIT.OK;
    const pidStartTime = readPidStartTime(deps, host);
    if (pidStartTime === null) return EXIT.OK;

    const emit: BeaconEmitDeps = { ...deps, agentPid: host };
    const now = (deps.now ?? Date.now)();
    let targets: string[] | undefined;
    const stateDirs = (): string[] => (targets ??= edgeStateDirs(emit));

    if (profileMaps(row.event)) {
      const record: EdgeRecord = { schemaVersion: EDGE_SCHEMA_VERSION, harness: CODEX_HOOK_HARNESS, event: row.event, detail: null, pid: host, pidStartTime, markers, at: now, promptHash: null };
      // The start's model rides on its edge, as Claude's does: the pane names it before the first turn.
      const model = row.event === "SessionStart" ? edgeModelOf(payload.model) : null;
      writeEdges(emit, stateDirs(), model === null ? record : { ...record, model }, payload);
    }

    // A Herdr TUI pane gets edges only: Herdr names the agent and its session on its own wire.
    if (herdrOnly(markers)) return EXIT.OK;
    const session = sessionIdOf(payload);
    if (session === null) return EXIT.OK;
    const beacon: BeaconRecord = {
      schemaVersion: BEACON_SCHEMA_VERSION,
      harness: CODEX_HOOK_HARNESS,
      session: { kind: "id", value: session },
      status: row.status,
      pid: host,
      pidStartTime,
      markers,
      heartbeatMs: now,
    };
    for (const stateDir of stateDirs()) {
      try {
        writeBeacon(emit, stateDir, beacon);
      } catch {
        // No beacon for this target. Its pane reads as having no session until the next event.
      }
    }
    return EXIT.OK;
  } catch {
    // Every failure is the same failure: there is no beacon for this pane right now.
    return EXIT.OK;
  }
}

/**
 * One edge per state dir, each in its own guard. A prompt edge carries the prompt's hash, salted with
 * that bridge's send store, so a send from the phone can read as Confirmed. The prompt is never written.
 */
function writeEdges(deps: BeaconEmitDeps, stateDirs: readonly string[], record: EdgeRecord, payload: JsonObject): void {
  for (const stateDir of stateDirs) {
    try {
      const promptHash = record.event === "UserPromptSubmit" ? promptHashOf(deps, stateDir, payload) : null;
      writeEdge(deps, stateDir, { ...record, promptHash });
    } catch {
      // No edge for this target. The screen still reads the pane on its own poll.
    }
  }
}

/** The verb, with its dependency construction inside the same promise: silent, and exit 0. */
export async function runCodexHook(build: () => CodexHookDeps): Promise<number> {
  try {
    return await cmdCodexHook(build());
  } catch {
    return EXIT.OK;
  }
}
